/**
 * `utils/activityInsight.js` — the three derived cards on the activity dashboard.
 *
 * The point of these is the same point every deterministic table in this codebase makes:
 * a figure a person is shown beside their own records has to be reproducible from those
 * records. Each of the assertions below is a way the naive version is wrong.
 */
const {
    breakdownByType, activeHours, comparePeriods, MAX_BREAKDOWN_ROWS,
} = require('../utils/activityInsight');

const session = (over = {}) => ({
    type: 'jogging',
    startedAt: '2026-06-25T09:30:00.000Z',
    durationSec: 1800,
    activeKcal: 120,
    distanceM: 4000,
    ...over,
});

describe('breakdownByType', () => {
    it('counts sessions, not minutes', () => {
        const rows = breakdownByType([
            session({ type: 'yoga', durationSec: 1800 }),
            session({ type: 'yoga', durationSec: 1800 }),
            session({ type: 'biking', durationSec: 7200 }),
        ]);
        // Two hours of cycling does not outrank two yoga classes: the card says "2x".
        expect(rows[0]).toMatchObject({ type: 'yoga', count: 2 });
    });

    it('leaves calories null rather than summing a missing estimate as zero', () => {
        const rows = breakdownByType([
            session({ type: 'walking', activeKcal: undefined }),
            session({ type: 'walking', activeKcal: undefined }),
        ]);
        expect(rows[0].kcal).toBeNull();
        expect(rows[0].minutes).toBe(60);
    });

    it('folds the tail into one Other row rather than dropping it', () => {
        const types = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
        const rows = breakdownByType(types.map((type) => session({ type })));

        expect(rows).toHaveLength(MAX_BREAKDOWN_ROWS);
        const other = rows[rows.length - 1];
        expect(other.type).toBe('other');
        // Every session is still accounted for.
        expect(rows.reduce((s, r) => s + r.count, 0)).toBe(types.length);
    });

    it('is stable between two reads of the same data', () => {
        const rows = [
            session({ type: 'yoga' }), session({ type: 'walking' }),
        ];
        expect(breakdownByType(rows)).toEqual(breakdownByType([...rows].reverse()));
    });
});

describe('activeHours', () => {
    it('buckets by the local hour, not the instant', () => {
        // 01:30 UTC is 21:30 the previous evening in New York (tzOffset 240).
        const { hours } = activeHours(
            [session({ startedAt: '2026-06-26T01:30:00.000Z' })],
            240,
            { minSessions: 1 },
        );
        expect(hours[21]).toBe(30);
        expect(hours[1]).toBe(0);
    });

    it('refuses to name a peak from one session', () => {
        expect(activeHours([session()], 0).peak).toBeNull();
    });

    it('finds the two-hour window holding the most training', () => {
        const at = (h) => session({ startedAt: `2026-06-25T0${h}:00:00.000Z` });
        const { peak } = activeHours([at(8), at(9), at(9), at(5)], 0);
        expect(peak.from).toBe(8);
        expect(peak.to).toBe(10);
        expect(peak.minutes).toBe(90);
    });
});

describe('comparePeriods', () => {
    const day = (activeKcal) => ({ activeKcal });

    it('averages over the days that reported, on both sides', () => {
        const result = comparePeriods(
            [day(200), day(null), day(300)],
            [day(100), day(null), day(null)],
            'activeKcal',
        );
        expect(result.current).toEqual({ value: 250, days: 2 });
        expect(result.previous).toEqual({ value: 100, days: 1 });
        expect(result.deltaPct).toBe(150);
    });

    it('reports an unknown change rather than a huge one when nothing came before', () => {
        const result = comparePeriods([day(200)], [day(null)], 'activeKcal');
        expect(result.current).toEqual({ value: 200, days: 1 });
        expect(result.deltaPct).toBeNull();
    });

    it('is null on both sides when neither window reported', () => {
        const result = comparePeriods([day(null)], [day(null)], 'activeKcal');
        expect(result.current).toBeNull();
        expect(result.deltaPct).toBeNull();
    });
});
