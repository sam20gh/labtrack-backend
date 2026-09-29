/**
 * A night that arrives in pieces is one night.
 *
 * The case this came from, 2026-09-29, UTC+4: the J-Style bracelet sent six ~2-hour records
 * for one night and a morning lie-in. Stored as six rows, the "night" was the longest block
 * (2h, score 36), two blocks were discarded as fragments, and the last block of the night was
 * filed as a nap. The fixtures below are those six rows as they were stored.
 *
 * Four things that go wrong silently if they regress:
 *
 * 1. **Touching pieces are one sleep, joined at ingest** — whether they arrive in one batch
 *    or across several, and whatever order.
 * 2. **A re-sent piece is not counted twice**, and a piece that comes back longer under the
 *    same id replaces its shorter self.
 * 3. **More than `STITCH_GAP_MIN` apart is a separate sleep** — the 78-minute gap before the
 *    lie-in makes it a nap.
 * 4. **Joining moves the day, and the day it left is recomputed.**
 */
const mongoose = require('mongoose');
const SleepSession = require('../models/SleepSession');
const DailyMetrics = require('../models/DailyMetrics');
const { ingestBatch, joinSleep } = require('../utils/healthSync');
const { clusterSessions, mergeSessions, STITCH_GAP_MIN } = require('../utils/sleepStitch');
const record = require('../utils/sleepRecord');
const insight = require('../utils/sleepInsight');

const userId = () => new mongoose.Types.ObjectId();
const TZ = -240; // UTC+4, as `getTimezoneOffset()` reports it

/** One bracelet block: stages laid end to end, in the order given. */
const block = (externalId, startedAt, stages) => {
    const segments = [];
    let t = new Date(startedAt).getTime();
    for (const [stage, minutes] of stages) {
        if (!minutes) continue;
        const end = t + minutes * 60_000;
        segments.push({ stage, startedAt: new Date(t).toISOString(), endedAt: new Date(end).toISOString() });
        t = end;
    }
    const inBedMin = stages.reduce((n, [, m]) => n + m, 0);
    const asleepMin = stages.filter(([s]) => s !== 'awake').reduce((n, [, m]) => n + m, 0);
    return {
        externalId,
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date(t).toISOString(),
        segments,
        asleepMin,
        inBedMin,
        sourceDevice: { name: 'J-Style V8' },
    };
};

// The six rows stored on 2026-09-29, in UTC. Local times are four hours later.
const A = block('jstyle:sleep:A', '2026-09-28T20:23:01Z', [['deep', 24], ['light', 57], ['rem', 28], ['awake', 11]]);
const B = block('jstyle:sleep:B', '2026-09-28T22:23:01Z', [['deep', 36], ['light', 60], ['rem', 24]]);
const C = block('jstyle:sleep:C', '2026-09-29T00:23:01Z', [['deep', 32], ['light', 53], ['rem', 35]]);
// Starts two seconds before C ends — the bracelet's blocks overlap at the seam.
const D = block('jstyle:sleep:D', '2026-09-29T02:22:59Z', [['light', 22], ['rem', 21]]);
// 78 minutes after D: back to bed.
const E = block('jstyle:sleep:E', '2026-09-29T04:23:01Z', [['light', 92], ['rem', 24], ['awake', 4]]);
const F = block('jstyle:sleep:F', '2026-09-29T06:23:01Z', [['light', 20]]);
const DAY = [A, B, C, D, E, F];

const sync = (id, sleep) => ingestBatch({
    userId: id, platform: 'jstyle_bracelet', tzOffset: TZ, sleep, goalMinutes: 360,
});

const stored = (id) => SleepSession.find({ userId: id }).sort({ startedAt: 1 }).lean();

describe('the day it came from', () => {
    it('is one night and one lie-in, not six nights', async () => {
        const id = userId();
        await sync(id, DAY);

        const rows = await stored(id);
        expect(rows).toHaveLength(2);

        const [night, lieIn] = rows;
        expect(night.asleepMin).toBe(109 + 120 + 120 + 43);
        expect(night.parts.map((p) => p.externalId)).toEqual([A, B, C, D].map((b) => b.externalId));
        expect(night.externalId).toBe(A.externalId);
        expect(night.stages).toEqual({ deepMin: 92, remMin: 108, lightMin: 192, awakeMin: 11 });
        expect(night.day).toBe('2026-09-29');
        expect(night.score).toBeGreaterThan(36);

        expect(lieIn.asleepMin).toBe(116 + 20);
        expect(lieIn.parts).toHaveLength(2);
    });

    it('puts the whole night in the rollup', async () => {
        const id = userId();
        await sync(id, DAY);
        const rollup = await DailyMetrics.findOne({ userId: id, day: '2026-09-29' }).lean();
        expect(rollup.sleep.asleepMin).toBe(392);
        expect(rollup.sleep.sessions).toBe(2);
    });

    it('draws the lie-in as a nap and counts it toward the day', async () => {
        const id = userId();
        await sync(id, DAY);
        const out = record.buildRecord({
            sessions: await stored(id), days: ['2026-09-29'], range: '1d', goalMinutes: 360, tzOffset: TZ,
        });
        expect(out.series[0].asleepMin).toBe(392);
        expect(out.summary.naps.count).toBe(1);
        expect(out.summary.naps.totalMin).toBe(136);
        expect(out.series[0].totalAsleepMin).toBe(528);
    });
});

describe('across syncs', () => {
    it('joins a night that arrived in two syncs', async () => {
        const id = userId();
        await sync(id, [A, B]);
        await sync(id, [C, D, E, F]);

        const rows = await stored(id);
        expect(rows.map((r) => r.asleepMin)).toEqual([392, 136]);
        expect(rows[0].externalId).toBe(A.externalId);
    });

    it('joins whatever order the pieces arrive in', async () => {
        const id = userId();
        await sync(id, [C, D]);
        await sync(id, [A, B]);
        const rows = await stored(id);
        expect(rows).toHaveLength(1);
        expect(rows[0].asleepMin).toBe(392);
        // Identity is the earliest piece, not the first to arrive.
        expect(rows[0].externalId).toBe(A.externalId);
    });

    it('does not count a re-sent piece twice', async () => {
        const id = userId();
        await sync(id, DAY);
        await sync(id, [B]);
        await sync(id, DAY);
        expect((await stored(id)).map((r) => r.asleepMin)).toEqual([392, 136]);
    });

    it('takes the longer copy of a piece that was still being recorded', async () => {
        const id = userId();
        const partial = block(F.externalId, F.startedAt, [['light', 7]]);
        await sync(id, [E, partial]);
        expect((await stored(id))[0].asleepMin).toBe(123);

        await sync(id, [F]);
        expect((await stored(id))[0].asleepMin).toBe(136);
    });

    it('recomputes the day a piece left', async () => {
        // A block that ended before midnight local is filed under that day on its own…
        const id = userId();
        const evening = block('jstyle:sleep:eve', '2026-09-28T17:55:01Z', [['light', 120]]);
        await sync(id, [evening]);
        expect((await stored(id))[0].day).toBe('2026-09-28');

        // …and moves to the wake day once the rest of the night arrives.
        await sync(id, [A, B]);
        const rows = await stored(id);
        expect(rows).toHaveLength(1);
        expect(rows[0].day).toBe('2026-09-29');
        const left = await DailyMetrics.findOne({ userId: id, day: '2026-09-28' }).lean();
        expect(left.sleep.sessions).toBe(0);
    });
});

describe('rows stored before joining existed', () => {
    const storeSeparately = async (id) => {
        for (const b of DAY) {
            await SleepSession.create({
                userId: id,
                ...b,
                day: '2026-09-29',
                source: 'jstyle_bracelet',
                stages: mergeSessions([b]).stages,
            });
        }
    };

    it('heal on the next sync that touches them', async () => {
        const id = userId();
        await storeSeparately(id);
        await sync(id, [F]);
        expect((await stored(id)).map((r) => r.asleepMin)).toEqual([392, 136]);
    });

    it('are repaired by the script’s call, with no batch at all', async () => {
        const id = userId();
        await storeSeparately(id);
        const days = await joinSleep(id, [], {
            source: 'jstyle_bracelet',
            tzOffset: TZ,
            window: { from: new Date('2026-09-28T00:00:00Z'), to: new Date('2026-09-30T00:00:00Z') },
        });
        expect([...days]).toEqual(['2026-09-29']);
        expect((await stored(id)).map((r) => r.asleepMin)).toEqual([392, 136]);
    });

    it('a second repair changes nothing', async () => {
        const id = userId();
        await storeSeparately(id);
        const window = { from: new Date('2026-09-28T00:00:00Z'), to: new Date('2026-09-30T00:00:00Z') };
        await joinSleep(id, [], { source: 'jstyle_bracelet', tzOffset: TZ, window });
        const before = await stored(id);
        const days = await joinSleep(id, [], { source: 'jstyle_bracelet', tzOffset: TZ, window });
        expect(days.size).toBe(0);
        expect((await stored(id)).map((r) => r.updatedAt)).toEqual(before.map((r) => r.updatedAt));
    });
});

describe('the join itself', () => {
    const at = (min) => new Date(Date.UTC(2026, 8, 29, 0, min)).toISOString();
    const piece = (from, to, over = {}) => ({ startedAt: at(from), endedAt: at(to), asleepMin: to - from, ...over });

    it(`joins across a gap of ${STITCH_GAP_MIN} minutes and not one minute more`, () => {
        expect(clusterSessions([piece(0, 60), piece(60 + STITCH_GAP_MIN, 120)])).toHaveLength(1);
        expect(clusterSessions([piece(0, 60), piece(61 + STITCH_GAP_MIN, 150)])).toHaveLength(2);
    });

    it('counts the gap as time in bed, never as sleep', () => {
        const m = mergeSessions([piece(0, 60), piece(80, 140)]);
        expect(m.asleepMin).toBe(120);
        expect(m.inBedMin).toBe(140);
    });

    it('reports a stage total only when every piece reported it', () => {
        const m = mergeSessions([
            piece(0, 60, { stages: { deepMin: 20, remMin: 10, lightMin: 30, awakeMin: 0 } }),
            piece(60, 120, { stages: { deepMin: null, remMin: null, lightMin: null, awakeMin: null } }),
        ]);
        expect(m.stages.deepMin).toBeNull();
        expect(m.efficiency).toBeNull();
    });
});

describe('the record screen joins what ingest could not', () => {
    // A hand-entered night beside a device one, or rows stored before joining — read as-is.
    const rows = DAY.map((b, i) => ({
        _id: new mongoose.Types.ObjectId(),
        ...b,
        day: '2026-09-29',
        stages: mergeSessions([b]).stages,
        score: 30 + i,
    }));

    it('finds the whole night and one nap', () => {
        const { night, naps } = record.classifyDay(rows, TZ, { goalMinutes: 360 });
        expect(night.asleepMin).toBe(392);
        expect(night.partIds).toHaveLength(4);
        expect(naps).toHaveLength(1);
        expect(naps[0].asleepMin).toBe(136);
    });

    it('rescores the joined night rather than keeping a piece’s score', () => {
        const { night } = record.classifyDay(rows, TZ, { goalMinutes: 360 });
        expect(night.score).toBeGreaterThan(60);
    });
});

describe('the week-over-week comparison', () => {
    const nights = (n, asleepMin) => Array.from({ length: n }, () => ({ asleepMin }));

    it('says nothing when either week has fewer than three nights', () => {
        const cmp = insight.comparePeriods(nights(6, 339), nights(1, 37), 'asleepMin');
        expect(cmp.deltaPct).toBeNull();
        expect(cmp.tooFewNights).toBe(true);
    });

    it('compares once both weeks have enough', () => {
        const cmp = insight.comparePeriods(nights(3, 420), nights(3, 400), 'asleepMin');
        expect(cmp.deltaPct).toBe(5);
    });
});
