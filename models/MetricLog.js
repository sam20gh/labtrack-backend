const mongoose = require('mongoose');

/**
 * One thing a person entered by hand: a weigh-in, a glass of water, a blood-pressure reading.
 *
 * Separate from `DailyMetrics` for the same reason `ActivitySession` is: that is a rollup,
 * rebuilt from its rows, and this is the row. The design's history screens list individual
 * entries with times and a swipe-to-delete, which a day total cannot answer — and deleting a
 * mistyped reading has to actually remove it rather than adjust a counter, or the record no
 * longer matches what the person sees.
 *
 * One collection rather than three because the shape is genuinely shared — a person, a kind,
 * a moment, a value, a source — and the alternative is three near-identical models plus three
 * near-identical controllers. `value` is discriminated by `kind`, and the controller validates
 * per kind before writing.
 *
 * **This is the source of truth until a health store is wired.** `healthSync` will eventually
 * write body mass from HealthKit and Health Connect; when it does, those rows land here too
 * with `source` set accordingly and `externalId` carrying the store's UUID, so a re-sync
 * upserts rather than duplicating — the rule `healthSync` already documents.
 */

const MetricLogSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    kind: {
        type: String,
        required: true,
        enum: ['weight', 'water', 'blood_pressure'],
    },

    /** Local calendar day, `YYYY-MM-DD`, written from the client's `tzOffset`. */
    day: { type: String, required: true },
    measuredAt: { type: Date, required: true, default: Date.now },

    // ── weight ──────────────────────────────────────────────────────────────
    weightKg: { type: Number, default: null },
    bodyFatPct: { type: Number, default: null },

    // ── water ───────────────────────────────────────────────────────────────
    /** Millilitres. Always stored in ml however the client asked for it. */
    ml: { type: Number, default: null },
    drinkType: { type: String, default: null },
    container: { type: String, default: null },

    // ── blood pressure ──────────────────────────────────────────────────────
    systolic: { type: Number, default: null },
    diastolic: { type: Number, default: null },
    /** Optional on the design's log screen, so optional here. */
    pulse: { type: Number, default: null },
    /**
     * The category `utils/bloodPressure.classify` gave this reading **at the time it was
     * taken**, stored rather than derived on read.
     *
     * Deliberate: the thresholds are a clinical guideline and guidelines are revised. A
     * reading someone was shown as "Normal" in 2026 must keep saying what they were told,
     * not silently restage itself into hypertension because the table moved underneath it.
     * Same reasoning `HealthScore` stores its pillars instead of recomputing them.
     */
    category: { type: String, default: null },

    // ── provenance ──────────────────────────────────────────────────────────
    source: {
        type: String,
        enum: ['manual', 'healthkit', 'health_connect', 'device'],
        default: 'manual',
    },
    /** The health store's own UUID, where one exists. Null for anything typed by a person. */
    externalId: { type: String, default: null },

    note: { type: String, default: null },
}, { timestamps: true });

// The access patterns: one person's history of one kind, newest first; and one day's rows
// when a rollup is rebuilt.
MetricLogSchema.index({ userId: 1, kind: 1, measuredAt: -1 });
MetricLogSchema.index({ userId: 1, kind: 1, day: 1 });

/**
 * De-duplication for synced rows.
 *
 * Sparse and partial so it constrains only rows that carry an `externalId` — a person can log
 * three glasses of water in a minute and each is a real, separate entry.
 */
MetricLogSchema.index(
    { userId: 1, kind: 1, externalId: 1 },
    { unique: true, partialFilterExpression: { externalId: { $type: 'string' } } },
);

module.exports = mongoose.model('MetricLog', MetricLogSchema);
