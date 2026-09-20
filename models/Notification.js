const mongoose = require('mongoose');
const { CATEGORY_KEYS, TINTS } = require('../utils/notificationCatalogue');

/**
 * One notification, as a record.
 *
 * Until this existed a notification was only ever a *push*: `pushSender` handed bytes to
 * Expo and nothing remembered that it had. That made three ordinary things impossible —
 * reading a reminder you swiped away, seeing what arrived while the phone was in quiet
 * hours, and knowing whether you had dealt with it — and it made a fourth thing quietly
 * wrong: quiet hours and a muted channel destroyed the *notification*, not just the
 * interruption. `Design/notification.svg` draws the answer, an Unread/Read inbox.
 *
 * Four rules the shape encodes:
 *
 * 1. **The row is the notification; the push is one delivery of it.** `publish()` always
 *    writes the row and only sometimes sends the push. A person with no registered device,
 *    inside their quiet window, with order updates switched off, still opens the app to
 *    find the order update waiting. `pushedAt` records which deliveries actually went out,
 *    so "we never told you" and "we told you and you were asleep" stay distinguishable.
 *
 * 2. **`readAt` is a timestamp, not a boolean.** The tabs only need the distinction, but a
 *    boolean cannot answer how long something sat unread, which is the only measure of
 *    whether this feature works. Null means unread; nothing else does.
 *
 * 3. **`dedupeKey` is what makes a producer safe to re-run.** The reminder jobs sweep on a
 *    schedule and a restarted server re-runs a sweep; a key of `plan:<itemId>:<offset>`
 *    turns a second run into an update of the same row rather than a second card. It is
 *    unique **per person**, sparse, so a producer with nothing sensible to key on is still
 *    allowed to write.
 *
 * 4. **The card's extras are data, not markup.** `meter`, `chip`, `imageUrl` and
 *    `actions[]` are the four variants the kit draws, and they are fields rather than a
 *    blob of HTML so the client owns how they look and the server owns what they say.
 *    Anything else a producer wants to attach goes in `data`, which only the deep link
 *    reads.
 *
 * **Not append-only, unlike `Interpretation` and `AchievementUnlock`.** Those are records
 * of a finding and of something earned; this is a message, and a message a person has
 * dismissed should go. `DELETE /:id` removes the row, and a TTL index expires everything
 * after `RETENTION_DAYS` — an inbox nobody prunes is one that takes longer to open every
 * month it exists.
 */

/** How long a notification survives. Ninety days is three months of "Yesterday". */
const RETENTION_DAYS = 90;

/**
 * A progress bar inside the card — the kit's hydration reminder.
 *
 * `value` and `max` rather than a percentage, so the card can print "750ml of 2,400ml"
 * without the server having to decide how to word it, and so a meter whose max is zero can
 * be recognised and dropped rather than dividing by it.
 */
const MeterSchema = new mongoose.Schema({
    value: { type: Number, required: true, min: 0 },
    max: { type: Number, required: true, min: 0 },
    /** Optional caption under the bar, e.g. `750ml to go`. */
    label: { type: String, default: null, maxlength: 48 },
}, { _id: false });

/** The outlined pill under the body — the kit's `128/80mmHg`. */
const ChipSchema = new mongoose.Schema({
    label: { type: String, required: true, maxlength: 32 },
    /** Ionicons name; the client falls back to no icon rather than to a blank square. */
    icon: { type: String, default: null, maxlength: 40 },
}, { _id: false });

/**
 * One tappable action on the card. The kit draws at most two — "View Details" beside
 * "Consult Doctor" — and the cap is a layout constraint, not a preference: a third wraps
 * onto its own line and reads as a form.
 */
const ActionSchema = new mongoose.Schema({
    label: { type: String, required: true, maxlength: 24 },
    /** An in-app route. Validated on write; see `notificationCentre.publish`. */
    route: { type: String, required: true },
    tone: { type: String, enum: ['primary', 'secondary'], default: 'secondary' },
}, { _id: false });

const NotificationSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    category: { type: String, required: true, enum: CATEGORY_KEYS },

    title: { type: String, required: true, trim: true, maxlength: 80 },
    body: { type: String, required: true, trim: true, maxlength: 240 },

    /**
     * Where tapping the card goes. Defaults to the category's own route, so a producer that
     * has nothing more specific to offer still lands somewhere real.
     */
    route: { type: String, required: true },

    /**
     * Overrides the category's tint for this one card. Used where the *instance* carries a
     * meaning the category does not — an order that failed is still an order.
     */
    tint: { type: String, enum: TINTS, default: null },

    meter: { type: MeterSchema, default: null },
    chip: { type: ChipSchema, default: null },

    /**
     * An https URL, never a `file://` path and never bytes.
     *
     * The same guard `createMeal` puts on the nutrition gallery and `productController` on
     * a product cover: a picker path renders on the device that chose it and as a broken
     * square everywhere else, and the write succeeds either way.
     */
    imageUrl: { type: String, default: null },

    actions: {
        type: [ActionSchema],
        default: [],
        validate: [(v) => v.length <= 2, 'A notification carries at most two actions'],
    },

    /** Free-form payload for the deep link. Nothing renders it. */
    data: { type: mongoose.Schema.Types.Mixed, default: {} },

    /** Null until read. See rule 2 in the header. */
    readAt: { type: Date, default: null },

    /**
     * When a push for this row actually went out, and how many devices took it. Null means
     * the row exists and nothing was sent — quiet hours, a muted channel, or no device.
     */
    pushedAt: { type: Date, default: null },
    pushedTo: { type: Number, default: 0 },

    /** Why no push went out, when none did. Diagnostic only; never shown to anyone. */
    suppressedReason: {
        type: String,
        enum: ['quiet_hours', 'channel_off', 'no_device', 'send_failed', null],
        default: null,
    },

    dedupeKey: { type: String, default: null },

    /**
     * The producer. Not the category: two senders can write the same category, and when a
     * job starts duplicating it is the job that has to be identifiable.
     */
    source: { type: String, default: 'system', maxlength: 40 },

    expiresAt: {
        type: Date,
        default: () => new Date(Date.now() + RETENTION_DAYS * 86400000),
    },
}, { timestamps: true });

/** The feed query: this person's notifications, newest first, filtered by read state. */
NotificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });

/**
 * Re-running a producer must not produce a second card. Partial rather than sparse because
 * a compound sparse index still stores documents whose `dedupeKey` is null — only a partial
 * filter actually leaves the un-keyed rows out.
 */
NotificationSchema.index(
    { userId: 1, dedupeKey: 1 },
    { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } }
);

/** TTL. Mongo sweeps expired rows itself; nothing in the app has to remember to. */
NotificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Notification', NotificationSchema);
module.exports.RETENTION_DAYS = RETENTION_DAYS;
