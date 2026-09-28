/**
 * Heart-rate variability on the metrics dashboard.
 *
 * What has to hold:
 *   - HRV is judged against the person's own baseline, never a population figure. Sources
 *     disagree on the measure (SDNN vs RMSSD), and healthy values differ several-fold.
 *   - No baseline is claimed until enough days exist.
 *   - The day being judged is not part of its own baseline.
 *   - The card is always present, with a null value when nothing is recorded.
 */
const mongoose = require('mongoose');
const DailyMetrics = require('../models/DailyMetrics');
const User = require('../models/userModel');
const VitalTarget = require('../models/VitalTarget');
const metrics = require('../controllers/metricsController');

const localDay = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);

const mockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
};

let userId;
beforeEach(async () => {
    userId = new mongoose.Types.ObjectId();
    await User.create({ _id: userId, username: `u${userId}`, email: `${userId}@example.com`, password: 'x' });
});

const seed = (values) => DailyMetrics.insertMany(values.map(([ago, hrvMs]) => ({
    userId, day: localDay(ago), heart: { hrvMs },
})));

const overview = async () => {
    const res = mockRes();
    await metrics.getOverview({ auth: { userId: String(userId) }, query: { tzOffset: '0' } }, res);
    return res.json.mock.calls[0][0].metrics;
};
const card = async (key) => (await overview()).find((m) => m.key === key);

describe('the HRV card', () => {
    it('is present with no value when nothing is recorded', async () => {
        const hrv = await card('hrv');
        expect(hrv).toMatchObject({ value: null, unit: 'ms', status: 'Connect a device', loggable: false });
    });

    it('says it is still learning until five earlier days exist', async () => {
        await seed([[0, 44], [1, 40], [2, 41]]);
        const hrv = await card('hrv');
        expect(hrv.value).toBe(44);
        expect(hrv.baseline).toBeNull();
        expect(hrv.status).toBe('Learning your usual · 2 of 5 days');
    });

    it('compares the latest day with the median of the ones before it', async () => {
        // Baseline from days 1–20, median 50, read from beyond the seven-day window shown.
        await seed([[0, 38], ...Array.from({ length: 20 }, (_, i) => [i + 1, i % 2 ? 48 : 52])]);
        const hrv = await card('hrv');
        expect(hrv.baseline).toBe(50);
        expect(hrv.status).toBe('Below your usual 50 ms');
        expect(hrv.series).toHaveLength(7);
    });

    it('reads near, above and below by a 15% band', async () => {
        const base = Array.from({ length: 10 }, (_, i) => [i + 1, 50]);
        await seed([[0, 56], ...base]);
        expect((await card('hrv')).status).toBe('Near your usual 50 ms');
        await DailyMetrics.updateOne({ userId, day: localDay(0) }, { $set: { 'heart.hrvMs': 60 } });
        expect((await card('hrv')).status).toBe('Above your usual 50 ms');
    });

    it('sits beside heart rate on the list', async () => {
        const keys = (await overview()).map((m) => m.key);
        expect(keys.indexOf('hrv')).toBe(keys.indexOf('heart_rate') + 1);
    });
});

describe('the SpO2 card with a clinician-set target', () => {
    it('states the clinician\'s target instead of the typical range', async () => {
        await DailyMetrics.create({ userId, day: localDay(0), spo2: { avg: 90, min: 88, max: 92, readings: 6 } });
        expect((await card('spo2')).status).toMatch(/typical is 95–100%/);

        await VitalTarget.create({ userId, spo2Scale: 'hypercapnic', reason: 'COPD' });
        const spo2 = await card('spo2');
        expect(spo2.status).toBe("Lowest 88% · your clinician's target is 88–92%");
        // Not in `target`, which the dashboard draws as "value / target".
        expect(spo2.target).toBeUndefined();
    });
});
