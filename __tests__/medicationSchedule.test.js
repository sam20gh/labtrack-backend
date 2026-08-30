/**
 * Schedule expansion and adherence.
 *
 * Every number the medication feature shows a person about themselves comes from this file.
 * The two things that must hold:
 *
 *   - A dose belongs to the local calendar day it falls on. Grouping by UTC files an 11pm
 *     dose in the Americas under tomorrow, on the one screen the feature is built around.
 *   - A dose that has not come due yet is neither taken nor missed. Counting it as missed
 *     shows everybody a failing adherence score every morning, and a score people know to be
 *     wrong is a score they stop reading.
 */
const s = require('../utils/medicationSchedule');

const medication = (over = {}) => ({
    _id: 'med1',
    frequency: 'daily',
    startDay: '2026-03-02',
    endDay: null,
    times: ['09:00'],
    tzOffset: 0,
    ...over,
});

const days = (list) => list.map((d) => `${d.day} ${d.time}`);

describe('day arithmetic', () => {
    it('adds days across a month boundary', () => {
        expect(s.addDays('2026-03-30', 3)).toBe('2026-04-02');
        expect(s.addDays('2026-03-02', -3)).toBe('2026-02-27');
    });

    it('handles a leap day', () => {
        expect(s.addDays('2028-02-28', 1)).toBe('2028-02-29');
        expect(s.daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    });

    it('reports Sunday as 0, matching the design\'s week strip', () => {
        expect(s.weekdayOf('2026-03-01')).toBe(0);
        expect(s.weekdayOf('2026-03-02')).toBe(1);
    });
});

describe('local days, not UTC', () => {
    it('files a late-evening dose in the Americas under the correct local day', () => {
        // 2026-03-03T02:00Z is 9pm on 2026-03-02 at UTC-5 (offset 300 minutes west)
        const instant = new Date('2026-03-03T02:00:00Z');
        expect(s.localDay(instant, 300)).toBe('2026-03-02');
        expect(s.localDay(instant, 0)).toBe('2026-03-03');
    });

    it('resolves a scheduled instant using the medication\'s own offset', () => {
        // 9pm local at UTC-5 is 02:00Z the following day
        expect(s.instantFor('2026-03-02', '21:00', 300).toISOString()).toBe('2026-03-03T02:00:00.000Z');
    });
});

describe('expand', () => {
    it('produces one dose a day for a daily medication', () => {
        const out = s.expand(medication(), '2026-03-02', '2026-03-05');
        expect(days(out)).toEqual([
            '2026-03-02 09:00', '2026-03-03 09:00', '2026-03-04 09:00', '2026-03-05 09:00',
        ]);
    });

    it('produces a dose per time for a twice-daily medication', () => {
        const out = s.expand(medication({ frequency: 'twice_daily', times: ['09:00', '21:00'] }), '2026-03-02', '2026-03-03');
        expect(days(out)).toEqual([
            '2026-03-02 09:00', '2026-03-02 21:00', '2026-03-03 09:00', '2026-03-03 21:00',
        ]);
    });

    it('never generates a dose before the medication started', () => {
        const out = s.expand(medication({ startDay: '2026-03-04' }), '2026-03-01', '2026-03-05');
        expect(days(out)).toEqual(['2026-03-04 09:00', '2026-03-05 09:00']);
    });

    it('stops at the end of the course', () => {
        const out = s.expand(medication({ endDay: '2026-03-03' }), '2026-03-02', '2026-03-10');
        expect(days(out)).toEqual(['2026-03-02 09:00', '2026-03-03 09:00']);
    });

    it('returns nothing when the window is entirely outside the course', () => {
        expect(s.expand(medication({ endDay: '2026-03-03' }), '2026-04-01', '2026-04-05')).toEqual([]);
    });

    it('treats a one-off as exactly its start day', () => {
        const out = s.expand(medication({ frequency: 'once' }), '2026-03-01', '2026-03-10');
        expect(days(out)).toEqual(['2026-03-02 09:00']);
    });

    it('fires a weekly medication every seven days from its start', () => {
        const out = s.expand(medication({ frequency: 'weekly' }), '2026-03-02', '2026-03-30');
        expect(out.map((d) => d.day)).toEqual(['2026-03-02', '2026-03-09', '2026-03-16', '2026-03-23', '2026-03-30']);
    });

    it('honours specific weekdays', () => {
        // Mondays (1) and Thursdays (4)
        const out = s.expand(medication({ frequency: 'specific_days', daysOfWeek: [1, 4] }), '2026-03-02', '2026-03-12');
        expect(out.map((d) => d.day)).toEqual(['2026-03-02', '2026-03-05', '2026-03-09', '2026-03-12']);
    });

    it('generates nothing for specific_days with no days chosen, rather than every day', () => {
        // Someone who started choosing and did not finish must not get a daily alarm
        const out = s.expand(medication({ frequency: 'specific_days', daysOfWeek: [] }), '2026-03-02', '2026-03-10');
        expect(out).toEqual([]);
    });

    it('honours an every-other-day interval', () => {
        const out = s.expand(medication({ intervalDays: 2 }), '2026-03-02', '2026-03-08');
        expect(out.map((d) => d.day)).toEqual(['2026-03-02', '2026-03-04', '2026-03-06', '2026-03-08']);
    });

    it('never generates a dose for an as-needed medication', () => {
        expect(s.expand(medication({ frequency: 'as_needed' }), '2026-03-02', '2026-03-30')).toEqual([]);
    });

    it('falls back to sensible waking-hour times when none were chosen', () => {
        const out = s.expand(medication({ frequency: 'three_times_daily', times: [] }), '2026-03-02', '2026-03-02');
        expect(out.map((d) => d.time)).toEqual(['08:00', '14:00', '20:00']);
        // Nothing between midnight and 6am — a 2am alarm is how people stop taking a course
        for (const d of out) expect(Number(d.time.slice(0, 2))).toBeGreaterThanOrEqual(6);
    });

    it('discards a malformed time rather than scheduling at an invalid hour', () => {
        const out = s.expand(medication({ times: ['09:00', '25:99', 'morning'] }), '2026-03-02', '2026-03-02');
        expect(out.map((d) => d.time)).toEqual(['09:00']);
    });

    it('rejects bounds that are not calendar days', () => {
        expect(() => s.expand(medication(), 'March 2nd', '2026-03-05')).toThrow(/YYYY-MM-DD/);
    });

    it('returns nothing when the range runs backwards', () => {
        expect(s.expand(medication(), '2026-03-10', '2026-03-02')).toEqual([]);
    });
});

describe('punctuality', () => {
    const dose = (over) => ({
        status: 'taken',
        scheduledFor: new Date('2026-03-02T09:00:00Z'),
        ...over,
    });

    it('counts a dose within the grace window as on time', () => {
        expect(s.punctuality(dose({ takenAt: new Date('2026-03-02T09:20:00Z') }))).toBe('on_time');
    });

    it('gives the same grace to a dose taken early', () => {
        expect(s.punctuality(dose({ takenAt: new Date('2026-03-02T08:40:00Z') }))).toBe('on_time');
    });

    it('counts a dose outside the window as late', () => {
        expect(s.punctuality(dose({ takenAt: new Date('2026-03-02T11:00:00Z') }))).toBe('late');
    });

    it('says nothing about a dose that was not taken', () => {
        expect(s.punctuality(dose({ status: 'skipped', takenAt: null }))).toBeNull();
        expect(s.punctuality(dose({ status: 'scheduled', takenAt: null }))).toBeNull();
    });
});

describe('adherence', () => {
    const now = new Date('2026-03-03T12:00:00Z');

    const taken = (at, scheduled) => ({
        day: scheduled.slice(0, 10),
        status: 'taken',
        scheduledFor: new Date(scheduled),
        takenAt: new Date(at),
    });
    const pending = (scheduled) => ({
        day: scheduled.slice(0, 10),
        status: 'scheduled',
        scheduledFor: new Date(scheduled),
    });

    it('ignores a dose that has not come due yet', () => {
        const result = s.adherence([
            taken('2026-03-03T09:05:00Z', '2026-03-03T09:00:00Z'),
            pending('2026-03-03T21:00:00Z'),
        ], now);
        expect(result.assessed).toBe(1);
        expect(result.score).toBe(100);
        expect(result.missed).toBe(0);
    });

    it('counts a dose that came due with nothing recorded as missed', () => {
        const result = s.adherence([
            taken('2026-03-02T09:05:00Z', '2026-03-02T09:00:00Z'),
            pending('2026-03-02T21:00:00Z'),
        ], now);
        expect(result.missed).toBe(1);
        expect(result.score).toBe(50);
    });

    it('splits taken doses into on time and late', () => {
        const result = s.adherence([
            taken('2026-03-02T09:05:00Z', '2026-03-02T09:00:00Z'),
            taken('2026-03-02T23:30:00Z', '2026-03-02T21:00:00Z'),
        ], now);
        expect(result.onTime).toBe(1);
        expect(result.late).toBe(1);
        expect(result.score).toBe(100);
    });

    it('counts a deliberate skip separately from a miss', () => {
        const result = s.adherence([
            { day: '2026-03-02', status: 'skipped', scheduledFor: new Date('2026-03-02T09:00:00Z') },
        ], now);
        expect(result.skipped).toBe(1);
        expect(result.missed).toBe(0);
        expect(result.score).toBe(0);
    });

    it('returns null, never zero, when nothing has come due', () => {
        const result = s.adherence([pending('2026-03-05T09:00:00Z')], now);
        expect(result.assessed).toBe(0);
        expect(result.score).toBeNull();
        expect(result.onTimeRate).toBeNull();
    });

    it('returns null for an empty list rather than a failing score', () => {
        expect(s.adherence([], now).score).toBeNull();
    });
});

describe('byDay', () => {
    const now = new Date('2026-03-03T12:00:00Z');
    const at = (day, time, status, takenAt) => ({
        day, status,
        scheduledFor: new Date(`${day}T${time}:00Z`),
        takenAt: takenAt ? new Date(takenAt) : null,
    });

    it('marks a day taken only when every dose on it was taken', () => {
        const out = s.byDay([
            at('2026-03-01', '09:00', 'taken', '2026-03-01T09:00:00Z'),
            at('2026-03-01', '21:00', 'taken', '2026-03-01T21:00:00Z'),
        ], now);
        expect(out[0].status).toBe('taken');
    });

    it('marks a day with one taken and one missed as missed, not as a tick', () => {
        const out = s.byDay([
            at('2026-03-02', '09:00', 'taken', '2026-03-02T09:00:00Z'),
            at('2026-03-02', '21:00', 'scheduled'),
        ], now);
        expect(out[0].status).toBe('missed');
        expect(out[0].taken).toBe(1);
    });

    it('marks a wholly future day as upcoming, not as missed', () => {
        const out = s.byDay([at('2026-03-05', '09:00', 'scheduled')], now);
        expect(out[0].status).toBe('upcoming');
    });

    it('returns days in calendar order', () => {
        const out = s.byDay([
            at('2026-03-03', '09:00', 'scheduled'),
            at('2026-03-01', '09:00', 'taken', '2026-03-01T09:00:00Z'),
        ], now);
        expect(out.map((d) => d.day)).toEqual(['2026-03-01', '2026-03-03']);
    });
});

describe('needsRefill', () => {
    it('prompts when the packet is at or below the threshold', () => {
        expect(s.needsRefill({ refillReminder: true, remainingDoses: 12, refillThreshold: 12 })).toBe(true);
        expect(s.needsRefill({ refillReminder: true, remainingDoses: 5, refillThreshold: 12 })).toBe(true);
    });

    it('stays quiet above the threshold', () => {
        expect(s.needsRefill({ refillReminder: true, remainingDoses: 30, refillThreshold: 12 })).toBe(false);
    });

    it('stays quiet when the person is not tracking supply at all', () => {
        expect(s.needsRefill({ refillReminder: true, remainingDoses: null, refillThreshold: 12 })).toBe(false);
        expect(s.needsRefill({ refillReminder: false, remainingDoses: 1, refillThreshold: 12 })).toBe(false);
    });
});
