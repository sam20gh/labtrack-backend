/**
 * The Sleep Record — nights and naps, stacked and bucketed.
 *
 * Four things that go wrong silently if they regress:
 *
 * 1. **A split night is not a nap.** The shorter half of a disturbed night starts before
 *    dawn; calling it a nap would double-count sleep somebody already had.
 * 2. **A stacked bar sums to the time asleep.** A source with only a total must still draw a
 *    full-height bar, as "no stage data", not a stub.
 * 3. **Null, never zero.** A day nothing was recorded on has no bar, and no goal means no
 *    "0 of 7 nights met".
 * 4. **A year is weeks and all-time is months**, with the newest week ending on the last day.
 */
const mongoose = require('mongoose');
const SleepSession = require('../models/SleepSession');
const SleepPlan = require('../models/SleepPlan');
const sleepController = require('../controllers/sleepController');
const record = require('../utils/sleepRecord');

const id = () => new mongoose.Types.ObjectId();

const session = (over = {}) => ({
    _id: id(),
    day: '2026-08-20',
    startedAt: '2026-08-19T22:30:00.000Z',
    endedAt: '2026-08-20T06:30:00.000Z',
    asleepMin: 450,
    inBedMin: 480,
    efficiency: 94,
    score: 82,
    stages: { deepMin: 90, remMin: 105, lightMin: 255, awakeMin: 30 },
    ...over,
});

const nap = (over = {}) => session({
    startedAt: '2026-08-20T14:00:00.000Z',
    endedAt: '2026-08-20T14:40:00.000Z',
    asleepMin: 40,
    inBedMin: 40,
    efficiency: null,
    score: null,
    stages: {},
    ...over,
});

const call = async (handler, { user, query = {} } = {}) => {
    let payload = null;
    let code = 200;
    const res = {
        status(c) { code = c; return this; },
        json(p) { payload = p; return this; },
    };
    await handler({ user, query, params: {}, body: {} }, res);
    return { code, body: payload };
};

describe('what counts as a nap', () => {
    it('a short afternoon session is a nap and does not replace the night', () => {
        const { night, naps } = record.classifyDay([session(), nap()], 0);
        expect(night.asleepMin).toBe(450);
        expect(naps).toHaveLength(1);
    });

    it('the pre-dawn half of a split night is not a nap', () => {
        const fragment = nap({ startedAt: '2026-08-20T05:30:00.000Z', endedAt: '2026-08-20T07:00:00.000Z', asleepMin: 90 });
        expect(record.isNap(fragment, 0)).toBe(false);
    });

    it('a day sleep after a night shift is the main sleep, not a nap', () => {
        const daySleep = session({ startedAt: '2026-08-20T09:00:00.000Z', endedAt: '2026-08-20T15:00:00.000Z', asleepMin: 340 });
        const { night, naps } = record.classifyDay([daySleep], 0);
        expect(night).not.toBeNull();
        expect(naps).toHaveLength(0);
    });

    it('reads the start in local time, not UTC', () => {
        // 14:00 UTC is 07:00 in Los Angeles (tzOffset 420) — a lie-in, not a nap.
        expect(record.isNap(nap(), 420)).toBe(false);
        expect(record.isNap(nap(), 0)).toBe(true);
    });
});

describe('a nap just outside the core window', () => {
    // The day reported on 2026-09-24: a 01:05–06:58 night and an 08:42–10:39 nap.
    const night = session({
        day: '2026-09-24', startedAt: '2026-09-24T01:05:00.000Z', endedAt: '2026-09-24T06:58:00.000Z',
        asleepMin: 353, inBedMin: 353,
    });
    const morning = nap({
        day: '2026-09-24', startedAt: '2026-09-24T08:42:00.000Z', endedAt: '2026-09-24T10:39:00.000Z',
        asleepMin: 117, inBedMin: 117,
    });

    it('is a nap when it is well clear of the night, even starting before 09:00', () => {
        const { night: n, naps } = record.classifyDay([night, morning], 0);
        expect(n.asleepMin).toBe(353);
        expect(naps).toHaveLength(1);
        expect(naps[0].asleepMin).toBe(117);
    });

    it('counts toward the day total and the goal', () => {
        const out = record.buildRecord({
            sessions: [night, morning], days: ['2026-09-24'], range: '1d', goalMinutes: 470, tzOffset: 0,
        });
        expect(out.series[0].asleepMin).toBe(353);
        expect(out.series[0].totalAsleepMin).toBe(470);
        expect(out.summary.totalSleep.avgMin).toBe(470);
        expect(out.summary.naps.count).toBe(1);
        expect(out.summary.goal.met).toBe(1);
    });

    it('a fragment touching the night is still part of the night, not a nap', () => {
        const fragment = nap({
            day: '2026-09-24', startedAt: '2026-09-24T07:20:00.000Z', endedAt: '2026-09-24T08:10:00.000Z', asleepMin: 50,
        });
        const { naps } = record.classifyDay([night, fragment], 0);
        expect(naps).toHaveLength(0);
    });

    it('before 06:00 is never a nap, however far from the night', () => {
        const early = nap({ startedAt: '2026-08-20T05:00:00.000Z', endedAt: '2026-08-20T05:40:00.000Z', asleepMin: 40 });
        const late = session({ startedAt: '2026-08-20T08:00:00.000Z', endedAt: '2026-08-20T13:00:00.000Z', asleepMin: 290 });
        expect(record.classifyDay([late, early], 0).naps).toHaveLength(0);
    });
});

describe('the stacked bar', () => {
    it('sums the asleep stages to the time asleep and leaves awake on top', () => {
        const s = record.stackNight(session());
        expect(s.deepMin + s.remMin + s.lightMin + s.unstagedMin).toBe(450);
        expect(s.awakeMin).toBe(30);
    });

    it('draws a total-only night as unstaged, full height', () => {
        const s = record.stackNight(session({ stages: {} }));
        expect(s.unstagedMin).toBe(450);
        expect(s.deepMin).toBeNull();
        expect(s.staged).toBe(false);
    });

    it('a day with nothing recorded is null, not a zero-height bar', () => {
        const out = record.buildRecord({
            sessions: [session()], days: ['2026-08-19', '2026-08-20'], range: '1w', tzOffset: 0,
        });
        expect(out.series[0].asleepMin).toBeNull();
        expect(out.series[0].napMin).toBeNull();
        expect(out.series[1].asleepMin).toBe(450);
    });
});

describe('the summary', () => {
    it('counts naps separately and never folds them into the night average', () => {
        const out = record.buildRecord({
            sessions: [session(), nap()], days: ['2026-08-20'], range: '1d', goalMinutes: 480, tzOffset: 0,
        });
        expect(out.summary.avgAsleepMin).toBe(450);
        expect(out.summary.naps).toMatchObject({ count: 1, totalMin: 40, days: 1 });
        expect(out.series[0].naps).toHaveLength(1);
    });

    it('has no goal reading without a goal', () => {
        const out = record.buildRecord({ sessions: [session()], days: ['2026-08-20'], range: '1d' });
        expect(out.summary.goal).toBeNull();
    });

    it('averages bedtime around the dial, not through midday', () => {
        const a = session({ _id: id(), day: '2026-08-20', startedAt: '2026-08-19T23:40:00.000Z' });
        const b = session({ _id: id(), day: '2026-08-21', startedAt: '2026-08-21T00:20:00.000Z', endedAt: '2026-08-21T07:00:00.000Z' });
        const out = record.buildRecord({ sessions: [a, b], days: ['2026-08-20', '2026-08-21'], range: '1w' });
        expect(out.summary.bedtime.avgMin).toBe(0);
    });

    it('names the longest and shortest nights', () => {
        const long = session({ _id: id(), day: '2026-08-20', asleepMin: 510 });
        const short = session({ _id: id(), day: '2026-08-21', asleepMin: 320 });
        const out = record.buildRecord({ sessions: [long, short], days: ['2026-08-20', '2026-08-21'], range: '1w' });
        expect(out.summary.highlights.longest).toMatchObject({ day: '2026-08-20', value: 510 });
        expect(out.summary.highlights.shortest).toMatchObject({ day: '2026-08-21', value: 320 });
    });
});

describe('buckets', () => {
    it('a year is weeks, newest ending on the last day', () => {
        const days = Array.from({ length: 364 }, (_, i) =>
            new Date(Date.UTC(2025, 8, 1) + i * 86_400_000).toISOString().slice(0, 10));
        const chunks = record.chunkDays(days, 'week');
        expect(chunks).toHaveLength(52);
        expect(chunks.every((c) => c.length === 7)).toBe(true);
        expect(chunks[51][6]).toBe(days[363]);
    });

    it('all-time is months', () => {
        const chunks = record.chunkDays(['2026-07-30', '2026-07-31', '2026-08-01'], 'month');
        expect(chunks).toEqual([['2026-07-30', '2026-07-31'], ['2026-08-01']]);
    });
});

describe('GET /sleep/record', () => {
    it('returns the day with its timeline, and pages back only when there is something earlier', async () => {
        const userId = id();
        await SleepPlan.create({ userId, goalMinutes: 480 });
        await SleepSession.create([
            { ...session(), _id: undefined, userId, source: 'manual' },
            { ...nap(), _id: undefined, userId, source: 'manual' },
            { ...session({ day: '2026-08-10', startedAt: '2026-08-09T22:30:00.000Z', endedAt: '2026-08-10T06:30:00.000Z' }), _id: undefined, userId, source: 'manual' },
        ]);

        const { code, body } = await call(sleepController.getRecord, {
            user: { id: String(userId) }, query: { range: '1d', end: '2026-08-20', tzOffset: '0' },
        });

        expect(code).toBe(200);
        expect(body.days).toEqual(['2026-08-20']);
        expect(body.timeline.map((t) => t.kind)).toEqual(['night', 'nap']);
        // 450 asleep at night + a 40-minute nap = 490: the goal is judged on the day's total.
        expect(body.summary.goal).toMatchObject({ minutes: 480, met: 1, nights: 1, includesNaps: true });
        expect(body.previousEnd).toBe('2026-08-19');
        expect(body.nextEnd).toBe('2026-08-21');
    });

    it('clamps a future end to today', async () => {
        const { body } = await call(sleepController.getRecord, {
            user: { id: String(id()) }, query: { range: '1w', end: '2999-01-01', tzOffset: '0' },
        });
        expect(body.end).toBe(body.today);
        expect(body.nextEnd).toBeNull();
        expect(body.previousEnd).toBeNull();
        expect(body.series).toHaveLength(7);
    });

    it('all-time runs from the first night, bucketed by month', async () => {
        const userId = id();
        await SleepSession.create({ ...session({ day: '2026-06-15' }), _id: undefined, userId, source: 'manual' });
        const { body } = await call(sleepController.getRecord, {
            user: { id: String(userId) }, query: { range: 'all', tzOffset: '0' },
        });
        expect(body.bucket).toBe('month');
        expect(body.days[0]).toBe('2026-06-15');
        expect(body.series[0].from).toBe('2026-06-15');
    });
});
