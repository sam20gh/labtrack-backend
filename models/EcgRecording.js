const mongoose = require('mongoose');

/**
 * One ECG or PPG measurement taken on a bracelet.
 *
 * Its own collection rather than a `MetricLog` kind, and the waveform is why: a single
 * trace is thousands of samples, and `MetricLog` is read a whole day at a time by the
 * rollup. Filing traces there would make every hydration recompute drag megabytes of
 * waveform through memory — the mistake `Plan.plan[]` made, and the one
 * `NutritionPlan`/`MealLog` were split to avoid.
 *
 * ## Nothing in Miovix interprets these
 *
 * Every derived figure below — heart rate, HRV, stress, blood pressure — is **the device's
 * own output**, stored as reported and never recomputed. There is no ECG engine here, and
 * writing one is a clinical and regulatory decision rather than a feature: an arrhythmia
 * claim needs evidence this app does not have. The same line the symptom checker holds when
 * it refuses to name a condition, and the line `bloodPressure.js` holds by being a
 * published table rather than a model.
 *
 * So a screen may draw the trace and print what the bracelet concluded, attributed to the
 * bracelet. It may not conclude anything itself.
 *
 * Append-only, like `Interpretation`, `Prediction` and `AchievementUnlock`. A measurement
 * is a record of what was captured at a moment; re-running it produces a new row.
 */

const EcgResultSchema = new mongoose.Schema({
    hrBpm: { type: Number, default: null },
    hrvMs: { type: Number, default: null },
    /** The vendor's own 0–100 stress index. Not a clinical measure and not presented as one. */
    stress: { type: Number, default: null },
    breathRate: { type: Number, default: null },
    systolic: { type: Number, default: null },
    diastolic: { type: Number, default: null },
    /**
     * The device's signal-quality score.
     *
     * Kept because it is the answer to "why does this trace look like noise" — a loose
     * strap produces a complete, plausible-looking recording with a quality score in the
     * teens. A screen that draws the trace without this has no way to say so.
     */
    quality: { type: Number, default: null },
}, { _id: false });

const EcgRecordingSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /**
     * Which sensor. They are not interchangeable.
     *
     * `ecg` is a single-lead electrical trace taken with a finger closing the circuit;
     * `ppg` is optical and measures blood volume. They look similar plotted and answer
     * different questions, and a screen that labelled one as the other would be making a
     * claim about the measurement it is showing.
     */
    kind: { type: String, enum: ['ecg', 'ppg'], required: true },

    /** Local calendar day, `YYYY-MM-DD`, from the client's `tzOffset`. */
    day: { type: String, required: true },
    measuredAt: { type: Date, required: true },

    /**
     * The waveform, in the vendor's own units.
     *
     * Not converted to millivolts: the vendor publishes no scale factor, and inventing one
     * would put a fabricated y-axis on something that looks like a clinical trace. A chart
     * drawn from these should be unitless and say so.
     */
    samples: { type: [Number], default: [] },
    sampleRateHz: { type: Number, default: null },
    durationSec: { type: Number, default: null },

    result: { type: EcgResultSchema, default: () => ({}) },

    source: { type: String, enum: ['bracelet'], default: 'bracelet' },
    /** Deterministic, built from device + kind + instant, so a re-sync upserts. */
    externalId: { type: String, default: null },
    sourceDevice: {
        name: { type: String },
        model: { type: String },
        manufacturer: { type: String },
    },
}, { timestamps: true });

// The access patterns: one person's recordings newest first, and one day's when a screen
// opens a date.
EcgRecordingSchema.index({ userId: 1, measuredAt: -1 });
EcgRecordingSchema.index({ userId: 1, day: 1 });
// What makes a re-sync idempotent. Sparse because a row written any other way has no
// external id, and a unique index over many nulls would reject the second one.
EcgRecordingSchema.index({ userId: 1, externalId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('EcgRecording', EcgRecordingSchema);
