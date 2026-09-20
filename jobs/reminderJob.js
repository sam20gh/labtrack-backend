/**
 * Daily reminder sweep.
 *
 * Sends a push when a plan item is approaching or past its due date. Runs after the status
 * sweep so urgency is already current.
 *
 * Two guards keep this from becoming a nuisance:
 *
 *   - `reminder.sentOffsets` records which offsets have already fired for an item, so a
 *     restarted server or a second run in a day cannot re-notify. Being pestered about the
 *     same screening is how people turn notifications off entirely.
 *   - Overdue items are reminded weekly, not daily. An item that has been urgent for three
 *     months should not produce ninety notifications.
 */
const PlanItem = require('../models/PlanItem');
const User = require('../models/userModel');
const { send, messagesFor, inQuietHours } = require('../utils/pushSender');
const { publish } = require('../utils/notificationCentre');

const DAY_MS = 86400000;

/** Days between overdue nudges. */
const OVERDUE_INTERVAL_DAYS = 7;

const startOfToday = () => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
};

const daysUntil = (date, from = startOfToday()) =>
    Math.round((new Date(date).setHours(0, 0, 0, 0) - from.getTime()) / DAY_MS);

/** Wording depends on how the person should feel about it. */
const composeMessage = (item, daysAway) => {
    if (daysAway < 0) {
        const overdueBy = Math.abs(daysAway);
        return {
            title: 'Overdue health check',
            body: `${item.title} was due ${overdueBy === 1 ? 'yesterday' : `${overdueBy} days ago`}. Tap to book it.`,
        };
    }
    if (daysAway === 0) {
        return { title: 'Due today', body: `${item.title} is due today.` };
    }
    return {
        title: 'Coming up',
        body: `${item.title} is due in ${daysAway === 1 ? '1 day' : `${daysAway} days`}.`,
    };
};

/**
 * Which offset, if any, should fire for this item today?
 * @returns {number|null} the offset to record, or null when nothing is due
 */
const dueOffset = (item, preferences) => {
    const daysAway = daysUntil(item.dueDate);
    const offsets = item.reminder?.offsetDays?.length
        ? item.reminder.offsetDays
        : (preferences?.offsetDays ?? [7, 0]);
    const sent = item.reminder?.sentOffsets ?? [];

    if (daysAway >= 0) {
        // Upcoming: fire the largest matching offset not already sent
        const match = offsets.filter((o) => o === daysAway && !sent.includes(o));
        return match.length ? match[0] : null;
    }

    if (!preferences?.overdueReminders) return null;

    // Overdue: weekly, tracked with negative pseudo-offsets so the same guard applies
    const weeksOverdue = Math.floor(Math.abs(daysAway) / OVERDUE_INTERVAL_DAYS);
    if (weeksOverdue < 1) return null;

    const marker = -weeksOverdue;
    return sent.includes(marker) ? null : marker;
};

/**
 * Run the sweep.
 * @param {object} options
 * @param {boolean} options.dryRun report what would be sent without sending
 */
const runReminderJob = async ({ dryRun = false } = {}) => {
    const today = startOfToday();
    const horizon = new Date(today.getTime() + 31 * DAY_MS);

    // Anything open and within a month either way — outside that nothing can be due
    const items = await PlanItem.find({
        status: { $in: ['upcoming', 'due', 'urgent'] },
        'reminder.enabled': true,
        dueDate: { $lte: horizon },
    }).limit(5000).lean();

    if (!items.length) return { candidates: 0, sent: 0, skipped: 0 };

    const userIds = [...new Set(items.map((i) => String(i.userId)))];
    const users = await User.find({ _id: { $in: userIds } })
        .select('pushTokens notificationPreferences')
        .lean();
    const byUser = new Map(users.map((u) => [String(u._id), u]));

    /**
     * The due items, paired with what to say about them.
     *
     * **Nothing is skipped here for a reason that is about delivery.** This loop used to
     * drop an item when the person had no registered device, had notifications off, or was
     * inside their quiet window — which meant the reminder did not merely stay silent, it
     * ceased to exist, and the offset was never marked so it fired again the next day and
     * vanished again. Those three questions are `notificationCentre.publish`'s, and it
     * answers them by writing the card and suppressing only the interruption. What is still
     * decided here is the only thing that is genuinely this job's: whether anything is due.
     */
    const due = [];

    for (const item of items) {
        const user = byUser.get(String(item.userId));
        if (!user) continue;

        const offset = dueOffset(item, user.notificationPreferences ?? {});
        if (offset === null) continue;

        const daysAway = daysUntil(item.dueDate);
        const { title, body } = composeMessage(item, daysAway);
        due.push({ item, user, offset, title, body, daysAway });
    }

    if (dryRun) {
        return {
            candidates: items.length,
            wouldSend: due.length,
            skipped: 0,
            preview: due.slice(0, 5).map((d) => ({ title: d.title, body: d.body })),
        };
    }

    if (!due.length) return { candidates: items.length, sent: 0, skipped: 0 };

    let sent = 0;
    for (const d of due) {
        const { pushed } = await publish(String(d.item.userId), {
            category: 'plan',
            title: d.title,
            body: d.body,
            route: '/myplans',
            source: 'reminderJob',
            /**
             * One card per item per offset. A restarted server re-runs today's sweep, and
             * without this the person wakes to the same screening twice.
             */
            dedupeKey: `plan:${d.item._id}:${d.offset}`,
            /**
             * The wording tracks urgency — "due in 7 days" becomes "overdue by 2" — so a
             * card whose text has genuinely moved is a new thing to say and goes back to
             * unread. One that has not changed stays where the person left it.
             */
            reviveOnUpdate: true,
            actions: [{ label: 'View plan', route: '/myplans', tone: 'primary' }],
            data: { type: 'plan_item', planItemId: String(d.item._id) },
        }, { user: d.user });
        sent += pushed;

        // The offset is recorded whether or not a push went out, because the card did:
        // marking only on a successful send re-notifies every day somebody is asleep.
        await PlanItem.updateOne(
            { _id: d.item._id },
            {
                $addToSet: { 'reminder.sentOffsets': d.offset },
                $set: { 'reminder.lastSentAt': new Date() },
            }
        );
    }

    console.log(`🔔 Reminders: ${due.length} cards written, ${sent} pushes delivered`);
    return { candidates: items.length, sent, skipped: 0, items: due.length };
};

/**
 * One-off notification, used for order and result events.
 *
 * **Push only — it writes no inbox card.** Callers that want a card call
 * `notificationCentre.publish` directly, which is the path every new producer should take.
 * This is kept because `POST /notifications/test` uses it to answer one narrow question —
 * does a push actually reach this handset — and a test that also wrote a card could pass
 * on the card while the push was broken, which is the failure it exists to find.
 */
const notifyUser = async (userId, { title, body, data, preferenceKey }) => {
    const user = await User.findById(userId).select('pushTokens notificationPreferences').lean();
    if (!user?.pushTokens?.length) return { sent: 0 };

    const preferences = user.notificationPreferences ?? {};
    if (preferences.enabled === false) return { sent: 0 };
    if (preferenceKey && preferences[preferenceKey] === false) return { sent: 0 };

    return send(messagesFor(user, { title, body, data }));
};

const scheduleReminderJob = () => {
    const cron = require('node-cron');

    // 09:00 daily — late enough to be civil, early enough to act on the same day
    cron.schedule('0 9 * * *', () => {
        runReminderJob().catch((e) => console.error('❌ Reminder job failed:', e.message));
    });

    console.log('🔔 Reminder job scheduled (daily 09:00)');
};

module.exports = { runReminderJob, scheduleReminderJob, notifyUser, dueOffset, composeMessage, daysUntil };
