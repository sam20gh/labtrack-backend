/**
 * Rebuilding a day's manual-metric rollups from the rows behind them.
 *
 * The counterpart to `healthSync.recomputeDay`, and it follows the same two rules for the same
 * reasons that file states at length:
 *
 * 1. **Rebuilt, never incremented.** Adding to a counter on write is how a rollup drifts away
 *    from the data it claims to summarise, and there is no way to tell someone their water
 *    total is wrong because a request was retried or a log was deleted.
 * 2. **Nulls, not zeros.** A day nobody weighed themselves is unknown, and a zero would draw
 *    a weight chart through the floor.
 *
 * Called after every write and every delete on `MetricLog`.
 */
const MetricLog = require('../models/MetricLog');
const DailyMetrics = require('../models/DailyMetrics');
const User = require('../models/userModel');
const bp = require('./bloodPressure');
const hydration = require('./hydrationTargets');

/**
 * The day's water target.
 *
 * Read from the measured weight where there is one, and topped up by the exercise minutes the
 * activity tracker already rolled up for that day — so a training day asks for more without
 * the person telling it anything.
 */
const targetForDay = async (userId, day, existing) => {
    const user = await User.findById(userId).select('observed.weightKg weight').lean();
    // The measured weight first, the onboarding figure as a fallback. Same precedence the
    // score applies, and for the same reason.
    const weightKg = user?.observed?.weightKg ?? user?.weight ?? null;
    const exerciseMin = existing?.activity?.exerciseMin ?? 0;
    return hydration.computeTarget({ weightKg, exerciseMin });
};

/**
 * Recompute one person's `body`, `hydration` and `bloodPressure` totals for one local day.
 *
 * Returns the updated document. Safe to call repeatedly with no change in outcome.
 */
const recomputeMetricDay = async (userId, day) => {
    const [logs, existing] = await Promise.all([
        MetricLog.find({ userId, day }).lean(),
        DailyMetrics.findOne({ userId, day }).lean(),
    ]);

    const weights = logs.filter((l) => l.kind === 'weight' && Number.isFinite(l.weightKg));
    const waters = logs.filter((l) => l.kind === 'water' && Number.isFinite(l.ml));
    const pressures = logs.filter((l) => l.kind === 'blood_pressure');

    // ── body ────────────────────────────────────────────────────────────────
    // The *latest* weigh-in of the day wins rather than the mean. A clothed and an unclothed
    // reading averaged together is neither, and the most recent is the one the person would
    // recognise as their weight.
    const newestWeight = weights.sort(
        (a, b) => new Date(b.measuredAt) - new Date(a.measuredAt),
    )[0] || null;

    const body = newestWeight
        ? {
            weightKg: newestWeight.weightKg,
            bodyFatPct: newestWeight.bodyFatPct ?? null,
            leanMassKg: existing?.body?.leanMassKg ?? null,
            weightSource: newestWeight.source,
            measuredAt: newestWeight.measuredAt,
        }
        : { weightKg: null, bodyFatPct: null, leanMassKg: null, weightSource: null, measuredAt: null };

    // ── hydration ───────────────────────────────────────────────────────────
    const consumedMl = waters.reduce((s, l) => s + l.ml, 0);
    const target = await targetForDay(userId, day, existing);
    const level = hydration.levelFor(consumedMl, target.ml, { logs: waters.length });

    const hydrationTotals = {
        consumedMl: waters.length ? consumedMl : null,
        targetMl: target.ml,
        logs: waters.length,
        level: level?.key ?? null,
    };

    // ── blood pressure ──────────────────────────────────────────────────────
    const summary = bp.summarise(pressures);
    const bloodPressure = summary
        ? {
            systolic: summary.mean.systolic,
            diastolic: summary.mean.diastolic,
            pulse: summary.meanPulse,
            readings: summary.readings,
            category: summary.mean.category?.key ?? null,
            worstCategory: summary.worst?.category?.key ?? null,
        }
        : { systolic: null, diastolic: null, pulse: null, readings: 0, category: null, worstCategory: null };

    return DailyMetrics.findOneAndUpdate(
        { userId, day },
        { $set: { body, hydration: hydrationTotals, bloodPressure, recomputedAt: new Date() } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );
};

module.exports = { recomputeMetricDay, _targetForDay: targetForDay };
