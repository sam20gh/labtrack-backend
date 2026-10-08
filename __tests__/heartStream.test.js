/**
 * A bracelet's continuous heart rate, stored per record — `healthSync.ingestHeartStream`.
 *
 * What has to hold, because the phone now frees the band of this series after every sync:
 *   - A day posted in pieces across syncs adds up to the whole day, never the last piece.
 *   - Re-sending a record changes nothing.
 *   - The spread rebuilt from the records wins over the per-day figure the phone still sends.
 *   - A malformed record is skipped, never rejected with the batch.
 *   - The response says the stream was stored — the phone frees the band only if it does.
 *   - A day frozen by a clock fault keeps its stream out like its day totals.
 */
const mongoose = require('mongoose');
const DailyMetrics = require('../models/DailyMetrics');
const HeartStream = require('../models/HeartStream');
const User = require('../models/userModel');
const { ingestBatch, spreadOf } = require('../utils/healthSync');
const { applyFaults } = require('../utils/clockFault');

const DAY = '2026-10-08';
const ms = (hh, mm = 0) => String(new Date(`${DAY}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`).getTime());

let userId;
beforeEach(async () => {
    userId = new mongoose.Types.ObjectId();
    await User.create({ _id: userId, username: `u${userId}`, email: `${userId}@example.com`, password: 'x' });
});

const post = (heartStream, extra = {}) => ingestBatch({ userId, platform: 'jstyle_bracelet', tzOffset: 0, heartStream, ...extra });
const heart = async () => (await DailyMetrics.findOne({ userId, day: DAY }).lean()).heart;

describe('the day is the sum of its records', () => {
    it('rebuilds the spread from every record the day holds', async () => {
        const result = await post([{ day: DAY, blocks: { [ms(8)]: [15, 900, 55, 65], [ms(9)]: [15, 1200, 70, 95] } }]);
        expect(result.counts.heartStream).toBe(1);
        expect(result.days).toContain(DAY);
        expect(await heart()).toMatchObject({ minBpm: 55, maxBpm: 95, avgBpm: 70, spreadSource: 'device' });
    });

    it('adds a later piece to the morning instead of replacing it', async () => {
        await post([{ day: DAY, blocks: { [ms(8)]: [15, 900, 55, 65] } }]);
        // The band was freed; the next sync carries only the afternoon.
        await post([{ day: DAY, blocks: { [ms(15)]: [15, 1500, 90, 110] } }]);
        expect(await heart()).toMatchObject({ minBpm: 55, maxBpm: 110, avgBpm: 80 });
    });

    it('changes nothing when a record is sent again', async () => {
        const row = { day: DAY, blocks: { [ms(8)]: [15, 900, 55, 65] } };
        await post([row]);
        await post([row]);
        const doc = await HeartStream.findOne({ userId, day: DAY }).lean();
        expect(Object.keys(doc.blocks)).toHaveLength(1);
        expect(await heart()).toMatchObject({ avgBpm: 60 });
    });

    it('wins over the per-day figure the phone sends for older servers', async () => {
        await post([{ day: DAY, blocks: { [ms(8)]: [15, 900, 55, 65], [ms(15)]: [15, 1500, 90, 110] } }]);
        // A later sync's per-day figure covers only what was left on the band.
        await post([{ day: DAY, blocks: { [ms(16)]: [15, 1500, 95, 105] } }], {
            days: [{ day: DAY, minBpm: 95, maxBpm: 105, avgBpm: 100 }],
        });
        expect(await heart()).toMatchObject({ minBpm: 55, maxBpm: 110 });
    });

    it('is not rebuilt from spot readings afterwards', async () => {
        await post([{ day: DAY, blocks: { [ms(8)]: [15, 900, 55, 65] } }], {
            heart: [{ externalId: 'spot1', measuredAt: `${DAY}T12:00:00Z`, bpm: 120, context: 'resting' }],
        });
        expect(await heart()).toMatchObject({ minBpm: 55, maxBpm: 65, spreadSource: 'device' });
    });
});

describe('what is skipped', () => {
    it('drops malformed keys and impossible tuples and keeps the rest', async () => {
        await post([
            { day: 'not-a-day', blocks: { [ms(8)]: [15, 900, 55, 65] } },
            {
                day: DAY,
                blocks: {
                    'x.y': [15, 900, 55, 65],
                    [ms(7)]: [15, 900, 10, 65],
                    [ms(8)]: [15, 900, 55, 65],
                    [ms(9)]: [0, 0, 0, 0],
                    [ms(10)]: [15, 3000, 55, 65],
                    [ms(11)]: 'sixty',
                },
            },
        ]);
        const doc = await HeartStream.findOne({ userId, day: DAY }).lean();
        expect(Object.keys(doc.blocks)).toEqual([ms(8)]);
        expect(await HeartStream.countDocuments({ userId })).toBe(1);
    });

    it('reports the family even when a batch carries none of it', async () => {
        const result = await ingestBatch({ userId, platform: 'health_connect', tzOffset: 0, days: [{ day: DAY, steps: 10 }] });
        expect(result.counts).toHaveProperty('heartStream', 0);
    });

    it('spreadOf is null for nothing', () => {
        expect(spreadOf({})).toBeNull();
        expect(spreadOf(undefined)).toBeNull();
    });
});

describe('a frozen day', () => {
    it('keeps its stream out like its day totals', () => {
        const fault = { idPrefix: 'jstyle:AA:', skewSec: 3600, window: { from: new Date(), to: new Date() }, mode: 'shift', knownIds: [], shiftedIds: [], frozenDays: [DAY] };
        const { body, report } = applyFaults({
            days: [{ day: DAY, steps: 1 }],
            heartStream: [{ day: DAY, blocks: {} }, { day: '2026-10-09', blocks: {} }],
        }, [fault], { phoneAt: new Date(), freshIndex: 0 });
        expect(body.heartStream.map((r) => r.day)).toEqual(['2026-10-09']);
        expect(body.days).toEqual([]);
        expect(report.daysDropped).toBe(2);
    });
});
