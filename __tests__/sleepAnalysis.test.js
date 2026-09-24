/**
 * Sleep analysis — the per-record "how it went / how to improve".
 *
 * What must not regress: a nap that made up a short night changes the headline; a number the
 * source never reported produces no finding; nothing names a condition.
 */
const { analyse, clockDiff } = require('../utils/sleepAnalysis');

const night = (over = {}) => ({
    startedAt: '2026-09-24T01:05:00.000Z',
    endedAt: '2026-09-24T06:58:00.000Z',
    asleepMin: 353,
    inBedMin: 353,
    efficiency: null,
    stages: {},
    segments: [],
    ...over,
});

const napSession = (over = {}) => ({
    startedAt: '2026-09-24T08:42:00.000Z',
    endedAt: '2026-09-24T10:39:00.000Z',
    asleepMin: 117,
    ...over,
});

const everything = (a) => JSON.stringify(a);

describe('a night', () => {
    it('a short night made up by a nap says so', () => {
        const a = analyse({
            session: night(), kind: 'night', goalMinutes: 470,
            day: { nightMin: 353, napMin: 117, totalMin: 470 },
        });
        expect(a.headline).toMatch(/made up by a nap/);
        expect(a.recommendations.some((r) => r.key === 'earlier_bedtime')).toBe(true);
        expect(a.recommendations.some((r) => r.key === 'nap_length')).toBe(true);
    });

    it('a short night alone is short, and names a bedtime that fits the goal', () => {
        const a = analyse({ session: night(), kind: 'night', goalMinutes: 480, day: { nightMin: 353, napMin: 0, totalMin: 353 } });
        expect(a.tone).toBe('attention');
        const bed = a.recommendations.find((r) => r.key === 'earlier_bedtime');
        // Wake 06:58, minus 8h, minus 15 minutes to fall asleep.
        expect(bed.title).toMatch(/10:43 PM/);
    });

    it('a full night is positive and asks for no earlier bedtime', () => {
        const a = analyse({
            session: night({ startedAt: '2026-09-23T22:30:00.000Z', asleepMin: 480 }),
            kind: 'night', goalMinutes: 480,
        });
        expect(a.tone).toBe('positive');
        expect(a.recommendations.some((r) => r.key === 'earlier_bedtime')).toBe(false);
    });

    it('unreported efficiency and stages produce no finding about them', () => {
        const a = analyse({ session: night(), kind: 'night', goalMinutes: 480 });
        const keys = a.findings.map((f) => f.key);
        expect(keys).not.toContain('efficiency');
        expect(keys).not.toContain('deep');
        expect(keys).not.toContain('rem');
    });

    it('flags broken sleep from efficiency and wakings', () => {
        const a = analyse({
            session: night({ efficiency: 78, stages: { awakeMin: 70 } }), kind: 'night', goalMinutes: 480,
        });
        expect(a.findings.find((f) => f.key === 'efficiency').tone).toBe('attention');
        expect(a.recommendations.some((r) => r.key === 'awake_in_bed')).toBe(true);
    });

    it('hedges low stage shares rather than calling them a deficit', () => {
        const a = analyse({
            session: night({ asleepMin: 450, stages: { deepMin: 30, remMin: 60, lightMin: 360 } }),
            kind: 'night', goalMinutes: 480,
        });
        const deep = a.findings.find((f) => f.key === 'deep');
        expect(deep.title).toMatch(/than typical/);
        expect(deep.detail).toMatch(/approximate/);
    });

    it('measures drift against the usual bedtime circularly', () => {
        const recentNights = ['2026-09-20', '2026-09-21', '2026-09-22'].map((d) => ({
            startedAt: `${d}T23:30:00.000Z`, asleepMin: 450,
        }));
        const a = analyse({ session: night(), kind: 'night', goalMinutes: 480, recentNights });
        const f = a.findings.find((x) => x.key === 'consistency');
        expect(f.title).toBe('Later than usual');
        expect(f.detail).toMatch(/1h 35m later/);
        expect(clockDiff(20, 1420)).toBe(40);
    });

    it('carries the plan\'s own wording', () => {
        const a = analyse({
            session: night({ asleepMin: 480 }), kind: 'night', goalMinutes: 480,
            guidance: [{ key: 'schedule', directive: 'Keep a fixed wake time of 7am.' }],
        });
        expect(a.recommendations.find((r) => r.key === 'plan').detail).toBe('Keep a fixed wake time of 7am.');
    });

    it('never names a condition', () => {
        const a = analyse({
            session: night({ asleepMin: 200, efficiency: 60, stages: { deepMin: 5, remMin: 10, awakeMin: 120 } }),
            kind: 'night', goalMinutes: 480,
            recentNights: Array.from({ length: 10 }, () => ({ startedAt: '2026-09-20T02:00:00.000Z', asleepMin: 250 })),
        });
        expect(everything(a)).not.toMatch(/insomnia|insomniac|apnoea|apnea|disorder|diagnos/i);
        expect(a.recommendations.length).toBeLessThanOrEqual(4);
        expect(a.recommendations.some((r) => r.key === 'pattern')).toBe(true);
    });
});

describe('a nap', () => {
    it('a nearly two-hour nap after a short night is long, and points back at the night', () => {
        const a = analyse({
            session: napSession(), kind: 'nap', goalMinutes: 480,
            day: { nightMin: 353, napMin: 117, totalMin: 470 },
            night: night(),
        });
        expect(a.headline).toBe('A long nap');
        expect(a.findings.find((f) => f.key === 'recovery').detail).toMatch(/7h 50m/);
        expect(a.recommendations.some((r) => r.key === 'earlier_bedtime')).toBe(true);
    });

    it('a 20-minute nap is a power nap', () => {
        const a = analyse({ session: napSession({ asleepMin: 20 }), kind: 'nap', goalMinutes: 480 });
        expect(a.tone).toBe('positive');
    });

    it('a late nap is noted', () => {
        const a = analyse({
            session: napSession({ startedAt: '2026-09-24T16:30:00.000Z', asleepMin: 25 }), kind: 'nap', goalMinutes: 480,
        });
        expect(a.recommendations.some((r) => r.key === 'nap_time')).toBe(true);
    });
});
