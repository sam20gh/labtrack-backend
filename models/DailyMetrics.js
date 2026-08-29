const mongoose = require('mongoose');

/**
 * One person's rolled-up numbers for one local calendar day, across all three trackers.
 *
 * Every dashboard in the three designs is a chart over days — the activity area chart, the
 * calendar ring grid, the sleep-score trend, the resting-heart-rate range chart. Computing
 * those by aggregating raw samples on each screen open would mean scanning a year of
 * workouts and heart-rate readings per request. This is one indexed read per range instead.
 *
 * It is a cache with a source of truth behind it (`ActivitySession`, `SleepSession`,
 * `HeartRateSample`) and it is rebuilt, not patched: `recomputeDay()` in `utils/healthSync`
 * recalculates a day from its rows whenever any of them change. Incrementing counters on
 * write is how a rollup drifts away from the data it claims to summarise, and a person
 * cannot be told their step count is wrong because a sync was retried.
 *
 * `day` is a local `YYYY-MM-DD`, written from the client's `tzOffset` — the same rule
 * `MealLog.day` follows, for the same reason.
 */

/** Minutes in each sleep stage. Nulls, not zeros: a band that was never reported is unknown. */
const SleepTotalsSchema = new mongoose.Schema({
    inBedMin: { type: Number, default: null },
    asleepMin: { type: Number, default: null },
    deepMin: { type: Number, default: null },
    remMin: { type: Number, default: null },
    lightMin: { type: Number, default: null },
    awakeMin: { type: Number, default: null },
    /** 0–100. Time asleep over time in bed, when both are known. */
    efficiency: { type: Number, default: null },
    /** The night's computed score, copied from the SleepSession so trends are one read. */
    score: { type: Number, default: null },
    sessions: { type: Number, default: 0 },
}, { _id: false });

const HeartTotalsSchema = new mongoose.Schema({
    restingBpm: { type: Number, default: null },
    minBpm: { type: Number, default: null },
    maxBpm: { type: Number, default: null },
    avgBpm: { type: Number, default: null },
    /** Milliseconds, SDNN or the platform's equivalent. */
    hrvMs: { type: Number, default: null },
    /** Minutes spent in each zone index 1..5, computed from the person's zone boundaries. */
    zoneMinutes: { type: [Number], default: undefined },
    samples: { type: Number, default: 0 },
}, { _id: false });

const ActivityTotalsSchema = new mongoose.Schema({
    steps: { type: Number, default: null },
    activeKcal: { type: Number, default: null },
    restingKcal: { type: Number, default: null },
    exerciseMin: { type: Number, default: null },
    distanceM: { type: Number, default: null },
    floors: { type: Number, default: null },
    /** Workouts logged that day, and the score they contributed. */
    sessions: { type: Number, default: 0 },
    score: { type: Number, default: null },
}, { _id: false });

const DailyMetricsSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** Local calendar day, `YYYY-MM-DD`. */
    day: { type: String, required: true },

    activity: { type: ActivityTotalsSchema, default: () => ({}) },
    sleep: { type: SleepTotalsSchema, default: () => ({}) },
    heart: { type: HeartTotalsSchema, default: () => ({}) },

    /**
     * Whole-day figures the health store reports directly (steps, resting energy) rather
     * than deriving from sessions. Recorded so a later sync can tell "we were never told"
     * apart from "it was genuinely zero" — an unworn watch and a still day look identical
     * in the totals and are not the same thing.
     */
    reportedAt: { type: Date },
    recomputedAt: { type: Date },
}, { timestamps: true });

// The only access pattern: one person, a range of days, in order.
DailyMetricsSchema.index({ userId: 1, day: 1 }, { unique: true });

module.exports = mongoose.model('DailyMetrics', DailyMetricsSchema);
