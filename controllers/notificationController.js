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
            { $push: { pushTokens: { token, platform, deviceName, registeredAt: new Date() } } },
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
            title: 'LabTrack',
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
