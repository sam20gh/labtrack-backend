/**
 * The stress indicator, check-ins and the clinician's summary.
 *
 * What has to hold:
 *   - Green means calmer than this person's usual and red more stressed than it — never a
 *     level on a fixed scale. No usual (under five earlier days), no colour.
 *   - "Near" is never narrower than five points.
 *   - Every coloured level carries words, so the colour is never the only signal.
 *   - The history screen colours against the same usual the card does, whatever window it draws.
 *   - A check-in keeps the bracelet's nearest reading as it stood, or none if nothing was close.
 *   - Somebody else's check-in answers 404.
 */
const mongoose = require('mongoose');
const MetricLog = require('../models/MetricLog');
const DailyMetrics = require('../models/DailyMetrics');
const StressCheckIn = require('../models/StressCheckIn');
const User = require('../models/userModel');
const metrics = require('../controllers/metricsController');
const stressLevel = require('../utils/stressLevel');

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

const seedDays = (values) => DailyMetrics.insertMany(values.map(([ago, avg]) => ({
    userId, day: localDay(ago), stress: { avg, min: avg, max: avg, readings: 3 },
})));

describe('the table', () => {
    it('has no colour without a usual', () => {
        expect(stressLevel.baselineOf([30, 31, 32, 33])).toBeNull();
        expect(stressLevel.levelFor(80, null)).toBeNull();
    });

    it('is relative to the usual, with a five-point floor', () => {
        expect(stressLevel.baselineOf([30, 40, 50, 35, 45])).toBe(40);
        // 15% of 40 is 6.
        expect(stressLevel.levelFor(46, 40).key).toBe('usual');
        expect(stressLevel.levelFor(46, 40).colour).toBeNull();
        expect(stressLevel.levelFor(46.1, 40).key).toBe('above');
        expect(stressLevel.levelFor(33, 40).key).toBe('below');
        // 15% of 10 is 1.5; the floor keeps 14 near usual.
        expect(stressLevel.levelFor(14, 10).key).toBe('usual');
    });

    it('words every level relative to the usual, never as a state', () => {
        for (const level of Object.values(stressLevel.LEVELS)) {
            expect(level.label).toMatch(/usual/i);
            expect(level.label).not.toMatch(/^stressed$/i);
        }
        expect(stressLevel.LEVELS.above.colour).not.toBe(stressLevel.LEVELS.below.colour);
    });
});

describe('the history screen', () => {
    it('colours today against the 28 days before it, even on a one-week window', async () => {
        // Usual 40 from three weeks ago — outside a 7-day window.
        await seedDays([[0, 60], ...Array.from({ length: 8 }, (_, i) => [i + 14, 40])]);
        const now = new Date();
        await MetricLog.insertMany([
            { userId, kind: 'stress', day: localDay(0), measuredAt: new Date(now - 3 * 3600000), stress: 30, source: 'bracelet', externalId: 'a' },
            { userId, kind: 'stress', day: localDay(0), measuredAt: new Date(now - 2 * 3600000), stress: 42, source: 'bracelet', externalId: 'b' },
            { userId, kind: 'stress', day: localDay(0), measuredAt: new Date(now - 3600000), stress: 70, source: 'bracelet', externalId: 'c' },
        ]);

        const res = mockRes();
        await metrics.getHistory({ auth: { userId: String(userId) }, params: { kind: 'stress' }, query: { tzOffset: '0', days: '7' } }, res);
        const body = res.json.mock.calls[0][0];

        expect(body.baseline).toBe(40);
        expect(body.level).toMatchObject({ key: 'above', colour: '#EF4444' });
        expect(body.intraday.day).toBe(localDay(0));
        expect(body.intraday.readings.map((r) => r.level)).toEqual(['below', 'usual', 'above']);
        expect(body.entries[0]).toMatchObject({ value: 70, label: 'Stressed', colour: '#EF4444' });
        expect(body.feelings).toHaveLength(5);
    });

    it('draws no colour while it is still learning', async () => {
        await seedDays([[0, 60], [1, 40]]);
        await MetricLog.create({ userId, kind: 'stress', day: localDay(0), measuredAt: new Date(), stress: 60, source: 'bracelet', externalId: 'a' });
        const res = mockRes();
        await metrics.getHistory({ auth: { userId: String(userId) }, params: { kind: 'stress' }, query: { tzOffset: '0' } }, res);
        const body = res.json.mock.calls[0][0];
        expect(body.baseline).toBeNull();
        expect(body.level).toBeNull();
        expect(body.intraday.readings[0].level).toBeNull();
    });
});

describe('check-ins', () => {
    const checkIn = async (body, who = userId) => {
        const res = mockRes();
        await metrics.logStressCheckIn({ auth: { userId: String(who) }, body: { tzOffset: 0, ...body } }, res);
        return { status: res.status.mock.calls[0]?.[0] ?? 200, body: res.json.mock.calls[0][0] };
    };

    it('stores the feeling beside the nearest bracelet reading as it stood', async () => {
        await MetricLog.insertMany([
            { userId, kind: 'stress', day: localDay(0), measuredAt: new Date(Date.now() - 40 * 60000), stress: 55, source: 'bracelet', externalId: 'far' },
            { userId, kind: 'stress', day: localDay(0), measuredAt: new Date(Date.now() - 10 * 60000), stress: 62, source: 'bracelet', externalId: 'near' },
        ]);
        const { status, body } = await checkIn({ feeling: 4, note: '  big meeting  ' });
        expect(status).toBe(201);
        expect(body.checkIn).toMatchObject({ feeling: 4, feelingLabel: 'Stressed', deviceScore: 62, note: 'big meeting' });
    });

    it('stores none when nothing was close', async () => {
        await MetricLog.create({ userId, kind: 'stress', day: localDay(0), measuredAt: new Date(Date.now() - 3 * 3600000), stress: 55, source: 'bracelet', externalId: 'old' });
        const { body } = await checkIn({ feeling: 1 });
        expect(body.checkIn.deviceScore).toBeNull();
    });

    it('refuses a feeling off the scale', async () => {
        expect((await checkIn({ feeling: 9 })).status).toBe(400);
        expect((await checkIn({})).status).toBe(400);
    });

    it('appears on the history screen, and a stranger cannot delete it', async () => {
        const { body } = await checkIn({ feeling: 2 });
        const res = mockRes();
        await metrics.getHistory({ auth: { userId: String(userId) }, params: { kind: 'stress' }, query: { tzOffset: '0' } }, res);
        expect(res.json.mock.calls[0][0].checkIns).toEqual([expect.objectContaining({ feelingLabel: 'Okay' })]);

        const stranger = mockRes();
        await metrics.deleteStressCheckIn({ auth: { userId: String(new mongoose.Types.ObjectId()) }, params: { id: body.checkIn.id } }, stranger);
        expect(stranger.status).toHaveBeenCalledWith(404);
        expect(await StressCheckIn.countDocuments({ userId })).toBe(1);

        const owner = mockRes();
        await metrics.deleteStressCheckIn({ auth: { userId: String(userId) }, params: { id: body.checkIn.id } }, owner);
        expect(await StressCheckIn.countDocuments({ userId })).toBe(0);
    });
});

describe('the clinician summary', () => {
    it('is null with nothing to show', async () => {
        expect(await metrics.stressSummary(userId)).toBeNull();
    });

    it('carries the days, the usual, the level and the check-ins', async () => {
        await seedDays([[0, 60], ...Array.from({ length: 6 }, (_, i) => [i + 1, 40])]);
        await StressCheckIn.create({ userId, at: new Date(), day: localDay(0), feeling: 3 });
        const summary = await metrics.stressSummary(userId);
        expect(summary.baseline).toBe(40);
        expect(summary.level).toEqual({ key: 'above', label: 'More stressed than usual' });
        expect(summary.days).toHaveLength(7);
        expect(summary.checkIns[0].feelingLabel).toBe('Tense');
    });
});
