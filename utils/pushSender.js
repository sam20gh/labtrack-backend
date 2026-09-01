/**
 * Expo push delivery.
 *
 * Wraps `expo-server-sdk` with the two behaviours that matter in practice:
 *
 *   - **Pruning dead tokens.** A token survives an uninstall but stops working. Expo reports
 *     `DeviceNotRegistered`, and a sender that ignores it accumulates tokens that will never
 *     deliver, wasting a send slot on every future notification.
 *   - **Never throwing at the caller.** A reminder that cannot be delivered must not abort
 *     the job that was sending it; the other users' reminders still need to go out.
 */
const { Expo } = require('expo-server-sdk');
const User = require('../models/userModel');

const expo = new Expo();

/** Remove a token Expo has told us is dead. */
const pruneToken = async (token) => {
    await User.updateMany(
        { 'pushTokens.token': token },
        { $pull: { pushTokens: { token } } }
    );
    console.log('🧹 Pruned unregistered push token');
};

/**
 * Send messages, chunked as Expo requires.
 *
 * @param {{to:string,title:string,body:string,data?:object}[]} messages
 * @returns {Promise<{sent:number, failed:number, pruned:number}>}
 */
const send = async (messages) => {
    const valid = messages.filter((m) => {
        if (Expo.isExpoPushToken(m.to)) return true;
        console.warn('⚠️ Skipping malformed push token');
        return false;
    });

    if (!valid.length) return { sent: 0, failed: 0, pruned: 0 };

    let sent = 0;
    let failed = 0;
    let pruned = 0;

    for (const chunk of expo.chunkPushNotifications(valid)) {
        let tickets = [];
        try {
            tickets = await expo.sendPushNotificationsAsync(chunk);
        } catch (error) {
            console.error('❌ Push chunk failed:', error.message);
            failed += chunk.length;
            continue;
        }

        for (let i = 0; i < tickets.length; i++) {
            const ticket = tickets[i];
            if (ticket.status === 'ok') {
                sent++;
                continue;
            }

            failed++;
            if (ticket.details?.error === 'DeviceNotRegistered') {
                await pruneToken(chunk[i].to);
                pruned++;
            } else {
                console.warn('⚠️ Push rejected:', ticket.details?.error || ticket.message);
            }
        }
    }

    return { sent, failed, pruned };
};

/**
 * Is it currently inside the user's quiet hours?
 *
 * A medical reminder at 03:00 is worse than one that waits until morning — the job runs
 * daily, so a deferred reminder simply goes out on the next run.
 *
 * **The hour must be the person's, not the server's.** `now.getHours()` is the hour where
 * the process happens to run, which in production is UTC: a quiet window of 22→8 set by
 * someone in Dubai silenced their evening and let through their small hours, exactly
 * inverted. `tzOffsetMinutes` follows the same convention as `medicationSchedule` and the
 * client's `getTimezoneOffset()` — minutes west of UTC, so UTC+4 is `-240`. Callers that
 * genuinely have no offset to hand pass none and keep the old server-local behaviour.
 */
const inQuietHours = (preferences, now = new Date(), tzOffsetMinutes = null) => {
    const quiet = preferences?.quietHours;
    if (!quiet || typeof quiet.start !== 'number' || typeof quiet.end !== 'number') return false;

    const hour = Number.isFinite(tzOffsetMinutes)
        ? new Date(now.getTime() - tzOffsetMinutes * 60_000).getUTCHours()
        : now.getHours();

    // A window like 22→8 wraps past midnight
    return quiet.start > quiet.end
        ? hour >= quiet.start || hour < quiet.end
        : hour >= quiet.start && hour < quiet.end;
};

/** Build a message for one user's devices. */
const messagesFor = (user, { title, body, data }) =>
    (user.pushTokens || []).map((t) => ({
        to: t.token,
        sound: 'default',
        title,
        body,
        data: data || {},
        // Health reminders should surface, but not override a silenced phone
        priority: 'default',
    }));

module.exports = { send, messagesFor, inQuietHours, pruneToken, isExpoPushToken: Expo.isExpoPushToken };
