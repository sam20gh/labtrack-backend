/**
 * Predictive health analysis.
 *
 * ```
 * DailyMetrics / HealthScore / MealLog        the person's own measurements
 *   → predictionMetrics.gatherSeries()        one registry entry per predictable metric
 *   → predictionForecast.project()            weighted regression + interval  ← THE NUMBERS
 *   → metric.band(...)                        staged by the same table a reading is staged by
 *   → predictionEngine.narrate()              Opus 5 writes the prose  ← ONLY THE PROSE
 *   → mergeNarrative()                        the model can never change a figure
 *   → Prediction                              append-only
 *   → resolve()                               what actually happened, once the day arrives
 * ```
 *
 * Four things to know before changing anything here:
 *
 * 1. **A prediction is written per run, never updated.** Re-running the same metric writes a
 *    second row. The first is what somebody read, and the hub's "Past Predictions" list is
 *    only meaningful if it holds what was actually said at the time.
 * 2. **Refusals carry a reason, not a false answer.** `explainRefusal` produces the sentence
 *    the design's "We don't have enough data" modal prints. A metric with two readings does
 *    not get a wider interval; it gets no prediction.
 * 3. **Resolution is lazy and idempotent.** Nothing sweeps: a due prediction is resolved the
 *    next time the person's list is read. That is enough for a feature whose only consumer is
 *    the person themselves, and it avoids a job that would touch every account nightly to
 *    discover that almost none of them have anything due.
 * 4. **The accuracy figures are null, never zero.** No resolved predictions means "nothing to
 *    measure", not "we are never right" — the distinction `alignment: 'unassessed'` and
 *    `medicationSchedule.adherence` both make.
 */
const mongoose = require('mongoose');
const Prediction = require('../models/Prediction');
const DailyMetrics = require('../models/DailyMetrics');
const HealthScore = require('../models/HealthScore');
const PlanItem = require('../models/PlanItem');
const Professional = require('../models/Professional');
const User = require('../models/userModel');
const Medication = require('../models/Medication');

const forecaster = require('../utils/predictionForecast');
const registry = require('../utils/predictionMetrics');
const engine = require('../utils/predictionEngine');
const { HORIZON_LABELS } = registry;

/** How many predictions the hub and the past list carry. */
const RECENT_LIMIT = 20;

/** How many clinicians the recommendation rail draws. */
const PROFESSIONAL_LIMIT = 6;

/**
 * The disclaimer that travels with every prediction, on every route.
 *
 * The same call `SAFETY_FOOTER` makes in the medication checker and `SCORE_DISCLAIMER` makes
 * on the score: this is an extrapolation from a handful of a person's own readings, and a
 * screen that shows a number for next week without saying that has said something the
 * arithmetic does not support.
 */
const PREDICTION_DISCLAIMER =
    'Predictions are projected from your own recorded readings using a statistical model. '
    + 'They are not a diagnosis, not a measurement, and not a substitute for clinical advice.';

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

const fail = (res, status, message, extra = {}) => res.status(status).json({ message, ...extra });

/**
 * The headline, written deterministically.
 *
 * Used verbatim when no model is available, and as the fallback when the model's headline
 * turns out to contain a figure the forecast does not — see `inventsFigure`.
 */
const buildHeadline = (metric, horizonDays, forecast, band) => {
    const horizon = HORIZON_LABELS[horizonDays] || { long: `the next ${horizonDays} days` };
    const value = metric.format
        ? metric.format(Object.fromEntries(forecast.components.map((c) => [c.key, c.point])))
        : String(forecast.components[0].point);
    const unit = metric.unit ? ` ${metric.unit}` : '';

    const dir = forecast.components[0].direction;
    const verb = dir === 'rising' ? 'rise to' : dir === 'falling' ? 'fall to' : 'hold near';

    const opener = horizon.long.startsWith('the next')
        ? `In ${horizon.long.replace('the next ', '')}`
        : `Over ${horizon.long}`;

    return `${opener}, your ${metric.label.toLowerCase()} is projected to ${verb} ${value}${unit}`
        + `${band?.crisis ? ' — seek medical care now' : ''}.`;
};

/** Everything the narrative prompt is allowed to know about the person, and nothing more. */
const gatherProfile = async (userId) => {
    const [user, medications, planItems] = await Promise.all([
        User.findById(userId).select('dob gender healthAssessment.conditions observed').lean(),
        Medication.find({ userId, archivedAt: null }).select('name').limit(20).lean(),
        PlanItem.find({ userId, type: 'lifestyle' }).select('title condition').limit(8).lean(),
    ]);

    const age = user?.dob
        ? Math.floor((Date.now() - new Date(user.dob).getTime()) / (365.25 * 86400000))
        : null;

    return {
        age: Number.isFinite(age) && age > 0 && age < 130 ? age : null,
        gender: user?.gender || null,
        conditions: (user?.healthAssessment?.conditions || [])
            .map((c) => (typeof c === 'string' ? c : c?.name))
            .filter(Boolean)
            .slice(0, 10),
        medications: (medications || []).map((m) => m.name).filter(Boolean),
        planAdvice: (planItems || []).map((p) => p.title).filter(Boolean),
    };
};

/**
 * Run the forecast for one metric at one horizon.
 *
 * Returns either `{ ok: true, forecast, band, series }` or `{ ok: false, refusal }` — never a
 * partial answer. `refusal` is the sentence the client renders.
 */
const runForecast = async (metric, userId, horizonDays) => {
    const series = await registry.gatherSeries(metric, userId);
    const keys = Object.keys(series);

    const components = [];
    for (const key of keys) {
        const observations = series[key];
        const projection = forecaster.project(observations, {
            horizonDays,
            decimals: metric.decimals,
            bounds: metric.bounds,
        });

        if (!projection) {
            return {
                ok: false,
                refusal: {
                    metric: metric.key,
                    component: key,
                    ...forecaster.explainRefusal(observations, horizonDays),
                },
            };
        }

        const label = metric.components?.find((c) => c.key === key)?.label || metric.label;
        components.push({
            key,
            label,
            point: projection.point,
            low: projection.low,
            high: projection.high,
            margin: projection.margin,
            currentValue: projection.basis.lastValue,
            changePct: projection.changePct,
            direction: projection.direction,
            slopePerDay: projection.slopePerDay,
            confidence: projection.confidence,
            basis: projection.basis,
            days: projection.days,
            history: observations,
        });
    }

    // The worst component decides. Same argument `bloodPressure.classify` makes with
    // `match: 'either'`: a pair is only as trustworthy as its weaker half.
    const confidence = Math.min(...components.map((c) => c.confidence));

    const values = Object.fromEntries(components.map((c) => [c.key, c.point]));
    const band = metric.band ? metric.band(components[0].point, values) : null;

    return { ok: true, forecast: { components, confidence }, band };
};

/** Fold a run's components into the two series the client charts. */
const buildSeries = (metric, components) => {
    const primary = components[0];
    const secondary = components[1] || null;

    const secondaryByDay = secondary
        ? new Map(secondary.history.map((o) => [o.day || String(o.at).slice(0, 10), o.value]))
        : null;

    const history = primary.history.map((o) => {
        const day = o.day || new Date(o.at).toISOString().slice(0, 10);
        const row = { day, value: o.value };
        if (secondaryByDay?.has(day)) row.secondary = secondaryByDay.get(day);
        return row;
    });

    const secondaryProjected = secondary ? new Map(secondary.days.map((d) => [d.day, d])) : null;

    const projected = primary.days.map((d) => {
        const row = { day: d.day, value: d.value, low: d.low, high: d.high };
        const s = secondaryProjected?.get(d.day);
        if (s) { row.secondary = s.value; row.secondaryLow = s.low; row.secondaryHigh = s.high; }
        return row;
    });

    // The chart only needs enough history to show where the line came from; a year of daily
    // rows is 365 points behind a 200pt-wide chart.
    return { history: history.slice(-90), projected };
};

/**
 * The label to render for a stored prediction.
 *
 * The registry wins, with the stored value as the fallback. `metricLabel` is denormalised so a
 * metric later removed from the registry still renders, but a *rename* must not strand every
 * row written before it — and unlike `MetricLog.category`, which deliberately preserves the
 * clinical verdict made at the time, this is only a name. "Turing Score" was the design kit's
 * word for it and never the product's.
 */
const labelFor = (row) => registry.get(row.metric)?.label || row.metricLabel;

/** Strip the working before a prediction leaves the process. */
const present = (row) => ({
    id: String(row._id),
    metric: row.metric,
    metricLabel: labelFor(row),
    unit: row.unit,
    horizonDays: row.horizonDays,
    horizonId: row.horizonId,
    horizonLabel: HORIZON_LABELS[row.horizonDays]?.label || `${row.horizonDays}d`,
    targetDate: row.targetDate,
    generatedAt: row.generatedAt,
    components: row.components,
    band: row.band ?? null,
    confidence: row.confidence,
    narrative: row.narrative,
    resolution: row.resolution ?? null,
    series: row.series,
    /** The pair, rendered the way the design prints it: "126/96" or "80-90". */
    display: displayOf(row),
    disclaimer: PREDICTION_DISCLAIMER,
});

const displayOf = (row) => {
    const cs = row.components || [];
    if (!cs.length) return null;
    if (cs.length > 1) {
        return {
            value: cs.map((c) => Math.round(c.point)).join('/'),
            range: cs.map((c) => `${Math.round(c.low)}-${Math.round(c.high)}`).join(' / '),
            margin: `±${Math.round(Math.max(...cs.map((c) => c.margin)))}`,
        };
    }
    const c = cs[0];
    return {
        value: String(c.point),
        range: `${c.low}-${c.high}`,
        margin: `±${c.margin}`,
    };
};

/* ------------------------------------------------------------------ *
 * Resolution — what actually happened
 * ------------------------------------------------------------------ */

/** The measured value for a metric on or after a date, or null. */
const measuredAfter = async (userId, metricKey, from) => {
    const metric = registry.get(metricKey);
    if (!metric) return null;

    const day = new Date(from).toISOString().slice(0, 10);

    if (metricKey === 'turing_score') {
        const row = await HealthScore.findOne({ userId, value: { $ne: null }, computedAt: { $gte: from } })
            .sort({ computedAt: 1 }).select('value').lean();
        return row ? { value: row.value } : null;
    }

    if (metricKey === 'blood_pressure') {
        const row = await DailyMetrics.findOne({
            userId, day: { $gte: day }, 'bloodPressure.systolic': { $ne: null },
        }).sort({ day: 1 }).select('bloodPressure').lean();
        return row
            ? { value: row.bloodPressure.systolic, pair: { systolic: row.bloodPressure.systolic, diastolic: row.bloodPressure.diastolic } }
            : null;
    }

    const observations = await metric.gather(userId);
    const hit = observations.find((o) => (o.day || String(o.at).slice(0, 10)) >= day);
    return hit ? { value: hit.value } : null;
};

/**
 * Fill in what happened, for every prediction of this person's whose day has come.
 *
 * Idempotent: a row with a `resolution.resolvedAt` is never touched again. Appending the
 * outcome is not a rewrite of the forecast — every field the person read is left exactly as
 * it was, which is what makes `withinInterval` an honest score rather than a graded one.
 */
const resolveDue = async (userId) => {
    const due = await Prediction.find({
        userId,
        targetDate: { $lte: new Date() },
        'resolution.resolvedAt': { $exists: false },
    }).limit(50);

    for (const row of due) {
        const measured = await measuredAfter(userId, row.metric, row.targetDate);
        if (!measured) continue;   // nothing recorded yet — unresolved, not a miss

        const primary = row.components[0];
        const error = measured.value - primary.point;
        const denom = Math.abs(measured.value) || 1;

        const actualDirection = primary.currentValue === null || primary.currentValue === undefined
            ? null
            : measured.value > primary.currentValue ? 'rising'
                : measured.value < primary.currentValue ? 'falling' : 'flat';

        row.resolution = {
            resolvedAt: new Date(),
            actual: measured.value,
            actualPair: measured.pair,
            error: Math.round(error * 100) / 100,
            absErrorPct: Math.round((Math.abs(error) / denom) * 1000) / 10,
            withinInterval: measured.value >= primary.low && measured.value <= primary.high,
            actualDirection,
            directionCorrect: actualDirection === null ? null : actualDirection === primary.direction,
        };
        await row.save();
    }
};

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

/**
 * What can be predicted for this person right now, and what cannot.
 *
 * This is the design's metric picker. Every metric appears — a metric that vanished because
 * it has no data would leave someone with no way to learn that logging it unlocks anything.
 * `ready: false` carries the sentence saying what is missing.
 *
 * `deviation` is the residual scatter of the fit as a share of the reading, which is the
 * honest reading of the design's "Deviation: 0.022%" line: how much this person's own series
 * bounces around its trend. Null where there is no fit.
 */
exports.getPredictableMetrics = async (req, res) => {
    try {
        const userId = req.auth.userId;

        const metrics = [];
        for (const key of registry.METRIC_KEYS) {
            const metric = registry.get(key);
            const series = await registry.gatherSeries(metric, userId);
            const primary = series[Object.keys(series)[0]] || [];

            const maxHorizon = forecaster.maxHorizonFor(primary);
            const horizons = metric.horizons.filter((d) => d <= maxHorizon);

            let deviation = null;
            let latest = null;
            if (horizons.length) {
                const probe = forecaster.forecast(primary, {
                    horizonDays: horizons[0], decimals: metric.decimals, bounds: metric.bounds,
                });
                if (probe) {
                    const base = Math.abs(probe.basis.lastValue) || 1;
                    deviation = Math.round((probe.basis.sd / base) * 10000) / 100;
                    latest = probe.basis.lastValue;
                }
            }

            metrics.push({
                key,
                label: metric.label,
                shortLabel: metric.shortLabel,
                unit: metric.unit,
                icon: metric.icon,
                betterWhen: metric.betterWhen,
                ready: horizons.length > 0,
                observations: primary.length,
                maxHorizonDays: maxHorizon,
                horizons: horizons.map((d) => ({ days: d, ...HORIZON_LABELS[d] })),
                /** The design's "Up to 5 year prediction" line, told truthfully. */
                reach: maxHorizon > 0
                    ? `Up to ${describeDays(maxHorizon)} ahead`
                    : `Needs ${forecaster.MIN_OBSERVATIONS} readings`,
                deviationPct: deviation,
                latest,
                refusal: horizons.length ? null : forecaster.explainRefusal(primary, metric.horizons[0]),
            });
        }

        res.json({
            metrics,
            minObservations: forecaster.MIN_OBSERVATIONS,
            disclaimer: PREDICTION_DISCLAIMER,
        });
    } catch (err) {
        console.error('❌ getPredictableMetrics failed:', err);
        fail(res, 500, 'Could not work out what we can predict for you');
    }
};

const describeDays = (days) => {
    if (days >= 365) return `${Math.floor(days / 365)} year${days >= 730 ? 's' : ''}`;
    if (days >= 60) return `${Math.floor(days / 30)} months`;
    if (days >= 30) return '1 month';
    if (days >= 14) return `${Math.floor(days / 7)} weeks`;
    if (days >= 7) return '1 week';
    return `${days} day${days === 1 ? '' : 's'}`;
};

/**
 * Run a prediction and keep it.
 *
 * Body: `{ metric, horizon }` where horizon is a chip id (`1d`/`1w`/`1m`/`3m`/`1y`) or a
 * number of days.
 */
exports.createPrediction = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const { metric: metricKey, horizon } = req.body || {};

        const metric = registry.get(metricKey);
        if (!metric) return fail(res, 400, `We do not predict "${metricKey}".`);

        const horizonDays = typeof horizon === 'number'
            ? horizon
            : registry.horizonById(horizon) ?? 7;

        if (!metric.horizons.includes(horizonDays)) {
            return fail(res, 400, `${metric.label} cannot be predicted at that horizon.`, {
                horizons: metric.horizons.map((d) => ({ days: d, ...HORIZON_LABELS[d] })),
            });
        }

        const run = await runForecast(metric, userId, horizonDays);
        if (!run.ok) {
            // 422, not 400: the request was well formed, there is simply not enough of this
            // person's data behind it. The client routes this to the design's "not enough
            // data" modal, which needs the sentence rather than a status code.
            return res.status(422).json({
                message: run.refusal.message,
                refusal: run.refusal,
                metric: metric.key,
                metricLabel: metric.label,
            });
        }

        const { forecast, band } = run;
        const headline = buildHeadline(metric, horizonDays, forecast, band);

        let narrative;
        if (engine.isConfigured()) {
            const profile = await gatherProfile(userId);
            const result = await engine.narrate({
                metric, horizonDays, forecast, band, profile, fallbackHeadline: headline,
            });
            narrative = result.ok
                ? result.data
                : engine.deterministicNarrative({ metric, horizonDays, forecast, band, headline });
        } else {
            narrative = engine.deterministicNarrative({ metric, horizonDays, forecast, band, headline });
        }

        const row = await Prediction.create({
            userId,
            metric: metric.key,
            metricLabel: metric.label,
            unit: metric.unit,
            horizonDays,
            horizonId: HORIZON_LABELS[horizonDays]?.id || `${horizonDays}d`,
            targetDate: new Date(Date.now() + horizonDays * 86400000),
            components: forecast.components.map(({ days, history, ...c }) => c),
            band: band || undefined,
            confidence: forecast.confidence,
            narrative,
            series: buildSeries(metric, forecast.components),
        });

        console.log(`🔮 Prediction written: ${metric.key} +${horizonDays}d for ${userId}`);
        res.status(201).json({ prediction: present(row.toObject()) });
    } catch (err) {
        console.error('❌ createPrediction failed:', err);
        fail(res, 500, 'Could not run that prediction');
    }
};

/** One person's predictions, newest first. Resolves anything due on the way past. */
exports.listPredictions = async (req, res) => {
    try {
        const userId = req.auth.userId;
        await resolveDue(userId);

        const filter = { userId };
        if (req.query.metric) filter.metric = req.query.metric;

        const rows = await Prediction.find(filter)
            .sort({ generatedAt: -1, _id: -1 })
            .limit(Math.min(Number(req.query.limit) || RECENT_LIMIT, 50))
            .lean();

        res.json({ predictions: rows.map(present), disclaimer: PREDICTION_DISCLAIMER });
    } catch (err) {
        console.error('❌ listPredictions failed:', err);
        fail(res, 500, 'Could not load your predictions');
    }
};

exports.getPrediction = async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 404, 'Prediction not found');

        const row = await Prediction.findOne({ _id: req.params.id, userId: req.auth.userId }).lean();
        // 404 rather than 403 on someone else's row, the call `middleware/ownership.js` makes:
        // a 403 confirms the row exists.
        if (!row) return fail(res, 404, 'Prediction not found');

        res.json({ prediction: present(row) });
    } catch (err) {
        console.error('❌ getPrediction failed:', err);
        fail(res, 500, 'Could not load that prediction');
    }
};

/**
 * Everything the hub screen draws, in one call.
 *
 * One request rather than five because this is a first-paint screen and the rule the home
 * screen already follows applies: nothing model-backed is awaited before the first paint.
 * **No prediction is generated here** — this reads what has already been written. Running a
 * forecast on a screen open would put an Opus call inside a `useFocusEffect`.
 */
exports.getOverview = async (req, res) => {
    try {
        const userId = req.auth.userId;
        await resolveDue(userId);

        const [recent, professionals] = await Promise.all([
            Prediction.find({ userId }).sort({ generatedAt: -1, _id: -1 }).limit(RECENT_LIMIT).lean(),
            Professional.find()
                .select('firstname lastname speciality profile_image country hourly_rate')
                .limit(PROFESSIONAL_LIMIT)
                .lean(),
        ]);

        // The newest prediction per metric — the design's "Health Metric Prediction" list is
        // one row per metric, not one per run. The query's `_id` tie-break is what makes
        // "newest" well defined: two runs inside the same millisecond otherwise come back in
        // an arbitrary order, and the list would show whichever of them Mongo felt like.
        const byMetric = new Map();
        for (const row of recent) if (!byMetric.has(row.metric)) byMetric.set(row.metric, row);

        const score = byMetric.get('turing_score') || null;
        const metrics = [...byMetric.values()].filter((r) => r.metric !== 'turing_score');

        res.json({
            /** The design's "3 Metric Predicted". Distinct metrics, not runs. */
            metricsPredicted: byMetric.size,
            improvement: improvementOf(recent),
            accuracy: accuracyOf(recent),
            scorePrediction: score ? present(score) : null,
            metricPredictions: metrics.map(present),
            past: recent.slice(0, 6).map(summarise),
            professionals: professionals.map((p) => ({
                id: String(p._id),
                name: `Dr. ${p.firstname} ${p.lastname}`,
                speciality: (p.speciality || [])[0] || 'Clinician',
                image: p.profile_image,
                country: p.country,
                hourlyRate: p.hourly_rate,
            })),
            disclaimer: PREDICTION_DISCLAIMER,
        });
    } catch (err) {
        console.error('❌ getOverview failed:', err);
        fail(res, 500, 'Could not load your predictions');
    }
};

/**
 * The design's "+25% Improvement" figure, computed rather than decorated.
 *
 * It is the share of resolved predictions whose measured outcome moved in the direction that
 * is better for that metric. Null — never zero — when nothing has resolved yet, and null for
 * a person all of whose metrics have `betterWhen: null`, because "improvement" is not a
 * thing weight or calories can be said to have done.
 */
const improvementOf = (rows) => {
    const scored = rows.filter((r) => {
        const metric = registry.get(r.metric);
        return r.resolution?.resolvedAt && metric?.betterWhen && r.resolution.actualDirection;
    });
    if (!scored.length) return null;

    const better = scored.filter((r) => {
        const { betterWhen } = registry.get(r.metric);
        const dir = r.resolution.actualDirection;
        return dir === betterWhen || (dir === 'flat' && betterWhen === 'falling');
    }).length;

    return { pct: Math.round((better / scored.length) * 100), of: scored.length };
};

/**
 * How often the interval actually contained the measured value.
 *
 * The only honest measure of whether this feature works, and it is on the hub rather than
 * hidden in a settings screen. Null until something has resolved.
 */
const accuracyOf = (rows) => {
    const resolved = rows.filter((r) => r.resolution?.resolvedAt && r.resolution.withinInterval !== null);
    if (!resolved.length) return null;

    const hits = resolved.filter((r) => r.resolution.withinInterval).length;
    const errors = resolved.map((r) => r.resolution.absErrorPct).filter(Number.isFinite);

    return {
        resolved: resolved.length,
        withinIntervalPct: Math.round((hits / resolved.length) * 100),
        medianErrorPct: errors.length ? median(errors) : null,
    };
};

const median = (values) => {
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return Math.round((s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2) * 10) / 10;
};

/** The compact shape the "Past Predictions" rows draw. */
const summarise = (row) => ({
    id: String(row._id),
    metric: row.metric,
    metricLabel: labelFor(row),
    unit: row.unit,
    generatedAt: row.generatedAt,
    targetDate: row.targetDate,
    horizonLabel: HORIZON_LABELS[row.horizonDays]?.label || `${row.horizonDays}d`,
    display: displayOf(row),
    direction: row.components?.[0]?.direction || 'flat',
    changePct: row.components?.[0]?.changePct ?? null,
    band: row.band ?? null,
    confidence: row.confidence,
    resolution: row.resolution ?? null,
    /** The sparkline the design draws on each row: the projected path only. */
    spark: (row.series?.projected || []).map((p) => p.value),
});

/**
 * The Prediction Insight screen: history and projection for one metric, plus the day-grid.
 *
 * Computed live rather than read from a stored prediction, because this screen has a metric
 * switcher and a horizon and the person expects it to answer for a combination nobody has
 * run yet. Nothing is written — a chart someone scrolled is not a prediction they made, and
 * writing one here would fill "Past Predictions" with rows nobody asked for.
 */
exports.getInsight = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const metric = registry.get(req.params.metric);
        if (!metric) return fail(res, 404, 'Unknown metric');

        const horizonDays = registry.horizonById(req.query.horizon) ?? 7;

        const run = await runForecast(metric, userId, horizonDays);
        if (!run.ok) {
            return res.status(422).json({
                message: run.refusal.message,
                refusal: run.refusal,
                metric: metric.key,
                metricLabel: metric.label,
            });
        }

        const { forecast, band } = run;
        const series = buildSeries(metric, forecast.components);

        res.json({
            metric: {
                key: metric.key, label: metric.label, unit: metric.unit,
                icon: metric.icon, betterWhen: metric.betterWhen, decimals: metric.decimals,
            },
            horizonDays,
            horizonId: HORIZON_LABELS[horizonDays]?.id,
            horizons: metric.horizons.map((d) => ({ days: d, ...HORIZON_LABELS[d] })),
            components: forecast.components.map(({ days, history, ...c }) => c),
            band: band || null,
            confidence: forecast.confidence,
            display: displayOf({ components: forecast.components }),
            headline: buildHeadline(metric, horizonDays, forecast, band),
            series,
            calendar: buildCalendar(metric, forecast),
            safetyNote: metric.safetyNote || null,
            disclaimer: PREDICTION_DISCLAIMER,
        });
    } catch (err) {
        console.error('❌ getInsight failed:', err);
        fail(res, 500, 'Could not build that insight');
    }
};

/**
 * The design's week-grid of up/down/level arrows.
 *
 * Each day is compared against **the last measured value**, not against the previous
 * projected day. Comparing consecutive projected days would draw a straight trend as a solid
 * wall of arrows in one direction, which tells the person nothing they cannot already see on
 * the line above it; comparing against where they are now answers the question the grid is
 * actually asked — is this day better or worse than today.
 *
 * The threshold is the forecast's own interval half-width. A day whose projection differs
 * from today by less than the uncertainty is `level`, not a direction — the same call
 * `FLAT_SLOPE_RATIO` makes about a slope buried in noise.
 */
const buildCalendar = (metric, forecast) => {
    const c = forecast.components[0];
    const base = c.currentValue;
    if (!Number.isFinite(base)) return [];

    const threshold = Math.max(c.margin * 0.5, Math.abs(base) * 0.01);

    return c.days.map((d) => {
        const delta = d.value - base;
        const direction = Math.abs(delta) < threshold ? 'level' : delta > 0 ? 'up' : 'down';

        // `tone` is what the design colours the arrow with, and it is NOT the direction:
        // a falling blood pressure is green and a falling step count is not. A metric with
        // no better direction gets `neutral`, so the grid never takes a view on a weight.
        const tone = !metric.betterWhen || direction === 'level'
            ? 'neutral'
            : (direction === 'up') === (metric.betterWhen === 'rising') ? 'good' : 'bad';

        return { day: d.day, value: d.value, direction, tone, delta: Math.round(delta * 100) / 100 };
    });
};

/** How this person's past predictions have actually performed. */
exports.getAccuracy = async (req, res) => {
    try {
        const userId = req.auth.userId;
        await resolveDue(userId);

        const rows = await Prediction.find({ userId }).sort({ generatedAt: -1, _id: -1 }).limit(200).lean();
        const overall = accuracyOf(rows);

        const byMetric = {};
        for (const key of new Set(rows.map((r) => r.metric))) {
            const subset = rows.filter((r) => r.metric === key);
            byMetric[key] = {
                label: registry.get(key)?.label || key,
                total: subset.length,
                ...(accuracyOf(subset) || { resolved: 0, withinIntervalPct: null, medianErrorPct: null }),
            };
        }

        res.json({
            total: rows.length,
            overall,
            byMetric,
            // Deliberately explicit. An accuracy screen showing nothing is otherwise
            // indistinguishable from a broken one.
            note: overall
                ? null
                : 'None of your predictions have reached their target date with a reading to check against yet.',
            disclaimer: PREDICTION_DISCLAIMER,
        });
    } catch (err) {
        console.error('❌ getAccuracy failed:', err);
        fail(res, 500, 'Could not load prediction accuracy');
    }
};

/** Whether the model half is available, so the client can label a degraded run up front. */
exports.getStatus = (req, res) => {
    res.json({
        forecasting: true,
        narrative: engine.isConfigured(),
        minObservations: forecaster.MIN_OBSERVATIONS,
        disclaimer: PREDICTION_DISCLAIMER,
    });
};

exports._runForecast = runForecast;
exports._buildCalendar = buildCalendar;
exports._buildHeadline = buildHeadline;
exports._resolveDue = resolveDue;
exports.PREDICTION_DISCLAIMER = PREDICTION_DISCLAIMER;
