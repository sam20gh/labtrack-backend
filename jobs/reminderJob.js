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

    const messages = [];
    const toMark = [];
    let skipped = 0;

    for (const item of items) {
        const user = byUser.get(String(item.userId));
        if (!user) continue;

        const preferences = user.notificationPreferences ?? {};
        if (preferences.enabled === false) { skipped++; continue; }
        if (!user.pushTokens?.length) { skipped++; continue; }
        if (inQuietHours(preferences)) { skipped++; continue; }

        const offset = dueOffset(item, preferences);
        if (offset === null) continue;

        const daysAway = daysUntil(item.dueDate);
        const { title, body } = composeMessage(item, daysAway);

        messages.push(...messagesFor(user, {
            title,
            body,
            data: { type: 'plan_item', planItemId: String(item._id), route: '/myplans' },
        }));
        toMark.push({ id: item._id, offset });
    }

    if (dryRun) {
        return { candidates: items.length, wouldSend: messages.length, skipped, preview: messages.slice(0, 5) };
    }

    if (!messages.length) return { candidates: items.length, sent: 0, skipped };

    const result = await send(messages);

    // Record only after a successful send attempt, so a failed batch retries tomorrow
    for (const mark of toMark) {
        await PlanItem.updateOne(
            { _id: mark.id },
            {
                $addToSet: { 'reminder.sentOffsets': mark.offset },
                $set: { 'reminder.lastSentAt': new Date() },
            }
        );
    }

    console.log(`🔔 Reminders: ${result.sent} sent, ${result.failed} failed, ${result.pruned} tokens pruned, ${skipped} skipped`);
    return { candidates: items.length, ...result, skipped, items: toMark.length };
};

/** One-off notification, used for order and result events. */
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
