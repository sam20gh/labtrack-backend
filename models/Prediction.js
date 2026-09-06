const mongoose = require('mongoose');

/**
 * One forecast, as it was shown to the person.
 *
 * Append-only, like `Interpretation` and `MedicationCheck`, and for a third reason on top of
 * theirs: **a prediction is the one kind of health output that can later be checked**. The
 * design's own hub prints "3 Metric Predicted / +25% Improvement", and neither figure means
 * anything unless what was predicted is still on record when the day it predicted arrives.
 * `resolution` is filled in then — it records what actually happened, which is not a rewrite
 * of what was said.
 *
 * A row is written per *run*. Re-running the same metric at the same horizon writes a second
 * row rather than editing the first, because the first is what somebody read, and a
 * prediction that silently updates is one nobody can be held to.
 *
 * The numbers here come from `utils/predictionForecast.js` and nothing else can write them.
 * `narrative` is the Claude half; `predictionEngine.mergeNarrative` is what keeps it from
 * contradicting the arithmetic.
 */

/** One fitted series. A pair metric like blood pressure carries two of these. */
const ComponentSchema = new mongoose.Schema({
    key: { type: String, required: true },
    label: { type: String, required: true },

    /** The forecast interval. `point` is never shown on its own — see rule 2 in the forecaster. */
    point: { type: Number, required: true },
    low: { type: Number, required: true },
    high: { type: Number, required: true },
    margin: { type: Number, required: true },

    /** The last measured value this was projected from, and the % move to `point`. */
    currentValue: { type: Number, default: null },
    changePct: { type: Number, default: null },

    direction: { type: String, enum: ['rising', 'falling', 'flat'], required: true },
    slopePerDay: { type: Number, default: 0 },
    confidence: { type: Number, required: true },

    /**
     * What the fit was actually standing on — sample count, span, scatter, how stale the
     * last reading was. Stored rather than derived so a prediction stays explainable after
     * the rows behind it have moved on, which is the argument `HealthScore` makes for
     * storing its pillars.
     */
    basis: { type: mongoose.Schema.Types.Mixed, default: undefined },
}, { _id: false });

/**
 * Written prose, and only prose.
 *
 * Every number in here was copied from `components` by `mergeNarrative`; the model is never
 * the source of one. `degraded` says the prose is the deterministic fallback because no
 * model was available — the same labelling `MedicationCheck.degraded` carries, and for the
 * same reason: losing the sentence is worse experience, losing the forecast would be a worse
 * outcome, so the forecast still runs.
 */
const NarrativeSchema = new mongoose.Schema({
    headline: { type: String },
    summary: { type: String },
    /** Short chips — "Consistent sleep", "Low stress biomarker". The design draws four. */
    keyFactors: [{ type: String }],
    suggestions: [{ type: String }],
    /**
     * Conditions the pattern is *associated* with. Never a diagnosis: `chance` is the
     * forecast's own confidence for the metric that raised it, and the copy says so.
     */
    risks: [{
        label: { type: String },
        detail: { type: String },
        risk: { type: String, enum: ['high', 'moderate', 'low'] },
        preventable: { type: Boolean, default: true },
        chance: { type: Number, default: null },
        _id: false,
    }],
    componentNotes: [{
        component: { type: String },
        note: { type: String },
        _id: false,
    }],
    degraded: { type: Boolean, default: false },
    model: { type: String, default: null },
}, { _id: false });

/**
 * What actually happened, filled in once the horizon has passed.
 *
 * `withinInterval` is the only honest measure of whether this feature works, and it is the
 * reason the interval is stored rather than only the point. Null until there is a measured
 * value on or after `targetDate` — an unresolved prediction is unresolved, never a miss.
 */
const ResolutionSchema = new mongoose.Schema({
    resolvedAt: { type: Date },
    actual: { type: Number, default: null },
    actualPair: { type: mongoose.Schema.Types.Mixed, default: undefined },
    /** Signed error, actual − point, in the metric's own unit. */
    error: { type: Number, default: null },
    absErrorPct: { type: Number, default: null },
    withinInterval: { type: Boolean, default: null },
    /** How the measured value moved against the last value the forecast stood on. */
    actualDirection: { type: String, enum: ['rising', 'falling', 'flat', null], default: null },
    directionCorrect: { type: Boolean, default: null },
}, { _id: false });

const PredictionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** A key in `utils/predictionMetrics.METRICS`. */
    metric: { type: String, required: true },
    metricLabel: { type: String, required: true },
    unit: { type: String, default: null },

    horizonDays: { type: Number, required: true },
    /** `1d` | `1w` | `1m` | `3m` | `1y` — the design's chip. */
    horizonId: { type: String, required: true },
    targetDate: { type: Date, required: true },

    components: { type: [ComponentSchema], default: [] },

    /**
     * The band the predicted value falls into, staged by the same table a measured value is
     * staged by — `bloodPressure.classify` for BP, `labtrackScore.bandFor` for the score.
     * Null for metrics that have no clinical band, which is most of them; a made-up band on
     * a step count would be the app inventing a target nobody set.
     */
    band: { type: mongoose.Schema.Types.Mixed, default: undefined },

    /** Worst-case confidence across the components, which is what the design's chip prints. */
    confidence: { type: Number, required: true },

    narrative: { type: NarrativeSchema, default: () => ({}) },
    resolution: { type: ResolutionSchema, default: undefined },

    /** Everything the app needs to redraw the chart without refitting. */
    series: {
        /** The measured history the fit stood on, oldest first. */
        history: { type: [{ day: String, value: Number, secondary: Number, _id: false }], default: [] },
        /** The projected path, day by day, with its interval. */
        projected: {
            type: [{
                day: String, value: Number, low: Number, high: Number,
                secondary: Number, secondaryLow: Number, secondaryHigh: Number, _id: false,
            }],
            default: [],
        },
    },

    generatedAt: { type: Date, default: Date.now, index: true },
}, { timestamps: true });

// The two access patterns: this person's predictions newest first (the hub and the past
// list), and everything due for resolution.
PredictionSchema.index({ userId: 1, generatedAt: -1 });
PredictionSchema.index({ userId: 1, metric: 1, generatedAt: -1 });
PredictionSchema.index({ targetDate: 1, 'resolution.resolvedAt': 1 });

module.exports = mongoose.model('Prediction', PredictionSchema);
