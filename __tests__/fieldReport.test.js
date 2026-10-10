/**
 * A technician's own report: the arithmetic, with no database.
 *
 * The failures each test prevents:
 *   - a visit at 00:30 Dubai filed under the previous day because UTC says so;
 *   - estimated mileage presented as if it were measured, or an unknown leg counted as 0 km;
 *   - a GPS jump across town counted as distance driven;
 *   - a week with no visits reported as "0% on time";
 *   - a comparison against a period nobody worked.
 */
const R = require('../utils/fieldReport');
const routing = require('../utils/routing');
const M = require('../utils/markets');

const TZ = 'Asia/Dubai';
const MARINA = { lat: 25.0805, lng: 55.1403, area: 'Dubai Marina' };
const JLT = { lat: 25.0693, lng: 55.1418, area: 'JLT' };
const BARSHA = { lat: 25.1124, lng: 55.1990, area: 'Al Barsha' };

/** A visit at a local Dubai time, worked as `status`. */
const visit = (localStart, address, { status = 'completed', arriveAfter = 5, doorMinutes = 15, driven, tasks, identity = 'pass' } = {}) => {
    const start = new Date(`${localStart}:00+04:00`);
    const end = new Date(start.getTime() + 30 * 60000);
    const arrived = new Date(start.getTime() + arriveAfter * 60000);
    const history = [{ status: 'assigned', at: start }, { status: 'en_route', at: start }];
    if (['arrived', 'completed', 'missed'].includes(status)) history.push({ status: 'arrived', at: arrived });
    if (status === 'completed') history.push({ status: 'completed', at: new Date(arrived.getTime() + doorMinutes * 60000) });
    if (status === 'missed') history.push({ status: 'missed', at: arrived });
    return {
        slot: { start, end }, status, address,
        driven: driven ? { km: driven } : undefined,
        identity: status === 'completed' ? { method: identity } : undefined,
        tasks: tasks || [
            { kind: 'collect_blood', status: 'done' },
            { kind: 'collect_dna', status: 'done' },
            { kind: 'handover_bracelet', status: 'done' },
        ],
        statusHistory: history,
    };
};

const build = (visits, over = {}) => R.buildReport({
    kind: 'week', date: '2026-10-07', today: '2026-10-09', timezone: TZ, market: 'AE',
    visits, manifests: [], base: null, localDay: M.localDay, ...over,
});

describe('periods', () => {
    it('runs a week Monday to Sunday and a month first to last', () => {
        expect(R.periodFor('week', '2026-10-07')).toMatchObject({ from: '2026-10-05', to: '2026-10-11', label: '5–11 Oct 2026' });
        expect(R.periodFor('week', '2026-10-05').from).toBe('2026-10-05');
        expect(R.periodFor('week', '2026-10-11').from).toBe('2026-10-05');
        expect(R.periodFor('week', '2026-09-30')).toMatchObject({ from: '2026-09-28', to: '2026-10-04', label: '28 Sept–4 Oct 2026' });
        expect(R.periodFor('month', '2026-02-14')).toMatchObject({ from: '2026-02-01', to: '2026-02-28', label: 'February 2026' });
        expect(R.previousOf(R.periodFor('month', '2026-01-10'))).toMatchObject({ from: '2025-12-01', to: '2025-12-31' });
    });

    it('files a visit by the market’s day, not UTC’s', () => {
        // 00:30 Tuesday in Dubai is 20:30 Monday UTC.
        const r = build([visit('2026-10-06T00:30', MARINA)]);
        expect(r.days.find((d) => d.date === '2026-10-06').done).toBe(1);
        expect(r.days.find((d) => d.date === '2026-10-05').done).toBe(0);
    });
});

describe('the numbers', () => {
    it('counts visits, samples, bracelets, identity and time at the door', () => {
        const r = build([
            visit('2026-10-06T09:00', MARINA, { doorMinutes: 12 }),
            visit('2026-10-06T10:00', JLT, { doorMinutes: 18, identity: 'manual', tasks: [{ kind: 'collect_blood', status: 'done' }, { kind: 'collect_dna', status: 'not_done' }] }),
            visit('2026-10-07T09:00', BARSHA, { status: 'missed' }),
            visit('2026-10-10T09:00', BARSHA, { status: 'assigned' }),
        ]);
        expect(r.visits).toMatchObject({ done: 2, missed: 1, toDo: 1 });
        expect(r.visits.completionRate).toBeCloseTo(2 / 3);
        expect(r.samples).toEqual({ blood: 2, dna: 1, total: 3, notDone: 1 });
        expect(r.bracelets).toBe(1);
        expect(r.identity).toEqual({ pass: 1, manual: 1 });
        expect(r.doorMinutes).toBe(15);
        expect(r.days.find((d) => d.date === '2026-10-10').future).toBe(true);
    });

    it('is on time when at the door before the window closed', () => {
        const r = build([
            visit('2026-10-06T09:00', MARINA, { arriveAfter: 29 }),
            visit('2026-10-06T10:00', JLT, { arriveAfter: 31 }),
        ]);
        expect(r.onTime).toMatchObject({ onTime: 1, late: 1, rate: 0.5 });
    });

    it('says nothing rather than zero for a week nobody worked', () => {
        const r = build([]);
        expect(r.visits.completionRate).toBeNull();
        expect(r.onTime.rate).toBeNull();
        expect(r.doorMinutes).toBeNull();
        expect(r.previous).toBeNull();
        expect(r.highlights).toEqual([]);
    });
});

describe('distance', () => {
    it('keeps measured and estimated apart, and counts an unknown leg rather than zero', () => {
        const r = build([
            visit('2026-10-06T09:00', MARINA, { driven: 9.4 }),            // measured
            visit('2026-10-06T10:00', BARSHA),                             // estimated from Marina
            visit('2026-10-06T11:00', { area: 'Somewhere' }),             // no pin
            visit('2026-10-06T12:00', JLT, { status: 'assigned' }),       // not driven yet
        ]);
        const est = routing.haversineKm(MARINA, BARSHA) * routing.ROAD_FACTOR;
        expect(r.distance.measured).toBe(9.4);
        expect(r.distance.estimated).toBeCloseTo(est, 1);
        expect(r.distance.unknownLegs).toBe(1);
        expect(r.distance.total).toBeCloseTo(9.4 + est, 1);
    });

    it('estimates the first leg of a day from the technician’s base, and starts each day afresh', () => {
        const r = build([visit('2026-10-06T09:00', MARINA), visit('2026-10-07T09:00', JLT)], { base: BARSHA });
        const first = routing.haversineKm(BARSHA, MARINA) * routing.ROAD_FACTOR;
        const second = routing.haversineKm(BARSHA, JLT) * routing.ROAD_FACTOR;
        expect(r.distance.estimated).toBeCloseTo(first + second, 1);
    });

    it('reports in miles where the market drives in miles', () => {
        const r = build([visit('2026-10-06T09:00', MARINA, { driven: 16.09344 })], { market: 'GB' });
        expect(r.unit).toBe('mi');
        expect(r.distance.measured).toBe(10);
    });

    it('counts a trusted stretch between fixes, and drops a vague fix or a jump', () => {
        const at = (s) => new Date(Date.UTC(2026, 9, 6, 5, 0, s));
        const a = { ...MARINA, accuracy: 10, at: at(0) };
        expect(routing.segmentKm(a, { ...JLT, accuracy: 10, at: at(120) })).toBeCloseTo(routing.haversineKm(MARINA, JLT), 3);
        expect(routing.segmentKm(a, { ...JLT, accuracy: 400, at: at(120) })).toBe(0);
        expect(routing.segmentKm(a, { ...BARSHA, accuracy: 10, at: at(10) })).toBe(0); // ~800 km/h
        expect(routing.segmentKm(a, { ...JLT, accuracy: 10, at: at(0) })).toBe(0);
    });
});

describe('comparison and highlights', () => {
    it('compares with last week only when last week was worked', () => {
        const r = build([
            visit('2026-09-30T09:00', MARINA),
            visit('2026-10-06T09:00', MARINA), visit('2026-10-06T10:00', JLT),
        ]);
        expect(r.previous).toMatchObject({ label: '28 Sept–4 Oct 2026', done: 1, samples: 2 });
    });

    it('names the busiest day, the longest drive, and a bag that arrived complete', () => {
        const r = build([
            visit('2026-10-06T09:00', MARINA, { driven: 3 }), visit('2026-10-06T10:00', JLT, { driven: 21 }),
            visit('2026-10-07T09:00', BARSHA, { driven: 2 }),
        ], {
            manifests: [{ handedOverAt: new Date('2026-10-06T14:00:00+04:00'), receivedAt: new Date('2026-10-06T16:00:00+04:00'), barcodes: ['A', 'B', 'C'], missing: [] }],
        });
        const text = r.highlights.map((h) => h.text).join(' | ');
        expect(text).toMatch(/Busiest day: Tuesday 6 Oct, 2 visits/);
        expect(text).toMatch(/Longest drive: 21 km to JLT\./);
        expect(text).toMatch(/Every bag reached the lab complete — 1 bag, 3 tubes/);
        expect(text).toMatch(/On time at every door — 3 of 3/);
        expect(r.bags).toEqual({ count: 1, tubes: 3, received: 1, awaiting: 0, missingTubes: 0 });
    });

    it('says when tubes went missing instead of celebrating the bag', () => {
        const r = build([], {
            manifests: [{ handedOverAt: new Date('2026-10-06T14:00:00+04:00'), receivedAt: new Date('2026-10-06T16:00:00+04:00'), barcodes: ['A', 'B'], missing: ['B'] }],
        });
        expect(r.highlights.map((h) => h.kind)).toEqual(['missing']);
    });
});
