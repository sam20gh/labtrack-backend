const mongoose = require('mongoose');

/**
 * One heart-rate reading.
 *
 * This is the highest-volume collection in the app by a wide margin: a watch worn all day
 * produces a reading every few seconds, which is hundreds of thousands of rows per person
 * per year. Storing all of it would be a bill with no reader — nothing in the design plots
 * a raw sample stream, and the screens that exist need daily minimum, maximum, average,
 * resting and zone minutes, all of which live in `DailyMetrics`.
 *
 * So the sync deliberately does **not** upload raw wearable samples. The client aggregates
 * them on the device and posts the day's summary. What lands here is only:
 *
 *   - readings the person entered themselves (`context: 'manual'`), which they expect to
 *     see listed back verbatim, and
 *   - representative readings the source labelled — a resting figure, a workout average,
 *     a post-exercise recovery reading — which is what the history list actually renders.
 *
 * `context` is what makes the number meaningful. 130 bpm during a run and 130 bpm sitting
 * still are the same integer and completely different facts, and the history screen shows
 * them in one list.
 */
const HeartRateSampleSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    measuredAt: { type: Date, required: true, index: true },
    /** Local calendar day of `measuredAt`, `YYYY-MM-DD`. */
    day: { type: String, required: true, index: true },

    bpm: { type: Number, required: true, min: 20, max: 300 },

    context: {
        type: String,
        enum: ['resting', 'active', 'recovery', 'sleeping', 'manual', 'unknown'],
        default: 'unknown',
        index: true,
    },

    /**
     * Where the person was when they took it, for a manual reading.
     * Free text and optional — the design's manual log has a notes field.
     */
    notes: { type: String },

    source: {
        type: String,
        enum: ['healthkit', 'health_connect', 'manual', 'aggregator'],
        required: true,
    },
    externalId: { type: String, default: null },
    sourceDevice: {
        name: { type: String },
        model: { type: String },
        manufacturer: { type: String },
    },

    /** Set when this reading belongs to a workout, so the detail screen can link back. */
    activitySessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ActivitySession' },
}, { timestamps: true });

HeartRateSampleSchema.index(
    { userId: 1, source: 1, externalId: 1 },
    { unique: true, partialFilterExpression: { externalId: { $type: 'string' } } }
);

// The history list and the range charts
HeartRateSampleSchema.index({ userId: 1, measuredAt: -1 });

module.exports = mongoose.model('HeartRateSample', HeartRateSampleSchema);
