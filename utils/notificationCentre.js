/**
 * The one way a notification comes into existence.
 *
 * Every producer — the plan sweep, the dose sweep, the bedtime sweep, and whatever comes
 * next — calls `publish()` and nothing else. Before this existed each job built its own
 * Expo payload, sent it, and forgot it; the result was four copies of the quiet-hours
 * check, four opinions about what a title looks like, and no record anywhere that anything
 * had been sent.
 *
 * Six behaviours live here, and each is a rule a caller must not be able to get wrong:
 *
 * 1. **The row is written first and unconditionally; the push is attempted after.** A
 *    notification that could not be pushed is still a notification. This is the whole
 *    reason the inbox exists — see the header of `models/Notification.js`.
 *
 * 2. **Quiet hours and a muted channel suppress the interruption, never the record.** Both
 *    are recorded in `suppressedReason` so the difference between "nothing happened" and
 *    "it happened quietly" survives.
 *
 * 3. **Only a `critical` category may cross quiet hours**, and `notificationCatalogue.js`
 *    decides which those are. A caller cannot pass a priority; if it could, every producer
 *    would eventually think its own reminder was the urgent one.
 *
 * 4. **It never throws at the caller.** Same contract `scoreController.touch` and
 *    `pushSender.send` have, for the same reason: a person who has just logged a meal gets
 *    their 201 whether or not a card was written. Callers are expected not to await it.
 *
 * 5. **A dedupe key makes a re-run idempotent.** The write is an upsert on
 *    `{ userId, dedupeKey }`, so a job swept twice updates one row instead of writing two.
 *    A row that already exists and has been read is **not** dragged back to unread — see
 *    `reviveOnUpdate`.
 *
 * 6. **Producers cannot invent presentation.** Icon, tint, default route and which
 *    preference silences it all come off the category table. What a producer supplies is
 *    what happened.
 */
const Notification = require('../models/Notification');
const User = require('../models/userModel');
const { describe, pushAllowed } = require('./notificationCatalogue');
const { send, messagesFor, inQuietHours } = require('./pushSender');

/**
 * A route has to be one the app can actually open.
 *
 * Only the shape is checked — a leading slash and no scheme — because the router's real
 * route list lives in the other repo and duplicating it here would be a second copy to
 * keep in step. What this does catch is the failure that is otherwise invisible: an
 * `https://` link or a bare word lands in `router.push`, which does not throw, so the card
 * simply does nothing when tapped.
 */
const isAppRoute = (route) => typeof route === 'string' && /^\/[\w\-./[\]?=&%]*$/.test(route);

/** The gallery rule, once more: a picker path renders nowhere but the device that made it. */
const isHttps = (url) => typeof url === 'string' && /^https:\/\//i.test(url);

const clean = (value, max) =>
    typeof value === 'string' ? value.trim().slice(0, max) : null;

/**
 * Normalise what a producer passed into what the model stores.
 *
 * Extras are **dropped, never rejected**: a malformed meter costs a progress bar, and
 * failing the whole notification over one would mean losing the reminder to fix a
 * decoration. The same trade `findPlainLanguageWarnings` makes about jargon. Each drop is
 * logged, so a producer regression is visible rather than silent.
 */
const normalise = (input, spec) => {
    const doc = {
        category: input.category,
        title: clean(input.title, 80),
        body: clean(input.body, 240),
        route: isAppRoute(input.route) ? input.route : spec.route,
        tint: input.tint ?? null,
        data: input.data && typeof input.data === 'object' ? input.data : {},
        source: clean(input.source, 40) || 'system',
        meter: null,
        chip: null,
        imageUrl: null,
        actions: [],
    };

    if (input.route && !isAppRoute(input.route)) {
        console.warn(`⚠️ Notification route ignored (not an app route): ${input.route}`);
    }

    const m = input.meter;
    if (m && Number.isFinite(m.value) && Number.isFinite(m.max) && m.max > 0) {
        doc.meter = { value: Math.max(0, m.value), max: m.max, label: clean(m.label, 48) };
    } else if (m) {
        console.warn('⚠️ Notification meter dropped: value/max must be finite and max > 0');
    }

    const c = input.chip;
    if (c && clean(c.label, 32)) {
        doc.chip = { label: clean(c.label, 32), icon: clean(c.icon, 40) };
    } else if (c) {
        console.warn('⚠️ Notification chip dropped: a chip needs a label');
    }

    if (input.imageUrl) {
        if (isHttps(input.imageUrl)) doc.imageUrl = input.imageUrl;
        else console.warn('⚠️ Notification image dropped: https only');
    }

    for (const a of input.actions ?? []) {
        if (doc.actions.length === 2) {
            console.warn('⚠️ Notification action dropped: the card draws at most two');
            break;
        }
        if (!clean(a?.label, 24) || !isAppRoute(a?.route)) {
            console.warn('⚠️ Notification action dropped: needs a label and an app route');
            continue;
        }
        doc.actions.push({
            label: clean(a.label, 24),
            route: a.route,
            tone: a.tone === 'primary' ? 'primary' : 'secondary',
        });
    }

    return doc;
};

/**
 * Write, or update in place when this producer has published the same thing before.
 *
 * **A re-publish does not un-read the card.** Somebody who has read "Vitamin D is due next
 * week" and dismissed the thought should not find it unread again because the sweep ran at
 * midnight. The exception is a genuine change of content: when the title or body actually
 * moved — "due in 7 days" becoming "overdue by 2" — the notification is a different thing
 * and goes back to the top unread. `reviveOnUpdate` is what a producer sets when it knows
 * that is the case; the sweeps set it, because their wording tracks urgency.
 */
const upsert = async (userId, doc, dedupeKey, reviveOnUpdate) => {
    if (!dedupeKey) return Notification.create({ ...doc, userId });

    const existing = await Notification.findOne({ userId, dedupeKey });
    if (!existing) return Notification.create({ ...doc, userId, dedupeKey });

    const changed = existing.title !== doc.title || existing.body !== doc.body;
    Object.assign(existing, doc);
    if (reviveOnUpdate && changed) {
        existing.readAt = null;
        existing.pushedAt = null;
        existing.suppressedReason = null;
    }
    await existing.save();
    // A re-publish that changed nothing has nothing new to interrupt anybody about.
    return changed || reviveOnUpdate ? existing : null;
};

/**
 * Publish a notification.
 *
 * @param {string} userId
 * @param {object} input
 * @param {string} input.category      a key of `CATEGORIES`
 * @param {string} input.title
 * @param {string} input.body
 * @param {string} [input.route]       defaults to the category's route
 * @param {object} [input.meter]       `{ value, max, label }`
 * @param {object} [input.chip]        `{ label, icon }`
 * @param {string} [input.imageUrl]    https only
 * @param {object[]} [input.actions]   at most two `{ label, route, tone }`
 * @param {object} [input.data]        deep-link payload
 * @param {string} [input.dedupeKey]   makes a re-run idempotent
 * @param {string} [input.source]      which producer wrote it
 * @param {boolean} [input.push=true]  false records it without ever interrupting
 * @param {Date} [input.deliveredAt]   for a producer that sends its own push: when it went
 *                                     out. Only meaningful with `push: false`.
 * @param {boolean} [input.reviveOnUpdate=false]
 * @param {object} [options]
 * @param {object} [options.user]      an already-loaded user, to save a query
 * @param {number} [options.tzOffsetMinutes]  minutes west of UTC, as `getTimezoneOffset()`
 * @returns {Promise<{notification: object|null, pushed: number}>} never rejects
 */
const publish = async (userId, input, options = {}) => {
    try {
        const spec = describe(input?.category);
        if (!spec) {
            console.warn(`⚠️ Notification skipped: unknown category ${input?.category}`);
            return { notification: null, pushed: 0 };
        }

        const doc = normalise(input, spec);
        if (!doc.title || !doc.body) {
            console.warn('⚠️ Notification skipped: a title and a body are both required');
            return { notification: null, pushed: 0 };
        }

        const row = await upsert(userId, doc, clean(input.dedupeKey, 120), input.reviveOnUpdate === true);
        // An unchanged re-publish: the card is already there and already says this.
        if (!row) return { notification: null, pushed: 0 };

        /**
         * A producer that sends its own push.
         *
         * The dose and bedtime sweeps batch every message into one `send()` and depend on
         * what that call returns — the dose sweep hands a whole batch back when every push
         * was rejected, which it can only do because it owns the send. So they publish with
         * `push: false` and tell us afterwards whether the push actually left, rather than
         * having the card re-send it. Without `deliveredAt` every such card would read as
         * never pushed, and `wasPushed` would be a field that lies about the two producers
         * that use it most.
         */
        if (input.push === false) {
            if (input.deliveredAt instanceof Date) {
                row.pushedAt = input.deliveredAt;
                row.pushedTo = Number.isFinite(input.pushedTo) ? input.pushedTo : 1;
                row.suppressedReason = null;
                await row.save();
            }
            return { notification: row, pushed: 0 };
        }

        const user = options.user
            ?? await User.findById(userId).select('pushTokens notificationPreferences').lean();
        if (!user) return { notification: row, pushed: 0 };

        const prefs = user.notificationPreferences;

        if (!pushAllowed(input.category, prefs)) {
            row.suppressedReason = 'channel_off';
            await row.save();
            return { notification: row, pushed: 0 };
        }

        // Rule 3: only the table may exempt a category, and only `vitals` is exempt.
        if (spec.priority !== 'critical'
            && inQuietHours(prefs, new Date(), options.tzOffsetMinutes ?? null)) {
            row.suppressedReason = 'quiet_hours';
            await row.save();
            return { notification: row, pushed: 0 };
        }

        const messages = messagesFor(user, {
            title: row.title,
            body: row.body,
            // The push carries the row's id so tapping it can open the card and mark it
            // read, rather than dumping the person on a tab and leaving it unread.
            data: { ...row.data, notificationId: String(row._id), route: row.route },
        });

        if (!messages.length) {
            row.suppressedReason = 'no_device';
            await row.save();
            return { notification: row, pushed: 0 };
        }

        const result = await send(messages);
        row.pushedTo = result.sent;
        row.pushedAt = result.sent > 0 ? new Date() : null;
        row.suppressedReason = result.sent > 0 ? null : 'send_failed';
        await row.save();

        return { notification: row, pushed: result.sent };
    } catch (error) {
        // Rule 4. A notification that cannot be written must not take down the write that
        // prompted it.
        console.error('❌ Notification publish failed:', error.message);
        return { notification: null, pushed: 0 };
    }
};

/** How many unread rows this person has. Cheap enough for the home screen's badge. */
const unreadCount = (userId) => Notification.countDocuments({ userId, readAt: null });

module.exports = { publish, unreadCount, isAppRoute, isHttps };
