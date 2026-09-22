/**
 * A soft afternoon nudge for somebody who usually logs water and has not today.
 *
 * **This is a nudge, not a reminder, and every rule below exists to keep it that way.** A
 * dose reminder is a promise the person asked for; nobody asked for this. So it has to earn
 * its place on the lock screen every single time, and the cost of getting that wrong is the
 * whole notification channel switched off — dose reminders included, since `hydration`
 * rides the master switch.
 *
 * Six rules:
 *
 *   1. **Only for people who already track water.** At least `MIN_RECENT_DAYS` distinct
 *      logged days in the last `LOOKBACK_DAYS`. Somebody who has never logged a glass has
 *      not taken the feature up, and a push is the wrong way to introduce it — the home
 *      screen's "Get more from Miovix" row already does that without interrupting anyone.
 *   2. **At 14:00 in the person's own clock**, within a `WINDOW_MINUTES` grace so a restart
 *      does not skip a day, and never later. Early afternoon because: by then a day with
 *      no logs is a real signal rather than "not up yet"; it is the post-lunch dip, when a
 *      missed glass is most likely to be felt as tiredness; there is still most of the day
 *      left to act on it; and it is well clear of the evening, when drinking to catch up
 *      costs a night's sleep. It also stays away from the 09:00 plan sweep, so two
 *      unrelated pushes never land together.
 *   3. **No known clock, no nudge.** The phone reports its offset when it registers for push
 *      (`pushTokens[].tzOffset`). Guessing UTC would send "a 2pm check-in" at 3am in the
 *      Pacific, which is the exact failure this file is written against.
 *   4. **Once a day at most**, keyed `hydration:<local day>`.
 *   5. **It backs off.** After `MAX_UNANSWERED` nudges with no drink logged since, it goes
 *      quiet until the person logs again. Somebody who has stopped tracking has told us so
 *      by stopping; a daily push about it would be nagging.
 *   6. **No numbers and no verdicts in the copy.** No target, no millilitres, never
 *      "dehydrated". A figure turns a nudge into a quota, and "no drinks logged" is a fact
 *      about the log, not about the person — they may simply not have tapped it. Every
 *      variant says tea and coffee count or that logging is quick, because the likeliest
 *      truth is that they drank and did not log it. (Coffee and tea count in full — see
 *      `utils/hydrationTargets.js`.)
 *
 * Quiet hours and the master switch are `notificationCentre.publish`'s to apply, so this
 * publishes with the default `push: true` and passes the person's offset. A default quiet
 * window never contains 14:00; a custom one that does is honoured and the card still lands
 * in the inbox.
 */
const MetricLog = require('../models/MetricLog');
const Notification = require('../models/Notification');
const User = require('../models/userModel');
const { publish } = require('../utils/notificationCentre');

/** How often the sweep runs. Fine enough that the 14:00 target lands within a quarter hour. */
const INTERVAL_MS = 15 * 60 * 1000;

/** The local minute of the day the nudge is meant for. */
const NUDGE_AT_MINUTES = 14 * 60;

/** How late it may still go out. Past this, today is written off rather than sent at dusk. */
const WINDOW_MINUTES = 120;

/** How far back "somebody who tracks water" looks. */
const LOOKBACK_DAYS = 14;

/** Distinct logged days inside the lookback that make somebody a person who tracks water. */
const MIN_RECENT_DAYS = 2;

/** Nudges with no drink logged since, after which it stops until they log again. */
const MAX_UNANSWERED = 3;

const DAY_MS = 86_400_000;

/** Where a tap on the push lands: the log screen, because the copy promises seconds. */
const LOG_ROUTE = '/metrics/log/water';
const HYDRATION_ROUTE = '/metrics/water';

/**
 * The wording, rotated by day so it does not read as a machine repeating itself.
 *
 * Every body carries the benefit, the fact about the log, and how little it takes — in
 * that order, because the benefit is what makes it worth reading and the ease is what
 * makes it worth doing.
 */
const MESSAGES = [
    {
        title: 'A little water break?',
        body: 'A glass now can help keep your energy and focus steady through the afternoon. No drinks logged yet today — adding one takes a few seconds.',
    },
    {
        title: 'Time for a sip',
        body: 'Staying hydrated supports your energy, concentration and digestion. Nothing logged yet today — if you have had something already, tap to add it.',
    },
    {
        title: 'A gentle hydration check-in',
        body: 'Afternoons are when a missed glass tends to show up as tiredness. No drinks logged yet today — tea and coffee count too, and logging takes seconds.',
    },
    {
        title: 'Your water, whenever you are ready',
        body: 'Small sips through the day are easier on you than catching up tonight. No drinks logged yet today — one tap and a few seconds is all it takes.',
    },
];

/** The same local-clock arithmetic `sleepReminderJob` uses: `tzOffset` is minutes west of UTC. */
const localNow = (now, tzOffset) => {
    const shifted = new Date(now.getTime() - tzOffset * 60_000);
    return {
        day: shifted.toISOString().slice(0, 10),
        minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    };
};

const shiftDay = (day, delta) =>
    new Date(Date.parse(`${day}T00:00:00.000Z`) + delta * DAY_MS).toISOString().slice(0, 10);

/**
 * The person's offset, from the device that registered most recently — the one most likely
 * to be in their hand, and the one whose clock was read last. `null` when no device has
 * reported one, which rule 3 treats as "do not send".
 */
const offsetFor = (user) => {
    const withClock = (user.pushTokens || [])
        .filter((t) => Number.isFinite(t.tzOffset))
        .sort((a, b) => new Date(b.registeredAt || 0) - new Date(a.registeredAt || 0));
    return withClock.length ? withClock[0].tzOffset : null;
};

/** Deterministic per day, so a re-run of the same day composes the same card. */
const messageFor = (day) => {
    const n = [...day].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
    return MESSAGES[n % MESSAGES.length];
};

/**
 * One sweep. Exported so a test can run it without waiting on a timer.
 *
 * @returns {Promise<{considered:number, nudged:number, skipped:Record<string, number>}>}
 */
const runHydrationNudges = async (now = new Date()) => {
    const skipped = { no_clock: 0, not_now: 0, logged_today: 0, not_tracking: 0, already_nudged: 0, backed_off: 0 };

    // A day of slack either side of the lookback: `day` is local and `measuredAt` is not.
    const since = new Date(now.getTime() - (LOOKBACK_DAYS + 1) * DAY_MS);
    const trackers = await MetricLog.aggregate([
        { $match: { kind: 'water', measuredAt: { $gte: since } } },
        { $group: { _id: '$userId', days: { $addToSet: '$day' }, lastAt: { $max: '$measuredAt' } } },
    ]);

    if (!trackers.length) return { considered: 0, nudged: 0, skipped };

    const users = await User.find({ _id: { $in: trackers.map((t) => t._id) } })
        .select('pushTokens notificationPreferences')
        .lean();
    const userById = new Map(users.map((u) => [String(u._id), u]));

    let nudged = 0;

    for (const tracker of trackers) {
        const user = userById.get(String(tracker._id));
        if (!user) continue;

        const tzOffset = offsetFor(user);
        if (tzOffset === null) { skipped.no_clock += 1; continue; }

        const { day, minutes } = localNow(now, tzOffset);
        const late = minutes - NUDGE_AT_MINUTES;
        if (late < 0 || late > WINDOW_MINUTES) { skipped.not_now += 1; continue; }

        if (tracker.days.includes(day)) { skipped.logged_today += 1; continue; }

        const earliest = shiftDay(day, -LOOKBACK_DAYS);
        const recent = tracker.days.filter((d) => d >= earliest && d < day);
        if (recent.length < MIN_RECENT_DAYS) { skipped.not_tracking += 1; continue; }

        const dedupeKey = `hydration:${day}`;
        if (await Notification.exists({ userId: user._id, dedupeKey })) {
            skipped.already_nudged += 1;
            continue;
        }

        // Rule 5. Nudges only go out on days with no log, so any sent since the last drink
        // went unanswered.
        const unanswered = await Notification.countDocuments({
            userId: user._id,
            source: 'hydrationNudgeJob',
            createdAt: { $gt: tracker.lastAt },
        });
        if (unanswered >= MAX_UNANSWERED) { skipped.backed_off += 1; continue; }

        const { title, body } = messageFor(day);
        const { notification } = await publish(String(user._id), {
            category: 'hydration',
            title,
            body,
            route: LOG_ROUTE,
            source: 'hydrationNudgeJob',
            dedupeKey,
            actions: [
                { label: 'Log a drink', route: LOG_ROUTE, tone: 'primary' },
                { label: 'Hydration', route: HYDRATION_ROUTE, tone: 'secondary' },
            ],
            data: { type: 'hydration_nudge', day },
        }, { user, tzOffsetMinutes: tzOffset });

        if (notification) nudged += 1;
    }

    if (nudged) console.log(`💧 Hydration nudges: ${nudged} cards written`);

    return { considered: trackers.length, nudged, skipped };
};

const scheduleHydrationNudges = () => {
    setInterval(() => {
        runHydrationNudges().catch((err) => console.error('❌ Hydration nudge sweep failed:', err));
    }, INTERVAL_MS).unref?.();

    console.log(`💧 Hydration nudges scheduled every ${INTERVAL_MS / 60000} minutes (14:00 local)`);
};

module.exports = {
    scheduleHydrationNudges,
    runHydrationNudges,
    MESSAGES,
    _offsetFor: offsetFor,
    _messageFor: messageFor,
    _MAX_UNANSWERED: MAX_UNANSWERED,
};
