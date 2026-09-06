/**
 * The prediction write path, end to end.
 *
 * `prediction.test.js` covers the arithmetic and the merge guard; this covers the wiring —
 * that logged rows reach the forecaster, that a stored prediction round-trips, that a
 * refusal names its reason rather than answering with a number, and that resolution scores a
 * prediction against what was actually measured afterwards.
 *
 * The Claude half is never called here: `ANTHROPIC_API_KEY` is unset in the harness, so the
 * controller takes the deterministic-narrative path. That is deliberate — this is the path
 * that must work when the model is unavailable, and running it in the suite is the only way
 * to know that it does.
 */
const mongoose = require('mongoose');
const DailyMetrics = require('../models/DailyMetrics');
const HealthScore = require('../models/HealthScore');
const Prediction = require('../models/Prediction');
const User = require('../models/userModel');
const controller = require('../controllers/predictionController');

let userId;

/** Minimal express doubles. The controllers only ever touch these three things. */
const mockRes = () => {
    const res = { statusCode: 200, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    return res;
};
const call = async (handler, { body = {}, params = {}, query = {} } = {}) => {
    const res = mockRes();
    await handler({ auth: { userId }, body, params, query }, res);
    return res;
};

/** `n` days of blood-pressure rows ending yesterday, climbing by `step`. */
const seedBloodPressure = async (n, { from = 118, step = 0.6 } = {}) => {
    const rows = [];
    for (let i = 0; i < n; i += 1) {
        const d = new Date();
        d.setDate(d.getDate() - (n - i));
        rows.push({
            userId,
            day: d.toISOString().slice(0, 10),
            bloodPressure: {
                systolic: Math.round(from + i * step),
                diastolic: Math.round(from - 40 + i * step),
                readings: 1,
            },
        });
    }
    await DailyMetrics.insertMany(rows);
};

beforeEach(async () => {
    userId = new mongoose.Types.ObjectId();
    await User.create({
        _id: userId,
        username: `u${userId}`,
        email: `${userId}@example.com`,
        password: 'x',
        height: 175,
        weight: 82,
    });
    delete process.env.ANTHROPIC_API_KEY;
});

describe('what can be predicted', () => {
    it('lists every metric, including the ones with no data', async () => {
        const res = await call(controller.getPredictableMetrics);

        expect(res.statusCode).toBe(200);
        // A metric that vanished for want of data leaves nobody a way to discover that
        // logging it unlocks anything.
        expect(res.body.metrics.length).toBeGreaterThan(5);
        expect(res.body.metrics.every((m) => m.ready === false)).toBe(true);
        expect(res.body.metrics[0].refusal.reason).toBe('too_few');
    });

    it('marks a metric ready once its history supports a horizon', async () => {
        await seedBloodPressure(30);
        const res = await call(controller.getPredictableMetrics);

        const bp = res.body.metrics.find((m) => m.key === 'blood_pressure');
        expect(bp.ready).toBe(true);
        expect(bp.observations).toBe(30);
        expect(bp.horizons.map((h) => h.id)).toContain('1w');
        // Real, per-metric, not the kit's placeholder "Up to 5 year prediction".
        expect(bp.reach).toMatch(/Up to/);
        expect(bp.deviationPct).not.toBeNull();
    });

    it('offers only the horizons the history can actually support', async () => {
        await seedBloodPressure(6);
        const res = await call(controller.getPredictableMetrics);

        const bp = res.body.metrics.find((m) => m.key === 'blood_pressure');
        // Five days of span cannot reach a month, whatever the registry offers.
        expect(bp.horizons.map((h) => h.days)).not.toContain(30);
    });
});

describe('running a prediction', () => {
    it('writes an interval, a band and the deterministic narrative', async () => {
        await seedBloodPressure(40);
        const res = await call(controller.createPrediction, { body: { metric: 'blood_pressure', horizon: '1w' } });

        expect(res.statusCode).toBe(201);
        const p = res.body.prediction;

        expect(p.components).toHaveLength(2);
        for (const c of p.components) {
            expect(c.low).toBeLessThan(c.point);
            expect(c.high).toBeGreaterThan(c.point);
        }
        // Staged by `bloodPressure.classify` — the same table a logged reading goes through.
        expect(p.band).not.toBeNull();
        expect(p.display.value).toMatch(/^\d+\/\d+$/);
        // No API key: the prose is the fallback, and it says so rather than pretending.
        expect(p.narrative.degraded).toBe(true);
        expect(p.narrative.model).toBeNull();
        expect(p.narrative.summary).toBeTruthy();
        expect(p.disclaimer).toMatch(/not a diagnosis/i);
    });

    it('answers 422 with a sentence rather than a number when there is too little history', async () => {
        await seedBloodPressure(2);
        const res = await call(controller.createPrediction, { body: { metric: 'blood_pressure', horizon: '1w' } });

        expect(res.statusCode).toBe(422);
        expect(res.body.refusal.reason).toBe('too_few');
        // The sentence the design's "not enough data" modal prints.
        expect(res.body.message).toMatch(/log 1 more entry/i);
        expect(await Prediction.countDocuments()).toBe(0);
    });

    it('refuses a horizon the registry does not offer', async () => {
        const res = await call(controller.createPrediction, { body: { metric: 'weight', horizon: '1d' } });
        expect(res.statusCode).toBe(400);
    });

    it('appends rather than overwriting when the same metric is run again', async () => {
        await seedBloodPressure(40);
        await call(controller.createPrediction, { body: { metric: 'blood_pressure', horizon: '1w' } });
        await call(controller.createPrediction, { body: { metric: 'blood_pressure', horizon: '1w' } });

        // The first is what somebody read. "Repeat Prediction" must not erase it.
        expect(await Prediction.countDocuments({ userId })).toBe(2);
    });

    it('carries a projected path the client can chart without refitting', async () => {
        await seedBloodPressure(40);
        const res = await call(controller.createPrediction, { body: { metric: 'blood_pressure', horizon: '1w' } });

        const { series } = res.body.prediction;
        expect(series.projected).toHaveLength(7);
        expect(series.history.length).toBeGreaterThan(0);
        for (const point of series.projected) {
            expect(point.low).toBeLessThanOrEqual(point.high);
            // A pair metric charts both halves.
            expect(point.secondary).toBeDefined();
        }
    });
});

describe('the insight screen writes nothing', () => {
    it('returns a fresh fit and a calendar without creating a Prediction', async () => {
        await seedBloodPressure(40);
        const res = await call(controller.getInsight, {
            params: { metric: 'blood_pressure' }, query: { horizon: '1w' },
        });

        expect(res.statusCode).toBe(200);
        expect(res.body.calendar).toHaveLength(7);
        expect(res.body.headline).toBeTruthy();
        // A chart somebody scrolled is not a claim they made.
        expect(await Prediction.countDocuments()).toBe(0);
    });
});

describe('resolution', () => {
    const runAndBackdate = async (metric, horizon) => {
        const res = await call(controller.createPrediction, { body: { metric, horizon } });
        const row = await Prediction.findById(res.body.prediction.id);
        // Pull the target date just into the past so it is due. An hour rather than a day:
        // the seeded history runs up to yesterday, and a target date of yesterday would be
        // "resolved" by one of the readings the forecast was built from.
        row.targetDate = new Date(Date.now() - 3600000);
        await row.save();
        return row;
    };

    it('stays unresolved while nothing has been measured since the target date', async () => {
        await seedBloodPressure(40);
        const row = await runAndBackdate('blood_pressure', '1w');

        await controller._resolveDue(userId);
        const after = await Prediction.findById(row._id).lean();
        // Unresolved is unresolved. It is never a miss.
        expect(after.resolution?.resolvedAt).toBeUndefined();
    });

    it('scores the prediction against what was actually measured', async () => {
        await seedBloodPressure(40);
        const row = await runAndBackdate('blood_pressure', '1w');

        const today = new Date().toISOString().slice(0, 10);
        await DailyMetrics.findOneAndUpdate(
            { userId, day: today },
            { $set: { bloodPressure: { systolic: Math.round(row.components[0].point), diastolic: 90, readings: 1 } } },
            { upsert: true },
        );

        await controller._resolveDue(userId);
        const after = await Prediction.findById(row._id).lean();

        expect(after.resolution.resolvedAt).toBeDefined();
        expect(after.resolution.withinInterval).toBe(true);
        expect(after.resolution.absErrorPct).toBeLessThan(2);
    });

    it('records a miss as a miss', async () => {
        await seedBloodPressure(40);
        const row = await runAndBackdate('blood_pressure', '1w');

        const today = new Date().toISOString().slice(0, 10);
        await DailyMetrics.findOneAndUpdate(
            { userId, day: today },
            { $set: { bloodPressure: { systolic: row.components[0].high + 40, diastolic: 90, readings: 1 } } },
            { upsert: true },
        );

        await controller._resolveDue(userId);
        const after = await Prediction.findById(row._id).lean();
        expect(after.resolution.withinInterval).toBe(false);
    });

    it('never re-resolves a prediction that already has an outcome', async () => {
        await seedBloodPressure(40);
        const row = await runAndBackdate('blood_pressure', '1w');

        const today = new Date().toISOString().slice(0, 10);
        await DailyMetrics.findOneAndUpdate(
            { userId, day: today },
            { $set: { bloodPressure: { systolic: 130, diastolic: 90, readings: 1 } } },
            { upsert: true },
        );

        await controller._resolveDue(userId);
        const first = await Prediction.findById(row._id).lean();

        await DailyMetrics.findOneAndUpdate(
            { userId, day: today },
            { $set: { bloodPressure: { systolic: 999, diastolic: 90, readings: 1 } } },
        );
        await controller._resolveDue(userId);
        const second = await Prediction.findById(row._id).lean();

        expect(second.resolution.actual).toBe(first.resolution.actual);
    });
});

describe('the hub', () => {
    it('reports null, not zero, before anything has resolved', async () => {
        await seedBloodPressure(40);
        await call(controller.createPrediction, { body: { metric: 'blood_pressure', horizon: '1w' } });

        const res = await call(controller.getOverview);
        expect(res.body.metricsPredicted).toBe(1);
        // "Nothing checked yet" is not "0% accurate".
        expect(res.body.accuracy).toBeNull();
        expect(res.body.improvement).toBeNull();
    });

    it('shows one row per metric, not one per run', async () => {
        // 60 days, because a month-ahead horizon needs ~40 days of span behind it — the
        // extrapolation cap, doing its job.
        await seedBloodPressure(60);
        await call(controller.createPrediction, { body: { metric: 'blood_pressure', horizon: '1w' } });
        await call(controller.createPrediction, { body: { metric: 'blood_pressure', horizon: '1m' } });

        const res = await call(controller.getOverview);
        // Both runs land in the same millisecond here, which is exactly the tie the `_id`
        // sort exists to break.
        expect(res.body.metricsPredicted).toBe(1);
        expect(res.body.metricPredictions).toHaveLength(1);
        // The newest survives.
        expect(res.body.metricPredictions[0].horizonId).toBe('1m');
        // Every run is still listed under Past Predictions.
        expect(res.body.past).toHaveLength(2);
    });

    it('separates the score prediction from the metric list', async () => {
        for (let i = 0; i < 30; i += 1) {
            const d = new Date();
            d.setDate(d.getDate() - (30 - i));
            await HealthScore.create({ userId, value: 60 + i * 0.5, computedAt: d, pillars: [] });
        }
        await call(controller.createPrediction, { body: { metric: 'turing_score', horizon: '1w' } });

        const res = await call(controller.getOverview);
        expect(res.body.scorePrediction).not.toBeNull();
        expect(res.body.scorePrediction.unit).toBe('pts');
        expect(res.body.metricPredictions).toHaveLength(0);
    });
});

describe('renaming a metric', () => {
    it('renders the registry\'s current label, not the one stored on an old row', async () => {
        await seedBloodPressure(40);
        const created = await call(controller.createPrediction, { body: { metric: 'blood_pressure', horizon: '1w' } });

        // A row written before a rename. `metricLabel` is denormalised so a metric later
        // removed from the registry still renders — but a rename must not strand every row
        // written before it. Unlike `MetricLog.category`, which deliberately preserves the
        // clinical verdict made at the time, this is only a name.
        await Prediction.findByIdAndUpdate(created.body.prediction.id, { metricLabel: 'Turing Blood Pressure' });

        const res = await call(controller.getPrediction, { params: { id: created.body.prediction.id } });
        expect(res.body.prediction.metricLabel).toBe('Blood Pressure');

        // And on the compact shape the past list draws.
        const hub = await call(controller.getOverview);
        expect(hub.body.past[0].metricLabel).toBe('Blood Pressure');
    });

    it('falls back to the stored label for a metric the registry no longer knows', async () => {
        await seedBloodPressure(40);
        const created = await call(controller.createPrediction, { body: { metric: 'blood_pressure', horizon: '1w' } });
        await Prediction.findByIdAndUpdate(created.body.prediction.id, {
            metric: 'retired_metric', metricLabel: 'Something We Removed',
        });

        const res = await call(controller.getPrediction, { params: { id: created.body.prediction.id } });
        expect(res.body.prediction.metricLabel).toBe('Something We Removed');
    });

    it('calls the score by the product\'s name, not the design kit\'s', async () => {
        // The kit says "Turing Score" throughout. That is the design system's name and has
        // never been the product's.
        expect(require('../utils/predictionMetrics').get('turing_score').label).toBe('LabTrack Score');
    });
});

describe('ownership', () => {
    it('answers 404, not 403, for somebody else\'s prediction', async () => {
        await seedBloodPressure(40);
        const created = await call(controller.createPrediction, { body: { metric: 'blood_pressure', horizon: '1w' } });

        const other = new mongoose.Types.ObjectId();
        const res = mockRes();
        await controller.getPrediction(
            { auth: { userId: other }, params: { id: created.body.prediction.id } },
            res,
        );

        // A 403 confirms the row exists, which turns the endpoint into a way of asking
        // whether an id belongs to a LabTrack patient. The call `middleware/ownership.js` makes.
        expect(res.statusCode).toBe(404);
    });
});
