/**
 * Readings a bracelet stamped while its own clock was wrong — `utils/clockFault.js`.
 *
 * The replay at the bottom is the real case, 2026-10-01: a V8 went back to 20:33 the evening
 * before (16:33Z) at a 07:07 sync and was set right at the 08:44 one, by which time it had
 * recorded a morning nap and filed it under the night before. What has to hold:
 *
 *   - A clock off by more than the tolerance is a fault; drift, a missing reading, and a
 *     phone-store batch are not.
 *   - Inside a window nothing genuine can be stamped in, every new row is moved by the skew,
 *     and the band's re-send of it next sync lands on the same row.
 *   - A row stored before the fault is never re-ingested — its mis-stamped twin carries the
 *     same id, and letting it through overwrites the genuine value.
 *   - When the window reaches into real time since the clock was last set, nothing is filed
 *     on a guess: the rows are held on the fault.
 *   - Whole-day figures for a day the band wrongly believed it was in are frozen.
 */
const mongoose = require('mongoose');
const ClockFault = require('../models/ClockFault');
const SleepSession = require('../models/SleepSession');
const MetricLog = require('../models/MetricLog');
const DailyMetrics = require('../models/DailyMetrics');
const User = require('../models/userModel');
const { ingestBatch } = require('../utils/healthSync');
const {
    detectFault, applyFaults, shiftRow, prepareBraceletBatch, CLOCK_TOLERANCE_SEC,
} = require('../utils/clockFault');

const DEVICE = 'C4:2B:8B:9A:B5:88';
const id = (kind, iso) => `jstyle:${DEVICE}:${kind}:${Date.parse(iso)}`;
/** UTC+4, as `getTimezoneOffset()` reports it. */
const TZ = -240;
/** 10h 34m 40s: the measured skew. */
const SKEW = 38080;
const plus = (iso, sec) => new Date(Date.parse(iso) + sec * 1000).toISOString();

describe('detectFault', () => {
    const clock = (bandAt, phoneAt, lastSetAt) => ({ deviceId: DEVICE, bandAt, phoneAt, lastSetAt });

    it('is null for drift inside the tolerance, a missing reading, and no clock at all', () => {
        const phone = '2026-10-01T04:44:40.000Z';
        expect(detectFault(clock(plus(phone, -(CLOCK_TOLERANCE_SEC - 5)), phone, '2026-10-01T03:07:00Z'))).toBeNull();
        expect(detectFault(clock(null, phone, '2026-10-01T03:07:00Z'))).toBeNull();
        expect(detectFault(undefined)).toBeNull();
        expect(detectFault({ bandAt: phone, phoneAt: phone })).toBeNull();
    });

    it('measures the skew and the band-time window from the last set', () => {
        const fault = detectFault(clock(
            '2026-09-30T18:10:00.000Z', '2026-10-01T04:44:40.000Z', '2026-10-01T03:07:00.000Z',
        ), { tzOffset: TZ });

        expect(fault.skewSec).toBe(SKEW);
        expect(fault.idPrefix).toBe(`jstyle:${DEVICE}:`);
        // 1h 37m 40s of real time since the set, run back on the band's clock, ± 2 min.
        expect(fault.window.from.toISOString()).toBe('2026-09-30T16:30:20.000Z');
        expect(fault.window.to.toISOString()).toBe('2026-09-30T18:12:00.000Z');
        // The whole window is before 03:07 today: nothing genuine can be stamped in it.
        expect(fault.mode).toBe('shift');
        // 30 Sept, in UTC+4. Today is not frozen; it is still being counted.
        expect(fault.frozenDays).toEqual(['2026-09-30']);
    });

    it('holds rather than shifts when the window reaches real time since the set', () => {
        // Behind by 20 minutes, two hours after the set: band time since the set overlaps
        // real time a genuine reading could have been taken in.
        const fault = detectFault(clock(
            '2026-10-01T11:40:00.000Z', '2026-10-01T12:00:00.000Z', '2026-10-01T10:00:00.000Z',
        ));
        expect(fault.skewSec).toBe(1200);
        expect(fault.mode).toBe('hold');
    });

    it('holds when it is not known when the clock was last set', () => {
        const fault = detectFault(clock('2026-09-30T18:10:00Z', '2026-10-01T04:44:40Z', null));
        expect(fault.mode).toBe('hold');
    });

    it('carries the previous sync’s end-of-sync readings for finding the trigger', () => {
        const fault = detectFault({
            ...clock('2026-09-30T18:10:00Z', '2026-10-01T04:44:40Z', '2026-10-01T03:07:00Z'),
            previous: {
                at: '2026-10-01T03:07:40Z',
                afterRead: { bandAt: '2026-10-01T03:07:30Z', phoneAt: '2026-10-01T03:07:30Z' },
                afterAck: { bandAt: '2026-09-30T16:33:05Z', phoneAt: '2026-10-01T03:07:45Z' },
            },
        });
        expect(fault.diagnostics.previous).toEqual({
            at: '2026-10-01T03:07:40Z', afterReadSkewSec: 0, afterAckSkewSec: SKEW,
        });
    });
});

describe('applyFaults', () => {
    const fault = {
        idPrefix: `jstyle:${DEVICE}:`,
        skewSec: SKEW,
        window: { from: new Date('2026-09-30T16:30:00Z'), to: new Date('2026-09-30T18:12:00Z') },
        mode: 'shift',
        knownIds: [id('temp_wrist', '2026-09-30T16:59:59Z')],
        shiftedIds: [],
        frozenDays: ['2026-09-30'],
    };

    it('moves new rows, drops known ones, passes the rest, and freezes the day', () => {
        const nap = {
            externalId: id('sleep', '2026-09-30T16:51:59Z'),
            startedAt: '2026-09-30T16:51:59.000Z',
            endedAt: '2026-09-30T18:09:59.000Z',
            segments: [{ stage: 'light', startedAt: '2026-09-30T16:51:59.000Z', endedAt: '2026-09-30T18:09:59.000Z' }],
            asleepMin: 74,
        };
        const night = { externalId: id('sleep', '2026-09-30T20:28:04Z'), startedAt: '2026-09-30T20:28:04.000Z', endedAt: '2026-10-01T03:01:00.000Z' };
        const twin = { externalId: id('temp_wrist', '2026-09-30T16:59:59Z'), measuredAt: '2026-09-30T16:59:59.000Z', celsius: 33.4, site: 'wrist' };
        const stranger = { externalId: 'jstyle:OTHER:temp_wrist:1', measuredAt: '2026-09-30T17:00:00.000Z', celsius: 30, site: 'wrist' };

        const { body, learnt, report } = applyFaults({
            sleep: [nap, night],
            temperature: [twin, stranger],
            days: [{ day: '2026-09-30', steps: 9000 }, { day: '2026-10-01', steps: 2000 }],
        }, [fault], { phoneAt: '2026-10-01T04:44:40Z', freshIndex: 0 });

        expect(body.sleep).toHaveLength(2);
        expect(body.sleep[0]).toMatchObject({
            externalId: `${nap.externalId}~${SKEW}s`,
            startedAt: '2026-10-01T03:26:39.000Z',
            endedAt: '2026-10-01T04:44:39.000Z',
        });
        expect(body.sleep[0].segments[0].startedAt).toBe('2026-10-01T03:26:39.000Z');
        expect(body.sleep[1]).toBe(night);
        // The genuine reading is already stored; its mis-stamped twin must not overwrite it.
        expect(body.temperature).toEqual([stranger]);
        expect(body.days).toEqual([{ day: '2026-10-01', steps: 2000 }]);
        expect(learnt[0].shiftedIds).toEqual([nap.externalId]);
        expect(report).toEqual({ shifted: 1, dropped: 1, held: 0, daysDropped: 1 });
    });

    it('later, moves a re-send it moved before and holds an unknown row in the window', () => {
        const nap = { externalId: id('sleep', '2026-09-30T16:51:59Z'), startedAt: '2026-09-30T16:51:59Z', endedAt: '2026-09-30T18:09:59Z' };
        const late = { externalId: id('spo2_automatic', '2026-09-30T17:30:00Z'), measuredAt: '2026-09-30T17:30:00Z', spo2: 97 };

        const { body, learnt, report } = applyFaults(
            { sleep: [nap], spo2: [late] },
            [{ ...fault, shiftedIds: [nap.externalId] }],
            { phoneAt: '2026-10-01T06:10:00Z', freshIndex: -1 },
        );
        expect(body.sleep[0].externalId).toBe(`${nap.externalId}~${SKEW}s`);
        expect(body.spo2).toEqual([]);
        expect(learnt[0].held).toEqual([{ family: 'spo2', row: late }]);
        expect(report).toMatchObject({ shifted: 1, held: 1 });
    });

    it('for a band that ran fast, moves only stamps still in the future', () => {
        const fast = {
            ...fault,
            skewSec: -3600,
            window: { from: new Date('2026-10-01T10:00:00Z'), to: new Date('2026-10-01T13:00:00Z') },
            knownIds: [],
        };
        const future = { externalId: id('spo2_automatic', '2026-10-01T12:30:00Z'), measuredAt: '2026-10-01T12:30:00Z', spo2: 96 };
        const past = { externalId: id('spo2_automatic', '2026-10-01T10:30:00Z'), measuredAt: '2026-10-01T10:30:00Z', spo2: 97 };

        const { body } = applyFaults({ spo2: [future, past] }, [fast], { phoneAt: '2026-10-01T12:00:00Z', freshIndex: -1 });
        expect(body.spo2[0].measuredAt).toBe('2026-10-01T11:30:00.000Z');
        expect(body.spo2[1]).toBe(past);
    });

    it('shiftRow recomputes the day rather than keeping the band’s', () => {
        const row = shiftRow({ externalId: 'x', measuredAt: '2026-09-30T17:00:00Z', day: '2026-09-30' }, SKEW);
        expect(row.day).toBeUndefined();
        expect(row.externalId).toBe(`x~${SKEW}s`);
    });
});

describe('the 2026-10-01 replay, through the sync path', () => {
    let userId;

    beforeEach(async () => {
        userId = new mongoose.Types.ObjectId();
        await User.create({ _id: userId, username: `u${userId}`, email: `${userId}@example.com`, password: 'x' });
    });

    /** What `controllers/wearableController.sync` does with a body. */
    const sync = async (body) => {
        const { body: corrected, report } = await prepareBraceletBatch(userId, body);
        await ingestBatch({ userId, ...corrected });
        return report;
    };

    const napRow = () => ({
        externalId: id('sleep', '2026-09-30T16:51:59Z'),
        startedAt: '2026-09-30T16:51:59.000Z',
        endedAt: '2026-09-30T18:09:59.000Z',
        segments: [
            { stage: 'awake', startedAt: '2026-09-30T16:51:59.000Z', endedAt: '2026-09-30T16:55:59.000Z' },
            { stage: 'light', startedAt: '2026-09-30T16:55:59.000Z', endedAt: '2026-09-30T18:09:59.000Z' },
        ],
        asleepMin: 74,
        inBedMin: 78,
    });
    const temp = (iso, celsius) => ({ externalId: id('temp_wrist', iso), measuredAt: iso, celsius, site: 'wrist' });
    const base = (clock, extra) => ({
        platform: 'jstyle_bracelet', tzOffset: TZ, clock: { deviceId: DEVICE, ...clock }, ...extra,
    });

    it('files the nap in the morning it happened, keeps the evening’s real readings, and stays put on re-send', async () => {
        // 07:07 local: a normal sync. The clock is right; yesterday evening's genuine readings land.
        await sync(base(
            { bandAt: '2026-10-01T03:07:05Z', phoneAt: '2026-10-01T03:07:05Z', lastSetAt: '2026-09-30T16:32:40Z' },
            { temperature: [temp('2026-09-30T16:59:59.000Z', 30.5)], days: [{ day: '2026-09-30', steps: 8000 }] },
        ));
        expect(await ClockFault.countDocuments({ userId })).toBe(0);

        // 08:44 local: the band went back to 16:33Z at the last sync and has been recording since.
        const report = await sync(base(
            { bandAt: '2026-09-30T18:10:00Z', phoneAt: '2026-10-01T04:44:40Z', lastSetAt: '2026-10-01T03:07:00Z' },
            {
                sleep: [napRow()],
                temperature: [
                    temp('2026-09-30T16:39:59.000Z', 33.3),
                    // Same band second as a genuine reading, so the same id.
                    temp('2026-09-30T16:59:59.000Z', 33.0),
                ],
                days: [{ day: '2026-09-30', steps: 9500 }, { day: '2026-10-01', steps: 1200 }],
            },
        ));
        expect(report).toMatchObject({ shifted: 2, dropped: 1, daysDropped: 1, detected: { skewSec: SKEW, mode: 'shift' } });

        // 10:10 local: the clock is right again; the band re-sends the nap it never deletes.
        await sync(base(
            { bandAt: '2026-10-01T06:10:00Z', phoneAt: '2026-10-01T06:10:00Z', lastSetAt: '2026-10-01T04:44:20Z' },
            { sleep: [napRow()] },
        ));

        const sleeps = await SleepSession.find({ userId }).lean();
        expect(sleeps).toHaveLength(1);
        expect(sleeps[0]).toMatchObject({ day: '2026-10-01', asleepMin: 74 });
        expect(sleeps[0].startedAt.toISOString()).toBe('2026-10-01T03:26:39.000Z');

        const genuine = await MetricLog.findOne({ userId, externalId: id('temp_wrist', '2026-09-30T16:59:59.000Z') }).lean();
        expect(genuine.celsius).toBe(30.5);
        const moved = await MetricLog.findOne({ userId, externalId: `${id('temp_wrist', '2026-09-30T16:39:59.000Z')}~${SKEW}s` }).lean();
        expect(moved.measuredAt.toISOString()).toBe('2026-10-01T03:14:39.000Z');
        expect(moved.day).toBe('2026-10-01');

        // Yesterday was complete at 07:07; the stretch did not get to rewrite it.
        const yesterday = await DailyMetrics.findOne({ userId, day: '2026-09-30' }).lean();
        expect(yesterday.activity.steps).toBe(8000);

        const fault = await ClockFault.findOne({ userId }).lean();
        expect(fault.shiftedIds.sort()).toEqual([
            id('sleep', '2026-09-30T16:51:59Z'),
            id('temp_wrist', '2026-09-30T16:39:59.000Z'),
        ].sort());
    });

    it('leaves a phone-store batch exactly as it came', async () => {
        const body = { platform: 'health_connect', tzOffset: TZ, sleep: [napRow()] };
        const { body: out, report } = await prepareBraceletBatch(userId, body);
        expect(out).toBe(body);
        expect(report).toBeNull();
    });
});
