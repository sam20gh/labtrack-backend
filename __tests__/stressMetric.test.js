/**
 * The bracelet's stress score, from ingest to the dashboard card.
 *
 * It rides in the bracelet's HRV records on a scale the vendor does not publish. What has to
 * hold:
 *   - A bracelet batch reaches `MetricLog` and rebuilds the day's `stress` rollup, and a
 *     re-sync upserts rather than duplicating.
 *   - A reading off the 1–100 scale is dropped, never rejected — the batch's other rows land.
 *   - A phone-store batch, which never carries it, is unaffected.
 *   - A reading stamped while the band's clock was wrong is moved like every other family.
 *   - The card compares with the person's own days and never bands the number.
 *   - It never enters the score.
 */
const mongoose = require('mongoose');
const MetricLog = require('../models/MetricLog');
const DailyMetrics = require('../models/DailyMetrics');
const User = require('../models/userModel');
const metrics = require('../controllers/metricsController');
const { ingestBatch } = require('../utils/healthSync');
const { applyFaults, INSTANT_FAMILIES } = require('../utils/clockFault');
const { derive } = require('../utils/observedProfile');
const labtrackScore = require('../utils/labtrackScore');

const DAY = '2026-09-10';
const at = (hhmm) => new Date(`${DAY}T${hhmm}:00.000Z`).toISOString();
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

const bracelet = (stress, extra = {}) => ingestBatch({
    userId, platform: 'jstyle_bracelet', tzOffset: 0, stress, ...extra,
});

describe('ingest', () => {
    it('stores each reading and rolls the day up', async () => {
        const result = await bracelet([
            { externalId: 's1', measuredAt: at('09:00'), score: 22 },
            { externalId: 's2', measuredAt: at('13:00'), score: 64 },
            { externalId: 's3', measuredAt: at('18:00'), score: 35 },
        ]);
        expect(result.counts.stress).toBe(3);
        expect(result.days).toContain(DAY);

        const logs = await MetricLog.find({ userId, kind: 'stress' }).lean();
        expect(logs.map((l) => l.stress).sort((a, b) => a - b)).toEqual([22, 35, 64]);
        expect(logs.every((l) => l.source === 'bracelet' && l.day === DAY)).toBe(true);

        const rollup = await DailyMetrics.findOne({ userId, day: DAY }).lean();
        expect(rollup.stress).toEqual({ avg: 40, min: 22, max: 64, readings: 3 });
    });

    it('upserts a re-sent reading rather than duplicating it', async () => {
        const rows = [{ externalId: 's1', measuredAt: at('09:00'), score: 30 }];
        await bracelet(rows);
        await bracelet(rows);
        expect(await MetricLog.countDocuments({ userId, kind: 'stress' })).toBe(1);
        expect((await DailyMetrics.findOne({ userId, day: DAY }).lean()).stress.readings).toBe(1);
    });

    it('drops a reading off the scale without costing the batch', async () => {
        await bracelet([
            { externalId: 'zero', measuredAt: at('08:00'), score: 0 },
            { externalId: 'over', measuredAt: at('09:00'), score: 140 },
            { externalId: 'nan', measuredAt: at('10:00'), score: 'calm' },
            { externalId: 'noTime', score: 40 },
            { measuredAt: at('11:00'), score: 40 },
            { externalId: 'ok', measuredAt: at('12:00'), score: 41 },
        ], {
            spo2: [{ externalId: 'o1', measuredAt: at('12:00'), spo2: 97, context: 'automatic' }],
        });
        const logs = await MetricLog.find({ userId, kind: 'stress' }).lean();
        expect(logs.map((l) => l.externalId)).toEqual(['ok']);
        expect(await MetricLog.countDocuments({ userId, kind: 'spo2' })).toBe(1);
    });

    it('leaves a phone-store batch exactly as it was', async () => {
        const result = await ingestBatch({ userId, platform: 'health_connect', tzOffset: 0, days: [{ day: DAY, steps: 4000 }] });
        expect(result.counts.stress).toBe(0);
        const rollup = await DailyMetrics.findOne({ userId, day: DAY }).lean();
        expect(rollup.stress?.readings ?? 0).toBe(0);
    });
});

describe('a wrong band clock', () => {
    it('moves a stress reading stamped inside the fault, like every other family', () => {
        expect(INSTANT_FAMILIES.stress).toBe('measuredAt');
        const fault = {
            idPrefix: 'jstyle:AA:',
            skewSec: 3600,
            window: { from: new Date(at('09:00')), to: new Date(at('10:00')) },
            mode: 'shift',
            knownIds: [],
            shiftedIds: [],
            frozenDays: [],
        };
        const row = { externalId: 'jstyle:AA:stress:1', measuredAt: at('09:30'), score: 40 };
        const { body, report } = applyFaults({ stress: [row] }, [fault], { phoneAt: at('11:00'), freshIndex: 0 });
        expect(report.shifted).toBe(1);
        expect(body.stress[0].measuredAt).toBe(new Date(at('10:30')).toISOString());
    });
});

describe('the stress card', () => {
    const seed = (values) => DailyMetrics.insertMany(values.map(([ago, avg]) => ({
        userId, day: localDay(ago), stress: { avg, min: avg, max: avg, readings: 4 },
    })));
    const overview = async () => {
        const res = mockRes();
        await metrics.getOverview({ auth: { userId: String(userId) }, query: { tzOffset: '0' } }, res);
        return res.json.mock.calls[0][0].metrics;
    };
    const card = async () => (await overview()).find((m) => m.key === 'stress');

    it('is present with no value when no bracelet has reported one', async () => {
        expect(await card()).toMatchObject({ value: null, status: 'Connect a bracelet', loggable: false });
    });

    it('says it is still learning until five earlier days exist', async () => {
        await seed([[0, 40], [1, 30], [2, 31]]);
        const stress = await card();
        expect(stress.value).toBe(40);
        expect(stress.baseline).toBeNull();
        expect(stress.status).toBe('Learning your usual · 2 of 5 days');
    });

    it('compares with the median of the earlier days, never a band', async () => {
        await seed([[0, 52], ...Array.from({ length: 20 }, (_, i) => [i + 1, i % 2 ? 38 : 42])]);
        const stress = await card();
        expect(stress.baseline).toBe(40);
        expect(stress.status).toBe('Higher than your usual 40');
        expect(stress.status).not.toMatch(/high stress|low stress|normal/i);
        expect(stress.series).toHaveLength(7);
    });

    it('never narrows "near" below five points at the bottom of the scale', async () => {
        await seed([[0, 14], ...Array.from({ length: 10 }, (_, i) => [i + 1, 10])]);
        // 15% of 10 is 1.5; 14 is within the five-point floor.
        expect((await card()).status).toBe('Near your usual 10');
        await DailyMetrics.updateOne({ userId, day: localDay(0) }, { $set: { 'stress.avg': 4 } });
        expect((await card()).status).toBe('Lower than your usual 10');
    });

    it('sits beside HRV on the list', async () => {
        const keys = (await overview()).map((m) => m.key);
        expect(keys.indexOf('stress')).toBe(keys.indexOf('hrv') + 1);
    });
});

describe('the stress history', () => {
    it('lists each reading and attributes the number to the bracelet', async () => {
        const today = localDay(0);
        await MetricLog.insertMany([
            { userId, kind: 'stress', day: today, measuredAt: new Date(), stress: 33, source: 'bracelet', externalId: 'h1' },
        ]);
        await DailyMetrics.create({ userId, day: today, stress: { avg: 33, min: 33, max: 33, readings: 1 } });

        const res = mockRes();
        await metrics.getHistory({ auth: { userId: String(userId) }, params: { kind: 'stress' }, query: { tzOffset: '0' } }, res);
        const body = res.json.mock.calls[0][0];
        expect(body.label).toBe('Stress');
        expect(body.entries).toEqual([expect.objectContaining({ value: 33 })]);
        expect(body.series[body.series.length - 1]).toMatchObject({ value: 33 });
        expect(body.note).toMatch(/bracelet's own score/);
    });
});

describe('the score', () => {
    it('does not read the bracelet score anywhere', () => {
        // `mind` is self-report by design; a vendor figure must not displace it.
        const source = require('fs').readFileSync(require.resolve('../utils/labtrackScore'), 'utf8');
        expect(source).not.toMatch(/stressScore|\.stress\?\.|stress\.avg/);
        expect(Object.keys(labtrackScore.WEIGHTS)).not.toContain('stress');
    });

    it('reaches the observed profile as context', () => {
        const observed = derive({
            windowDays: 28,
            dailyMetrics: [
                { day: '2026-09-01', stress: { avg: 30, readings: 3 } },
                { day: '2026-09-02', stress: { avg: 50, readings: 2 } },
                { day: '2026-09-03', stress: { avg: null, readings: 0 } },
            ],
        });
        expect(observed).toMatchObject({ stressScore: 40, stressDays: 2 });
    });
});
