const mongoose = require('mongoose');
const User = require('../models/userModel');
const { isExpoPushToken } = require('../utils/pushSender');
const { runReminderJob } = require('../jobs/reminderJob');

/**
 * POST /api/notifications/register
 * Store this device's Expo push token. Idempotent — re-registering the same token on the
 * same account refreshes it rather than duplicating.
 */
exports.registerToken = async (req, res) => {
    try {
        const { token, platform, deviceName } = req.body;
        // Real offsets run from -840 (UTC+14) to +720 (UTC-12). Anything else is dropped
        // rather than stored, because a wrong clock is worse than none — see hydrationNudgeJob.
        const offset = Number(req.body.tzOffset);
        const tzOffset = Number.isFinite(offset) && offset >= -840 && offset <= 720 ? offset : null;

        if (!token || !isExpoPushToken(token)) {
            return res.status(400).json({ message: 'A valid Expo push token is required' });
        }

        // A token identifies a device, not a person: if it moved to another account,
        // detach it there first or the previous owner keeps receiving this device's pushes.
        await User.updateMany(
            { _id: { $ne: req.auth.userId }, 'pushTokens.token': token },
            { $pull: { pushTokens: { token } } }
        );

        await User.updateOne({ _id: req.auth.userId }, { $pull: { pushTokens: { token } } });
        await User.updateOne(
            { _id: req.auth.userId },
            { $push: { pushTokens: { token, platform, deviceName, tzOffset, registeredAt: new Date() } } },
            { runValidators: true }
        );

        const user = await User.findById(req.auth.userId).select('pushTokens notificationPreferences').lean();
        res.json({
            message: 'Device registered for notifications',
            deviceCount: user.pushTokens.length,
            preferences: user.notificationPreferences,
        });
    } catch (error) {
        console.error('❌ Token registration failed:', error);
        res.status(500).json({ message: 'Could not register this device', error: error.message });
    }
};

/** DELETE /api/notifications/register — stop notifying this device. */
exports.unregisterToken = async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) return res.status(400).json({ message: 'token is required' });

        await User.updateOne({ _id: req.auth.userId }, { $pull: { pushTokens: { token } } });
        res.json({ message: 'Device unregistered' });
    } catch (error) {
        res.status(500).json({ message: 'Could not unregister', error: error.message });
    }
};

/** GET /api/notifications/preferences */
exports.getPreferences = async (req, res) => {
    try {
        const user = await User.findById(req.auth.userId).select('pushTokens notificationPreferences').lean();
        if (!user) return res.status(404).json({ message: 'User not found' });

        res.json({
            preferences: user.notificationPreferences ?? {},
            deviceCount: user.pushTokens?.length ?? 0,
        });
    } catch (error) {
        res.status(500).json({ message: 'Could not load preferences', error: error.message });
    }
};

/** PUT /api/notifications/preferences */
exports.updatePreferences = async (req, res) => {
    try {
        const allowed = ['enabled', 'offsetDays', 'overdueReminders', 'orderUpdates', 'resultsReady', 'quietHours'];
        const updates = {};
        for (const key of allowed) {
            if (key in req.body) updates[`notificationPreferences.${key}`] = req.body[key];
        }

        if (!Object.keys(updates).length) {
            return res.status(400).json({ message: 'No recognised preferences supplied' });
        }

        const user = await User.findByIdAndUpdate(
            req.auth.userId,
            { $set: updates },
            { new: true, runValidators: true }
        ).select('notificationPreferences').lean();

        res.json({ message: 'Preferences updated', preferences: user.notificationPreferences });
    } catch (error) {
        res.status(400).json({ message: 'Could not update preferences', error: error.message });
    }
};

/**
 * POST /api/notifications/test
 * Send a notification to this user's own devices, so someone can confirm delivery works
 * without waiting a day for the scheduled job.
 */
exports.sendTest = async (req, res) => {
    try {
        const { notifyUser } = require('../jobs/reminderJob');
        const result = await notifyUser(req.auth.userId, {
            title: 'Miovix',
            body: 'Notifications are working. This is a test.',
            data: { type: 'test' },
        });

        if (!result.sent) {
            return res.status(409).json({
                message: 'No notification was delivered — check this device is registered and notifications are enabled',
                ...result,
            });
        }
        res.json({ message: 'Test notification sent', ...result });
    } catch (error) {
        res.status(500).json({ message: 'Could not send a test', error: error.message });
    }
};

/** POST /api/notifications/run-reminders — admin trigger, also useful as a dry run. */
exports.triggerReminders = async (req, res) => {
    try {
        const result = await runReminderJob({ dryRun: Boolean(req.body?.dryRun) });
        res.json({ message: req.body?.dryRun ? 'Dry run complete' : 'Reminder job complete', ...result });
    } catch (error) {
        res.status(500).json({ message: 'Reminder job failed', error: error.message });
    }
};

/* ------------------------------------------------------------------ *
 * The notification centre — the inbox `Design/notification.svg` draws
 * ------------------------------------------------------------------ */

const Notification = require('../models/Notification');
const { publish, unreadCount } = require('../utils/notificationCentre');
const { describe, CATEGORY_KEYS } = require('../utils/notificationCatalogue');

/** How many rows one page of the feed holds. */
const PAGE_SIZE = 30;

/**
 * The local calendar day a moment fell on, `YYYY-MM-DD`.
 *
 * Written from the client's `tzOffset`, the same convention `MealLog.day` and
 * `medicationSchedule` follow — minutes west of UTC, so UTC+4 is `-240`. Grouping the feed
 * by UTC files an evening notification in the Americas under the following day, which on a
 * screen whose section headers read "Today" and "Yesterday" is the one place it shows.
 */
const localDay = (date, tzOffsetMinutes) => {
    const shifted = new Date(new Date(date).getTime() - (tzOffsetMinutes || 0) * 60_000);
    return shifted.toISOString().slice(0, 10);
};

/** The card as the client reads it. Presentation comes off the table, never off the row. */
const toCard = (row, tzOffsetMinutes) => {
    const spec = describe(row.category);
    return {
        id: String(row._id),
        category: row.category,
        categoryLabel: spec?.label ?? 'Notification',
        icon: spec?.icon ?? 'notifications-outline',
        tint: row.tint ?? spec?.tint ?? 'slate',
        title: row.title,
        body: row.body,
        route: row.route,
        meter: row.meter ?? null,
        chip: row.chip ?? null,
        imageUrl: row.imageUrl ?? null,
        actions: row.actions ?? [],
        data: row.data ?? {},
        read: row.readAt !== null,
        readAt: row.readAt,
        createdAt: row.createdAt,
        day: localDay(row.createdAt, tzOffsetMinutes),
        /**
         * Whether this one was ever actually pushed. The centre does not render it, but it
         * is the only way to tell an inbox row that interrupted somebody from one that
         * waited quietly — and without it the quiet-hours behaviour is unverifiable in
         * production.
         */
        wasPushed: row.pushedAt !== null,
    };
};

/**
 * GET /api/notifications
 *
 * `?state=unread|read|all` — the two tabs, and everything.
 * `?category=<key>`        — the filter chips.
 * `?before=<ISO>`          — cursor, for the next page.
 * `?tzOffset=<minutes>`    — how `day` is computed. See `localDay`.
 *
 * **Cursor paging, not `skip`.** A feed people read while it is being written to is exactly
 * where an offset is wrong: a notification arriving between page one and page two shifts
 * every later row down one, so page two repeats a card and hides another. `createdAt` is
 * the cursor and `_id` breaks the tie, because two rows written by one sweep share a
 * millisecond often enough to matter.
 */
exports.list = async (req, res) => {
    try {
        const { state = 'unread', category, before, beforeId } = req.query;
        const tz = Number.parseInt(req.query.tzOffset, 10);
        const tzOffsetMinutes = Number.isFinite(tz) ? tz : 0;

        if (!['unread', 'read', 'all'].includes(state)) {
            return res.status(400).json({ message: 'state must be unread, read or all' });
        }
        if (category && !CATEGORY_KEYS.includes(category)) {
            return res.status(400).json({ message: `Unknown category: ${category}` });
        }

        const query = { userId: req.auth.userId };
        if (state === 'unread') query.readAt = null;
        if (state === 'read') query.readAt = { $ne: null };
        if (category) query.category = category;

        if (before) {
            const cursor = new Date(before);
            if (Number.isNaN(cursor.getTime())) {
                return res.status(400).json({ message: 'before must be an ISO date' });
            }
            query.$or = [
                { createdAt: { $lt: cursor } },
                ...(beforeId ? [{ createdAt: cursor, _id: { $lt: beforeId } }] : []),
            ];
        }

        // One extra row answers "is there another page" without a second count query.
        const rows = await Notification.find(query)
            .sort({ createdAt: -1, _id: -1 })
            .limit(PAGE_SIZE + 1)
            .lean();

        const hasMore = rows.length > PAGE_SIZE;
        const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
        const last = page[page.length - 1];

        /**
         * The counts are for the tabs and the chips, and they ignore the current filter on
         * purpose: a "Read" tab that reads "Read (0)" because you are filtered to
         * medications is a tab that looks broken rather than filtered.
         */
        const [unread, read, byCategory] = await Promise.all([
            Notification.countDocuments({ userId: req.auth.userId, readAt: null }),
            Notification.countDocuments({ userId: req.auth.userId, readAt: { $ne: null } }),
            Notification.aggregate([
                { $match: { userId: new mongoose.Types.ObjectId(String(req.auth.userId)) } },
                { $group: { _id: '$category', total: { $sum: 1 }, unread: { $sum: { $cond: [{ $eq: ['$readAt', null] }, 1, 0] } } } },
            ]),
        ]);

        res.json({
            notifications: page.map((row) => toCard(row, tzOffsetMinutes)),
            counts: {
                unread,
                read,
                byCategory: byCategory.reduce((acc, c) => {
                    acc[c._id] = { total: c.total, unread: c.unread };
                    return acc;
                }, {}),
            },
            nextCursor: hasMore && last
                ? { before: last.createdAt.toISOString(), beforeId: String(last._id) }
                : null,
        });
    } catch (error) {
        console.error('❌ Notification feed failed:', error);
        res.status(500).json({ message: 'Could not load notifications', error: error.message });
    }
};

/** GET /api/notifications/unread-count — what the home screen's bell draws. */
exports.unreadCount = async (req, res) => {
    try {
        res.json({ unread: await unreadCount(req.auth.userId) });
    } catch (error) {
        res.status(500).json({ message: 'Could not count notifications', error: error.message });
    }
};

/**
 * PATCH /api/notifications/:id/read — `{ read: true | false }`, default true.
 *
 * Idempotent, and **marking an already-read row read again does not move `readAt`**: that
 * timestamp is when the person first saw it, and a screen that re-marks on every scroll
 * would otherwise rewrite it continuously and make the one measure of this feature — how
 * long things sit unread — always read zero.
 */
exports.markRead = async (req, res) => {
    try {
        const read = req.body?.read !== false;
        const row = await Notification.findOne({ _id: req.params.id, userId: req.auth.userId });
        // 404 rather than 403 on somebody else's id, the call `middleware/ownership.js` makes.
        if (!row) return res.status(404).json({ message: 'Notification not found' });

        if (read && row.readAt === null) row.readAt = new Date();
        if (!read) row.readAt = null;
        await row.save();

        res.json({ notification: toCard(row.toObject(), 0), unread: await unreadCount(req.auth.userId) });
    } catch (error) {
        res.status(500).json({ message: 'Could not update this notification', error: error.message });
    }
};

/**
 * POST /api/notifications/read-all — empties the Unread tab.
 *
 * Takes an optional `category`, because "mark everything read" on a filtered list that
 * clears notifications the person cannot currently see is a button that does more than it
 * says.
 */
exports.markAllRead = async (req, res) => {
    try {
        const { category } = req.body ?? {};
        if (category && !CATEGORY_KEYS.includes(category)) {
            return res.status(400).json({ message: `Unknown category: ${category}` });
        }

        const filter = { userId: req.auth.userId, readAt: null };
        if (category) filter.category = category;

        const result = await Notification.updateMany(filter, { $set: { readAt: new Date() } });
        res.json({ marked: result.modifiedCount, unread: await unreadCount(req.auth.userId) });
    } catch (error) {
        res.status(500).json({ message: 'Could not mark these read', error: error.message });
    }
};

/**
 * DELETE /api/notifications/:id — dismiss.
 *
 * A real delete, unlike `DELETE /medications/:id`, which archives. A dose history is a
 * clinical record; a message somebody has swiped away is not, and keeping a hidden copy of
 * every notification a person has dismissed is a collection of special-category data with
 * nothing asking for it. The TTL takes the rest — see `models/Notification.js`.
 */
exports.dismiss = async (req, res) => {
    try {
        const result = await Notification.deleteOne({ _id: req.params.id, userId: req.auth.userId });
        if (!result.deletedCount) return res.status(404).json({ message: 'Notification not found' });
        res.json({ message: 'Dismissed', unread: await unreadCount(req.auth.userId) });
    } catch (error) {
        res.status(500).json({ message: 'Could not dismiss this notification', error: error.message });
    }
};

/**
 * POST /api/notifications/test now also leaves a card behind.
 *
 * Exposed separately so the settings screen can prove the *centre* works, which is a
 * different question from whether a push arrives — and the more common failure, since a
 * push depends on a registered device and the card does not.
 */
exports.sendSelfTest = async (req, res) => {
    try {
        const { notification, pushed } = await publish(req.auth.userId, {
            category: 'account',
            title: 'Notifications are working',
            body: 'This is a test card. It will appear in your notification centre whether or not the push arrived.',
            route: '/notifications',
            source: 'self-test',
            dedupeKey: `self-test:${Date.now()}`,
        });

        if (!notification) {
            return res.status(500).json({ message: 'Could not write the test notification' });
        }
        res.json({ message: 'Test notification created', pushed, notification: toCard(notification.toObject(), 0) });
    } catch (error) {
        res.status(500).json({ message: 'Could not send a test', error: error.message });
    }
};
