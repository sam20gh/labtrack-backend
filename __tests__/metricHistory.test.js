/**
 * Every card on the Health Metrics list opens its own history.
 *
 * What has to hold:
 *   - The six device-fed kinds answer the same shape the loggable ones do — a day series and
 *     the entries under it — so one screen can draw all of them.
 *   - Entries are the individual readings where the record keeps them, and one row per day
 *     where it keeps only the day's figure.
 *   - Temperature never mixes its two sites.
 *   - An empty window is null stats, not zeros.
 *   - An unknown kind is still a 404.
 */
const mongoose = require('mongoose');
const DailyMetrics = require('../models/DailyMetrics');
const MetricLog = require('../models/MetricLog');
const HeartRateSample = require('../models/HeartRateSample');
const SleepSession = require('../models/SleepSession');
const User = require('../models/userModel');
const metrics = require('../controllers/metricsController');

const localDay = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
const at = (daysAgo, hour = 9) => new Date(`${localDay(daysAgo)}T${String(hour).padStart(2, '0')}:00:00Z`);

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

const history = async (kind, days = 30) => {
    const res = mockRes();
    await metrics.getHistory(
        { auth: { userId: String(userId) }, params: { kind }, query: { tzOffset: '0', days: String(days) } },
        res,
    );
    return { status: res.status.mock.calls[0]?.[0] ?? 200, body: res.json.mock.calls[0][0] };
};

describe('device-fed metric history', () => {
    it('serves every device-fed card on the list', () => {
        expect(metrics._DEVICE_HISTORY_KINDS.sort()).toEqual(
            ['heart-rate', 'hrv', 'sleep', 'spo2', 'steps', 'temperature'],
        );
    });

    it('answers null stats and no entries when nothing is recorded', async () => {
        for (const kind of metrics._DEVICE_HISTORY_KINDS) {
            const { status, body } = await history(kind);
            expect(status).toBe(200);
            expect(body.entries).toEqual([]);
            expect(body.stats).toBeNull();
            expect(body.series).toHaveLength(30);
            expect(typeof body.note).toBe('string');
        }
    });

    it('lists individual heart-rate readings, labelled by context', async () => {
        await DailyMetrics.create({ userId, day: localDay(0), heart: { restingBpm: 58, minBpm: 52, maxBpm: 120 } });
        await HeartRateSample.create([
            { userId, day: localDay(0), measuredAt: at(0, 7), bpm: 58, context: 'resting', source: 'health_connect' },
            { userId, day: localDay(0), measuredAt: at(0, 18), bpm: 110, context: 'active', source: 'health_connect' },
        ]);
        const { body } = await history('heart-rate');
        expect(body.entries.map((e) => [e.value, e.label])).toEqual([[110, 'Active'], [58, 'Resting']]);
        expect(body.stats).toMatchObject({ latest: { value: 58 }, min: 52, max: 120, daysWithData: 1 });
    });

    it('falls back to one row per day when a source sent only the day', async () => {
        await DailyMetrics.create({ userId, day: localDay(1), heart: { avgBpm: 72, minBpm: 50, maxBpm: 140 } });
        const { body } = await history('heart-rate');
        expect(body.entries).toEqual([
            expect.objectContaining({ day: localDay(1), value: 72, perDay: true, detail: 'Range 50–140 bpm' }),
        ]);
    });

    it('keeps temperature to one site', async () => {
        await DailyMetrics.create({ userId, day: localDay(0), temperature: { wristAvg: 33.1, axillaryAvg: 36.6, readings: 2 } });
        await MetricLog.create([
            { userId, kind: 'temperature', day: localDay(0), measuredAt: at(0, 8), celsius: 33.1, site: 'wrist', source: 'bracelet' },
            { userId, kind: 'temperature', day: localDay(0), measuredAt: at(0, 9), celsius: 36.6, site: 'axillary', source: 'bracelet' },
        ]);
        const { body } = await history('temperature');
        expect(body.label).toBe('Body Temperature');
        expect(body.entries.map((e) => e.value)).toEqual([36.6]);
    });

    it('lists oximetry readings and leads the stats with the lowest', async () => {
        await DailyMetrics.create({ userId, day: localDay(0), spo2: { avg: 96, min: 91, max: 99, readings: 2 } });
        await MetricLog.create([
            { userId, kind: 'spo2', day: localDay(0), measuredAt: at(0, 2), spo2: 91, source: 'bracelet' },
            { userId, kind: 'spo2', day: localDay(0), measuredAt: at(0, 9), spo2: 99, source: 'bracelet' },
        ]);
        const { body } = await history('spo2');
        expect(body.entries.map((e) => e.value)).toEqual([99, 91]);
        expect(body.stats.min).toBe(91);
    });

    it('lists nights that open their own detail', async () => {
        const night = await SleepSession.create({
            userId, day: localDay(0), startedAt: at(1, 23), endedAt: at(0, 7), asleepMin: 450, score: 81, source: 'manual',
        });
        await DailyMetrics.create({ userId, day: localDay(0), sleep: { asleepMin: 450 } });
        const { body } = await history('sleep');
        expect(body.entries[0]).toMatchObject({ value: 7.5, unit: 'h', label: 'Score 81', route: `/sleep/${night._id}` });
    });

    it('files HRV and steps as one entry per day', async () => {
        await DailyMetrics.insertMany([
            { userId, day: localDay(2), heart: { hrvMs: 41.4 }, activity: { steps: 8000, exerciseMin: 30 } },
            { userId, day: localDay(0), heart: { hrvMs: 45 }, activity: { steps: 3000 } },
        ]);
        const hrv = (await history('hrv')).body;
        expect(hrv.entries.map((e) => [e.day, e.value])).toEqual([[localDay(0), 45], [localDay(2), 41]]);
        const steps = (await history('steps')).body;
        expect(steps.entries.map((e) => e.detail)).toEqual([null, '30 min of exercise']);
    });

    it('still refuses a kind it does not know', async () => {
        expect((await history('glucose')).status).toBe(404);
    });
});
