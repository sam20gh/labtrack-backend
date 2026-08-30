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

/**
 * Body measurements the health store reports, or the person logs on the weight screen.
 *
 * One row a day rather than a series: weighing yourself four times in a morning is four
 * readings of one fact, and the trend chart wants the day. A later reading replaces the
 * day's value rather than averaging with it — the most recent measurement is the one the
 * person would recognise, and a mean of a clothed and an unclothed weigh-in is neither.
 *
 * Nulls, not zeros. A day nobody stood on a scale is unknown, and a zero here would draw a
 * weight chart through the floor.
 */
const BodyTotalsSchema = new mongoose.Schema({
    weightKg: { type: Number, default: null },
    /** Percent, where the scale reports it. */
    bodyFatPct: { type: Number, default: null },
    leanMassKg: { type: Number, default: null },
    /** `healthkit` | `health_connect` | `manual` — provenance travels with the measurement. */
    weightSource: { type: String, default: null },
    measuredAt: { type: Date, default: null },
}, { _id: false });

/**
 * Water logged that day, and the target it was measured against.
 *
 * `targetMl` is stored rather than recomputed on read because the target moves with body mass
 * and with the day's recorded activity — so a Tuesday in March had a different target from
 * today, and a history chart that redraws every bar against today's number tells someone they
 * missed goals they actually met.
 *
 * `logs` is the count, and it is what separates "drank nothing" from "did not use the app".
 * Zero ml with zero logs is an unknown day; zero ml with logs is not possible, which is the
 * point of keeping both.
 */
const HydrationTotalsSchema = new mongoose.Schema({
    consumedMl: { type: Number, default: null },
    targetMl: { type: Number, default: null },
    logs: { type: Number, default: 0 },
    /** The design's five-level ladder, resolved at rollup time. Null on a day with no logs. */
    level: { type: String, default: null },
}, { _id: false });

/**
 * Blood-pressure readings for the day.
 *
 * The **mean** is stored for the trend, and the **worst** category seen is stored beside it,
 * because a day averaging out to normal with one crisis reading in it is not a normal day and
 * an average is precisely the operation that hides that. `utils/bloodPressure.summarise`
 * makes the same pairing for the same reason.
 */
const BloodPressureTotalsSchema = new mongoose.Schema({
    systolic: { type: Number, default: null },
    diastolic: { type: Number, default: null },
    pulse: { type: Number, default: null },
    readings: { type: Number, default: 0 },
    /** Category of the day's mean reading. */
    category: { type: String, default: null },
    /** Worst category seen that day, which may be worse than the mean's. */
    worstCategory: { type: String, default: null },
}, { _id: false });

const DailyMetricsSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** Local calendar day, `YYYY-MM-DD`. */
    day: { type: String, required: true },

    activity: { type: ActivityTotalsSchema, default: () => ({}) },
    sleep: { type: SleepTotalsSchema, default: () => ({}) },
    heart: { type: HeartTotalsSchema, default: () => ({}) },
    body: { type: BodyTotalsSchema, default: () => ({}) },
    hydration: { type: HydrationTotalsSchema, default: () => ({}) },
    bloodPressure: { type: BloodPressureTotalsSchema, default: () => ({}) },

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
