const mongoose = require('mongoose');

/**
 * One night's sleep.
 *
 * The design's sleep detail screen draws a hypnogram — the banded chart showing which stage
 * the person was in through the night — so the segments are stored, not just the totals.
 * The totals are derived from the segments when they are present, which keeps the chart and
 * the numbers underneath it from ever disagreeing.
 *
 * `day` is the **wake** day, not the day the person went to bed.
 *
 * A night that begins 23:40 on Tuesday and ends 07:10 on Wednesday is Wednesday's sleep.
 * That is the row someone taps on Wednesday morning, the figure Wednesday's dashboard ring
 * shows, and the value the sleep score for Wednesday is computed from. Filing it under
 * Tuesday would mean the dashboard is empty every morning until you go to bed again.
 */

/** One contiguous stretch in one stage. Drawn directly as a band on the hypnogram. */
const StageSegmentSchema = new mongoose.Schema({
    stage: {
        type: String,
        enum: ['awake', 'light', 'deep', 'rem', 'in_bed', 'unknown'],
        required: true,
    },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, required: true },
}, { _id: false });

/** Minutes per stage. Null means the source never reported that stage, which is not zero. */
const StagesSchema = new mongoose.Schema({
    deepMin: { type: Number, default: null },
    remMin: { type: Number, default: null },
    lightMin: { type: Number, default: null },
    awakeMin: { type: Number, default: null },
}, { _id: false });

/** How the night sits against the sleep advice on the person's health plan. See ActivitySession. */
const AnalysisSchema = new mongoose.Schema({
    alignment: {
        type: String,
        enum: ['aligned', 'partial', 'off_plan', 'unassessed'],
        default: 'unassessed',
    },
    rationale: { type: String },
    guidanceKeys: [{ type: String }],
    model: { type: String },
}, { _id: false });

const SleepSessionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    startedAt: { type: Date, required: true, index: true },
    endedAt: { type: Date, required: true },

    /** Local calendar day of `endedAt` — the wake day. See the note above. */
    day: { type: String, required: true, index: true },

    /** Time actually asleep. Excludes awake segments when the source reports them. */
    asleepMin: { type: Number, required: true, min: 0 },
    /** Time between getting into and out of bed, when the source distinguishes the two. */
    inBedMin: { type: Number, min: 0 },

    stages: { type: StagesSchema, default: () => ({}) },
    segments: [StageSegmentSchema],

    /** 0–100, asleep over in-bed. Null unless both are known — never assumed to be 100. */
    efficiency: { type: Number, min: 0, max: 100, default: null },

    /**
     * 0–100, computed server-side from duration against the person's goal, efficiency, and
     * stage balance.
     *
     * The design bands this as Good / Suboptimal / **Insomniac**. That last label does not
     * ship: insomnia is a clinical diagnosis and this number is arithmetic over hours slept.
     * The bands are named in `utils/sleepScore.js` and the bottom one is "Needs attention".
     */
    score: { type: Number, min: 0, max: 100, default: null },

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

    analysis: { type: AnalysisSchema, default: undefined },

    /** Points this night contributed. Server-computed, like ActivitySession.scoreDelta. */
    scoreDelta: { type: Number, default: 0 },

    notes: { type: String },
}, { timestamps: true });

// De-duplication. Partial for the same reason as ActivitySession: manual nights carry no id.
SleepSessionSchema.index(
    { userId: 1, source: 1, externalId: 1 },
    { unique: true, partialFilterExpression: { externalId: { $type: 'string' } } }
);

SleepSessionSchema.index({ userId: 1, day: 1 });
SleepSessionSchema.index({ userId: 1, endedAt: -1 });

module.exports = mongoose.model('SleepSession', SleepSessionSchema);
