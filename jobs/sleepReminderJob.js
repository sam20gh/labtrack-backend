/**
 * Bedtime reminders.
 *
 * **This is not an alarm.** A schedule here sends one push before bedtime; it does not wake
 * anybody up. See the note at the top of `models/SleepSchedule.js` for why the kit's alarm
 * clock is not reproduced — the short version is that a ringing alarm needs entitlements
 * this build does not have, and an alarm that silently fails to go off is worse than no
 * alarm at all.
 *
 * Shaped after `medicationReminderJob.js`, and it inherits three of its four guards:
 *
 *   1. **`lastRemindedAt` is stamped before the push is attempted**, so a restart mid-send
 *      cannot double-notify. Unlike a dose it is not a one-shot flag — a schedule recurs —
 *      so it is compared against the current local day instead.
 *   2. **A grace window, not "everything overdue".** A bedtime more than
 *      `LATE_GRACE_MINUTES` past is written off silently. Coming back online at 3am should
 *      not produce a notification telling somebody to go to bed.
 *   3. **Quiet hours are not consulted, and that is deliberate.** A person who set a bedtime
 *      of 22:30 has told us more about when they want to hear from us than a default quiet
 *      window has, and a bedtime reminder lands inside anybody's quiet hours by definition.
 *      Suppressing it would make the feature silently not work — the same exception the dose
 *      sweep carves out for a dose somebody scheduled themselves.
 *
 * The fourth guard, an account with no registered device, is handled the same way it is
 * there: nothing is stamped, because nothing was announced and the row can become
 * deliverable inside the same window.
 */
const SleepSchedule = require('../models/SleepSchedule');
const User = require('../models/userModel');
const { send, messagesFor } = require('../utils/pushSender');
const { publish } = require('../utils/notificationCentre');
const { formatMinutes } = require('../utils/sleepTargets');

/** How often the sweep runs. */
const INTERVAL_MS = 5 * 60 * 1000;

/** A reminder more than this far past its moment is written off rather than sent late. */
const LATE_GRACE_MINUTES = 45;

/** `HH:MM` in the person's own clock, which is the only clock a bedtime means anything in. */
const clock = (minutes) => {
    const h = Math.floor(minutes / 60) % 24;
    const m = Math.round(minutes % 60);
    const suffix = h >= 12 ? 'PM' : 'AM';
    const hour = h % 12 === 0 ? 12 : h % 12;
    return `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
};

/** The person's local day and minutes-from-midnight, from their stored `tzOffset`. */
const localNow = (now, tzOffset) => {
    const shifted = new Date(now.getTime() - (Number(tzOffset) || 0) * 60_000);
    return {
        day: shifted.toISOString().slice(0, 10),
        minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
        weekday: shifted.getUTCDay(),
    };
};

const composeMessage = (schedule, bedtimeMin) => ({
    title: 'Time to wind down',
    body: schedule.remindMinutesBefore > 0
        ? `${schedule.name} starts at ${clock(bedtimeMin)}. That is in about ${schedule.remindMinutesBefore} minutes.`
        : `${schedule.name} — bedtime is now, ${clock(bedtimeMin)}.`,
    data: { type: 'sleep_bedtime', scheduleId: String(schedule._id) },
});

/**
 * One sweep. Exported so a test can run it without waiting on a timer.
 *
 * @returns {Promise<{considered:number, sent:number, suppressed:number}>}
 */
const runSleepReminders = async (now = new Date()) => {
    const schedules = await SleepSchedule.find({ enabled: true, remindMinutesBefore: { $gte: 0 } })
        .limit(1000)
        .lean();

    if (!schedules.length) return { considered: 0, sent: 0, suppressed: 0 };

    /**
     * Which schedules are inside their reminder window *in their own timezone*.
     *
     * Filtered here rather than in the query because the moment a reminder is due is a
     * local-clock fact and Mongo has no idea what clock any of these people are on. The
     * collection is one row per routine per person, so scanning it is cheap.
     */
    const due = [];
    for (const schedule of schedules) {
        const { day, minutes, weekday } = localNow(now, schedule.tzOffset);

        if (schedule.days?.length && !schedule.days.includes(weekday)) continue;

        // The reminder's own moment, which can fall on the previous day when the lead time
        // crosses midnight — a 00:25 bedtime reminded 30 minutes early is 23:55 yesterday.
        const target = ((schedule.bedtimeMin - schedule.remindMinutesBefore) % 1440 + 1440) % 1440;
        const late = ((minutes - target) % 1440 + 1440) % 1440;
        if (late > LATE_GRACE_MINUTES) continue;

        // One reminder per local day, so a five-minute sweep does not send nine of them.
        if (schedule.lastRemindedAt) {
            const last = localNow(new Date(schedule.lastRemindedAt), schedule.tzOffset);
            if (last.day === day) continue;
        }

        // The local day travels with the schedule: the card's dedupe key needs it, and
        // recomputing it later would use the server's clock rather than this person's.
        due.push({ schedule, day });
    }

    if (!due.length) return { considered: 0, sent: 0, suppressed: 0 };

    const userIds = [...new Set(due.map((d) => String(d.schedule.userId)))];
    const users = await User.find({ _id: { $in: userIds } }).select('pushTokens').lean();
    const userById = new Map(users.map((u) => [String(u._id), u]));

    const messages = [];
    const announced = [];
    const carded = [];
    let suppressed = 0;

    for (const { schedule, day } of due) {
        const user = userById.get(String(schedule.userId));

        // No device on the account. Not stamped, for the reason the dose sweep gives: this
        // is the one suppression that can become deliverable inside the same window, and
        // burning the row means a reminder somebody just enabled still never arrives.
        if (!user || !(user.pushTokens || []).length) { suppressed += 1; continue; }

        announced.push(schedule._id);
        const composed = composeMessage(schedule, schedule.bedtimeMin);
        messages.push(...messagesFor(user, composed));
        carded.push({ schedule, composed, user, day });
    }

    if (announced.length) {
        await SleepSchedule.updateMany(
            { _id: { $in: announced } },
            { $set: { lastRemindedAt: now } }
        );
    }

    if (!messages.length) return { considered: due.length, sent: 0, suppressed };

    const result = await send(messages);

    /**
     * The inbox cards, after the send and with `push: false` — the same arrangement the
     * dose sweep uses and for the same reason: this job owns its batch.
     *
     * Quiet hours are still not consulted, here or in `publish`. A bedtime reminder falls
     * inside anybody's quiet window by definition, which is why `sleep` is not a `critical`
     * category and this path does not route through the quiet-hours check at all.
     */
    const deliveredAt = result.sent > 0 ? new Date() : null;
    for (const c of carded) {
        await publish(String(c.schedule.userId), {
            category: 'sleep',
            title: c.composed.title,
            body: c.composed.body,
            route: '/sleep',
            source: 'sleepReminderJob',
            // One card per schedule per local day — the same guard `lastRemindedAt` gives
            // the push, expressed where the card can see it.
            dedupeKey: `bedtime:${c.schedule._id}:${c.day}`,
            push: false,
            deliveredAt,
            pushedTo: (c.user.pushTokens || []).length,
            actions: [{ label: 'Sleep tracker', route: '/sleep', tone: 'primary' }],
            data: { type: 'bedtime', scheduleId: String(c.schedule._id) },
        }, { user: c.user });
    }

    console.log(`🌙 Bedtime reminders: ${result.sent} sent, ${carded.length} cards, ${suppressed} suppressed`);

    return { considered: due.length, sent: result.sent, suppressed };
};

const scheduleSleepReminders = () => {
    setInterval(() => {
        runSleepReminders().catch((err) => console.error('❌ Bedtime reminder sweep failed:', err));
    }, INTERVAL_MS).unref?.();

    console.log(`⏰ Bedtime reminders scheduled every ${INTERVAL_MS / 60000} minutes`);
};

module.exports = {
    scheduleSleepReminders,
    runSleepReminders,
    _clock: clock,
    _localNow: localNow,
    _LATE_GRACE_MINUTES: LATE_GRACE_MINUTES,
    _formatMinutes: formatMinutes,
};
