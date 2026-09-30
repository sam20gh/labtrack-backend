/**
 * Period reminders: one a couple of days before the predicted window, one once the period is
 * past it, and one more a week after that.
 *
 * Five rules:
 *
 *   1. **Only for somebody who switched the tracker on**, and only for the reminders they left
 *      on. Nothing here goes to a person because of what their profile says their gender is.
 *   2. **At 09:00 in the person's own clock**, from `pushTokens[].tzOffset`, within a grace
 *      window so a restart does not skip a day. No known clock, no reminder: a guessed UTC
 *      puts a period reminder on somebody's lock screen at 2am.
 *   3. **Once per predicted period per kind**, keyed on the expected date. A late reminder is
 *      not repeated daily; being told every morning that your period has not come is the
 *      thing that makes people delete a tracker.
 *   4. **Discreet on the lock screen by default.** The card in the inbox carries the detail;
 *      the push says "A reminder from Predyqt" unless the person turned that off. A lock screen
 *      is read by whoever is next to the phone.
 *   5. **The late copy names the ordinary causes, pregnancy among them, and never alarms.**
 *      Nothing here is a vital sign; `cycle` is a `normal`-priority category and respects
 *      quiet hours. No condition is named.
 *
 * Paused plans (pregnancy, breastfeeding) get nothing, and neither does a forecast with no
 * prediction behind it.
 */
const CyclePlan = require('../models/CyclePlan');
const CycleDay = require('../models/CycleDay');
const User = require('../models/userModel');
const Notification = require('../models/Notification');
const { publish } = require('../utils/notificationCentre');
const { mergeDays, addDays, localDay } = require('../utils/cycleEngine');
const { forecast } = require('../utils/cycleForecast');

const INTERVAL_MS = 15 * 60 * 1000;
const SEND_AT_MINUTES = 9 * 60;
const WINDOW_MINUTES = 120;

/** "Soon" means the window opens within this many days. */
const SOON_DAYS = 2;

const LOOKBACK_DAYS = 400;

const COVER = { title: 'A reminder from Predyqt', body: 'Tap to open your tracker.' };

const localNow = (now, tzOffset) => {
    const shifted = new Date(now.getTime() - tzOffset * 60_000);
    return {
        day: shifted.toISOString().slice(0, 10),
        minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    };
};

const offsetFor = (user) => {
    const withClock = (user.pushTokens || [])
        .filter((t) => Number.isFinite(t.tzOffset))
        .sort((a, b) => new Date(b.registeredAt || 0) - new Date(a.registeredAt || 0));
    return withClock.length ? withClock[0].tzOffset : null;
};

/** "12 Oct". A date, never a weekday: the weekday adds nothing and is one more thing to get wrong. */
const shortDate = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', timeZone: 'UTC',
});

/**
 * The card for a reading, or null when there is nothing to say today.
 * Pure, so the copy rules can be tested without a database.
 */
const messageFor = (reading, plan) => {
    const p = reading.prediction;
    if (!p) return null;
    const expected = shortDate(p.expected);

    if (reading.state === 'upcoming' && plan.reminders?.periodSoon !== false
        && reading.daysUntil?.from >= 0 && reading.daysUntil.from <= SOON_DAYS) {
        return {
            kind: 'soon',
            title: 'Your period may start soon',
            body: `Based on ${p.source === 'observed' ? 'your recent cycles' : 'what you told us at setup'}, `
                + `it is likely between ${shortDate(p.window.from)} and ${shortDate(p.window.to)}.`,
            actions: [{ label: 'Open tracker', route: '/cycle', tone: 'primary' }],
        };
    }
    if (reading.state === 'late' && plan.reminders?.late !== false) {
        return {
            kind: 'late',
            title: 'Your period is a few days late',
            body: `It was expected around ${expected}. Stress, illness, travel, changes in weight or exercise, `
                + 'and pregnancy can all delay a period. If you could be pregnant, a test is the quickest way to know.',
            actions: [{ label: 'Log my period', route: '/cycle', tone: 'primary' }],
        };
    }
    if (reading.state === 'very_late' && plan.reminders?.late !== false) {
        return {
            kind: 'very_late',
            title: 'Your period is over a week late',
            body: `It was expected around ${expected}. Log it when it starts. If you could be pregnant, a test is `
                + 'the quickest way to know, and if late periods keep happening, mention it to a doctor.',
            actions: [{ label: 'Log my period', route: '/cycle', tone: 'primary' }],
        };
    }
    return null;
};

/** One sweep. Exported so a test can run it without a timer. */
const runCycleReminders = async (now = new Date()) => {
    const skipped = { no_clock: 0, not_now: 0, nothing_due: 0, already_sent: 0 };
    const plans = await CyclePlan.find({ enabled: true }).lean();
    if (!plans.length) return { considered: 0, sent: 0, skipped };

    const users = await User.find({ _id: { $in: plans.map((p) => p.userId) } })
        .select('pushTokens notificationPreferences')
        .lean();
    const userById = new Map(users.map((u) => [String(u._id), u]));

    let sent = 0;
    for (const plan of plans) {
        const user = userById.get(String(plan.userId));
        if (!user) continue;

        const tzOffset = offsetFor(user);
        if (tzOffset === null) { skipped.no_clock += 1; continue; }

        const { day: today, minutes } = localNow(now, tzOffset);
        const late = minutes - SEND_AT_MINUTES;
        if (late < 0 || late > WINDOW_MINUTES) { skipped.not_now += 1; continue; }

        const rows = await CycleDay.find({
            userId: plan.userId, day: { $gte: addDays(today, -LOOKBACK_DAYS), $lte: today },
        }).lean();
        const reading = forecast({ days: mergeDays(rows), plan, today, useTemperature: false });
        const message = messageFor(reading, plan);
        if (!message) { skipped.nothing_due += 1; continue; }

        const dedupeKey = `cycle:${message.kind}:${reading.prediction.expected}`;
        if (await Notification.exists({ userId: plan.userId, dedupeKey })) {
            skipped.already_sent += 1;
            continue;
        }

        const { notification } = await publish(String(plan.userId), {
            category: 'cycle',
            title: message.title,
            body: message.body,
            source: 'cycleReminderJob',
            dedupeKey,
            actions: message.actions,
            lockScreen: plan.discreetPush === false ? undefined : COVER,
            data: { type: `cycle_${message.kind}`, day: today },
        }, { user, tzOffsetMinutes: tzOffset });

        if (notification) sent += 1;
    }

    if (sent) console.log(`🌸 Cycle reminders: ${sent} cards written`);
    return { considered: plans.length, sent, skipped };
};

const scheduleCycleReminders = () => {
    setInterval(() => {
        runCycleReminders().catch((err) => console.error('❌ Cycle reminder sweep failed:', err));
    }, INTERVAL_MS).unref?.();
    console.log(`🌸 Cycle reminders scheduled every ${INTERVAL_MS / 60000} minutes (09:00 local)`);
};

module.exports = {
    scheduleCycleReminders,
    runCycleReminders,
    COVER,
    SOON_DAYS,
    _messageFor: messageFor,
    _shortDate: shortDate,
    _localDay: localDay,
};
