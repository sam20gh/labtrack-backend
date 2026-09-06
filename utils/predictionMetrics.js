/**
 * What LabTrack can predict, where each number comes from, and how a forecast of it is read.
 *
 * One registry rather than a branch per metric in the controller, for the reason
 * `MetricLog` gives about weight/water/blood pressure being one collection: the shape is
 * genuinely shared — a person, a horizon, a series, a unit, a band — and the alternative is
 * eight near-identical gatherers that drift.
 *
 * ── Three things that are deliberate ──────────────────────────────────────────────────
 *
 * 1. **Every series is read from the rollup, not recomputed.** `DailyMetrics` is already the
 *    one row per person per local day that `metricRollup` maintains, and the score, the
 *    metric screens and this all read the same rows. A forecast computed off a different
 *    aggregation of the same events is a forecast that can disagree with the chart above it.
 *    `turing_score` is the exception and reads `HealthScore` snapshots, which are that
 *    metric's rollup.
 *
 * 2. **`betterWhen` is not decoration.** It decides whether a rising forecast is drawn in the
 *    design's green or its red, and getting it backwards would congratulate somebody on a
 *    climbing blood pressure. It is `null` where there is no such thing as a better
 *    direction — weight has no universally good direction and the app must not imply one.
 *
 * 3. **A metric can have two components.** Blood pressure is a pair and the design prints it
 *    as one ("126/96 mmHg ± 5"), so a forecast of it is two fits reported together rather
 *    than two predictions. The worse of the two decides the band, which is the rule
 *    `bloodPressure.classify` already holds for the same reason: 118/92 is stage 2 on its
 *    diastolic alone.
 */
const mongoose = require('mongoose');
const DailyMetrics = require('../models/DailyMetrics');
const HealthScore = require('../models/HealthScore');
const MealLog = require('../models/MealLog');
const bloodPressure = require('./bloodPressure');
const { BANDS, bandFor } = require('./labtrackScore');

/** How far back a gatherer looks. A year is plenty: the fit weights recency anyway. */
const LOOKBACK_DAYS = 365;

const oid = (id) => new mongoose.Types.ObjectId(String(id));

const since = (days) => {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
};

/** Pull one field out of the daily rollup as an observation series. */
const fromDaily = (path) => async (userId) => {
    const rows = await DailyMetrics.find({ userId, day: { $gte: since(LOOKBACK_DAYS) } })
        .select(`day ${path}`).sort({ day: 1 }).lean();

    return rows
        .map((r) => ({ day: r.day, value: path.split('.').reduce((o, k) => (o ?? {})[k], r) ?? null }))
        .filter((o) => o.value !== null);
};

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

const METRICS = {
    /**
     * The LabTrack score itself. The kit calls it the "Turing Score" throughout, which is the
     * design system's name and not the product's — everything user-facing says LabTrack. It
     * gets its own screen with a min/average/max band rather than a single line.
     *
     * Reads `HealthScore` snapshots, which are written at most once every six hours, so a
     * heavy app user does not get a denser series than someone who opens it twice a week.
     */
    turing_score: {
        key: 'turing_score',
        label: 'LabTrack Score',
        shortLabel: 'Score',
        unit: 'pts',
        icon: 'medkit',
        decimals: 0,
        bounds: [0, 100],
        betterWhen: 'rising',
        /** The design's own horizon chips on the score screen. */
        horizons: [1, 7, 30, 365],
        gather: async (userId) => {
            const rows = await HealthScore.find({
                userId,
                value: { $ne: null },
                computedAt: { $gte: new Date(Date.now() - LOOKBACK_DAYS * 86400000) },
            }).select('value computedAt').sort({ computedAt: 1 }).lean();
            return rows.map((r) => ({ at: r.computedAt, value: r.value }));
        },
        band: (value) => {
            const b = bandFor(value);
            return b ? { key: b.key, label: b.label, detail: b.description } : null;
        },
    },

    /**
     * Blood pressure — two fits, one reading.
     *
     * The band is `bloodPressure.classify` on the predicted pair, so a forecast is staged by
     * exactly the table a measured reading is staged by, and the app can never show a
     * predicted 126/96 as "Normal" while a logged 126/96 shows as stage 1.
     */
    blood_pressure: {
        key: 'blood_pressure',
        label: 'Blood Pressure',
        shortLabel: 'BP',
        unit: 'mmHg',
        icon: 'heart',
        decimals: 0,
        bounds: [40, 260],
        betterWhen: 'falling',
        horizons: [1, 7, 30],
        components: [
            { key: 'systolic', label: 'Systolic', path: 'bloodPressure.systolic' },
            { key: 'diastolic', label: 'Diastolic', path: 'bloodPressure.diastolic' },
        ],
        gather: fromDaily('bloodPressure.systolic'),
        gatherComponent: (path) => fromDaily(path),
        /** `values` is `{ systolic, diastolic }` — the pair, staged together. */
        band: (_v, values) => {
            if (!values || !Number.isFinite(values.systolic) || !Number.isFinite(values.diastolic)) return null;
            const c = bloodPressure.classify(values.systolic, values.diastolic);
            return c
                ? { key: c.key, label: c.label, detail: c.summary, crisis: Boolean(c.isCrisis), driver: c.driver }
                : null;
        },
        format: (values) => `${Math.round(values.systolic)}/${Math.round(values.diastolic)}`,
        /**
         * Blood pressure is the one metric here that can name an emergency, so the note that
         * travels with every classification travels with every forecast of it too.
         */
        safetyNote: bloodPressure.SAFETY_NOTE,
    },

    weight: {
        key: 'weight',
        label: 'Weight',
        shortLabel: 'Weight',
        unit: 'kg',
        icon: 'barbell',
        decimals: 1,
        bounds: [25, 400],
        // Deliberately null. There is no direction a weight forecast should be congratulated
        // for, and colouring one green would make the app take a view on somebody's body.
        betterWhen: null,
        horizons: [7, 30, 90],
        gather: fromDaily('body.weightKg'),
    },

    sleep: {
        key: 'sleep',
        label: 'Sleep',
        shortLabel: 'Sleep',
        unit: 'h',
        icon: 'moon',
        decimals: 1,
        bounds: [0, 16],
        betterWhen: 'rising',
        horizons: [1, 7, 30],
        gather: async (userId) => {
            const rows = await DailyMetrics.find({ userId, day: { $gte: since(LOOKBACK_DAYS) } })
                .select('day sleep.durationMin').sort({ day: 1 }).lean();
            return rows
                .filter((r) => Number.isFinite(r.sleep?.durationMin))
                .map((r) => ({ day: r.day, value: r.sleep.durationMin / 60 }));
        },
    },

    calories: {
        key: 'calories',
        label: 'Calorie',
        shortLabel: 'Calories',
        unit: 'kcal',
        icon: 'flame',
        decimals: 0,
        bounds: [0, 8000],
        // Eating more is not better and eating less is not better; the plan decides, and the
        // nutrition tracker is where that comparison belongs.
        betterWhen: null,
        horizons: [1, 7, 30],
        gather: async (userId) => {
            const rows = await MealLog.aggregate([
                { $match: { userId: oid(userId), day: { $gte: since(LOOKBACK_DAYS) } } },
                { $group: { _id: '$day', value: { $sum: '$calories' } } },
                { $sort: { _id: 1 } },
            ]);
            return rows.map((r) => ({ day: r._id, value: r.value }));
        },
    },

    resting_heart_rate: {
        key: 'resting_heart_rate',
        label: 'Resting Heart Rate',
        shortLabel: 'Resting HR',
        unit: 'bpm',
        icon: 'pulse',
        decimals: 0,
        bounds: [30, 160],
        betterWhen: 'falling',
        horizons: [1, 7, 30],
        gather: fromDaily('heart.restingBpm'),
    },

    steps: {
        key: 'steps',
        label: 'Steps',
        shortLabel: 'Steps',
        unit: 'steps',
        icon: 'footsteps',
        decimals: 0,
        bounds: [0, 100000],
        betterWhen: 'rising',
        horizons: [1, 7, 30],
        gather: fromDaily('activity.steps'),
    },

    hydration: {
        key: 'hydration',
        label: 'Hydration',
        shortLabel: 'Water',
        unit: 'ml',
        icon: 'water',
        decimals: 0,
        bounds: [0, 8000],
        betterWhen: 'rising',
        horizons: [1, 7, 30],
        gather: fromDaily('hydration.consumedMl'),
    },
};

const METRIC_KEYS = Object.keys(METRICS);

const get = (key) => METRICS[key] || null;

/**
 * Gather every series a metric needs, keyed by component.
 *
 * A single-component metric comes back as `{ value: [...] }` so callers do not have to
 * branch on whether the metric happens to be a pair.
 */
const gatherSeries = async (metric, userId) => {
    if (!metric.components) return { value: await metric.gather(userId) };

    const out = {};
    for (const c of metric.components) {
        out[c.key] = await metric.gatherComponent(c.path)(userId);
    }
    return out;
};

/**
 * Which horizons this metric offers, expressed the way the design's chips read.
 *
 * The label is what the person sees ("Next 1w"); the days are what the forecast uses.
 */
const HORIZON_LABELS = {
    1: { id: '1d', label: 'Next 1d', long: 'the next day' },
    7: { id: '1w', label: 'Next 1w', long: 'the next 1 week' },
    30: { id: '1m', label: 'Next 1m', long: 'the next month' },
    90: { id: '3m', label: 'Next 3m', long: 'the next 3 months' },
    365: { id: '1y', label: 'Next 1y', long: 'the next year' },
};

const horizonById = (id) => {
    const entry = Object.entries(HORIZON_LABELS).find(([, v]) => v.id === id);
    return entry ? Number(entry[0]) : null;
};

module.exports = {
    METRICS,
    METRIC_KEYS,
    HORIZON_LABELS,
    LOOKBACK_DAYS,
    get,
    gatherSeries,
    horizonById,
};
