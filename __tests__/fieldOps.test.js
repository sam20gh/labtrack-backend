/**
 * Phase 4 on the server: routes, live arrival times, the bag to the lab, and the labs' own API.
 *
 * The failures each block prevents:
 *
 *   - a technician given back-to-back visits on opposite sides of a city;
 *   - "unknown distance" planned as "no distance";
 *   - a customer shown where a technician is, rather than how long;
 *   - a door pinned from a fix 300 m wide;
 *   - an offline phone's queued "record visit" applied twice when it reconnects;
 *   - a blood tube in the DNA bag, or a tube that left in a bag and never arrived, unnoticed;
 *   - anybody with the URL posting a result into somebody's record;
 *   - a lab learning that a barcode belongs to another lab's patient;
 *   - a lab's retry writing a second copy of a result.
 */
jest.mock('../utils/pushSender', () => {
    const actual = jest.requireActual('../utils/pushSender');
    return { ...actual, send: jest.fn(async (m) => ({ sent: m.length, failed: 0, pruned: 0 })) };
});
jest.mock('../config/stripe', () => ({
    getStripe: () => ({}),
    isConfigured: () => false,
    isTestMode: () => true,
    toMinorUnits: (a) => Math.round(Number(a) * 100),
    stripeCurrency: (c) => String(c).toLowerCase(),
    WEBHOOK_SECRETS: [],
}));
const mockRequestGeneration = jest.fn(async () => ({ status: 201, body: {} }));
jest.mock('../controllers/interpretationController', () => ({
    requestGeneration: (...args) => mockRequestGeneration(...args),
}));

const mongoose = require('mongoose');
const User = require('../models/userModel');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Market = require('../models/Market');
const Technician = require('../models/Technician');
const CollectionVisit = require('../models/CollectionVisit');
const Specimen = require('../models/Specimen');
const SampleManifest = require('../models/SampleManifest');
const TestResult = require('../models/testResultModel');
const Biomarker = require('../models/Biomarker');
const DnaReport = require('../models/DnaReport');
const Notification = require('../models/Notification');

const M = require('../utils/markets');
const R = require('../utils/roster');
const routing = require('../utils/routing');
const labs = require('../utils/labs');
const centre = require('../utils/collectionCentre');
const orders = require('../controllers/orderController');
const visits = require('../controllers/collectionController');
const tech = require('../controllers/technicianController');
const lab = require('../controllers/labController');

const call = async (handler, req) => {
    let body = null;
    let code = 200;
    const res = {
        status(c) { code = c; return this; },
        json(p) { body = p; return this; },
        set() { return this; },
    };
    const headers = Object.fromEntries(Object.entries(req.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    await handler({ params: {}, query: {}, body: {}, ...req, headers, get: (h) => headers[h.toLowerCase()] }, res);
    return { code, body };
};

const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, startMinute: 0, endMinute: 1440 }));
const makeUser = (over = {}) => User.create({
    username: `u${new mongoose.Types.ObjectId()}`,
    email: `${new mongoose.Types.ObjectId()}@example.com`,
    supabaseId: String(new mongoose.Types.ObjectId()),
    ...over,
});
const authFor = (u, role = 'user') => ({ userId: String(u._id), email: u.email, emailVerified: true, role });
const ADMIN = { userId: String(new mongoose.Types.ObjectId()), role: 'admin' };
const MARINA = { lat: 25.0805, lng: 55.1403 };
const JLT = { lat: 25.0693, lng: 55.1418 };
const AIRPORT = { lat: 25.2532, lng: 55.3657 };

const makeTech = async (over = {}) => {
    const user = await makeUser();
    const t = await Technician.create({ name: `Tech ${String(user._id).slice(-4)}`, email: user.email, market: 'AE', userId: user._id, shifts: ALL_WEEK, ...over });
    return { t, auth: authFor(user, 'technician') };
};

const slotAfter = async (hours = 30) => {
    const market = await Market.resolve('AE');
    const after = Date.now() + hours * 3600000;
    return M.slotsFor(market, { now: new Date() }).flatMap((d) => d.slots).find((s) => new Date(s.start).getTime() >= after).start;
};

const bookedVisit = async ({ includes = ['blood', 'dna', 'bracelet'], at, start } = {}) => {
    const user = await makeUser({ firstName: 'Layla', dob: '1990-01-01', gender: 'Female' });
    const p = await Product.create({ name: 'Plus', sku: `P-${new mongoose.Types.ObjectId()}`, price: 1, includes, type: 'package' });
    const { body } = await call(orders.createOrder, {
        auth: authFor(user),
        body: {
            items: [{ productId: String(p._id) }], currency: 'AED',
            fulfilment: {
                method: 'home_collection', slotStart: start || await slotAfter(),
                address: { building: 'Tower 1', area: 'Dubai Marina', city: 'Dubai', ...(at || {}) }, phone: '+971 50 000 0000',
            },
        },
    });
    return { user, order: body.order, visit: await CollectionVisit.findById(body.order.fulfilment.visitId) };
};

/** A visit worked to completion, its tubes labelled. Returns the barcodes. */
const collectedTubes = async () => {
    const { user, order, visit } = await bookedVisit();
    const { t, auth } = await makeTech();
    await call(visits.adminAssign, { auth: ADMIN, params: { id: String(visit._id) }, body: { technicianId: String(t._id) } });
    const tag = String(visit._id).slice(-6).toUpperCase();
    const barcodes = { blood: `PQB-${tag}`, dna: `PQD-${tag}` };
    await centre.completeVisit({
        visit: await CollectionVisit.findById(visit._id),
        identityConfirmed: true,
        by: 'test',
        results: visit.tasks.map((task) => ({
            taskId: String(task._id), status: 'done',
            barcode: task.kind === 'collect_blood' ? barcodes.blood : task.kind === 'collect_dna' ? barcodes.dna : `SN-${tag}`,
        })),
    });
    return { user, order, visit, t, auth, barcodes };
};

const titlesFor = async (userId, expected, timeoutMs = 2000) => {
    const until = Date.now() + timeoutMs;
    let titles = [];
    while (Date.now() < until) {
        titles = (await Notification.find({ userId }).lean()).map((c) => c.title);
        if (expected.every((x) => titles.includes(x))) return titles;
        await new Promise((r) => setTimeout(r, 25));
    }
    return titles;
};

beforeEach(() => { mockRequestGeneration.mockClear(); });

// ─────────────────────────────────────────────────────────────────────────────
describe('routing', () => {
    it('estimates city minutes, and says unknown rather than zero', () => {
        expect(routing.travelMinutes(MARINA, JLT)).toBeGreaterThan(5);
        expect(routing.travelMinutes(MARINA, AIRPORT)).toBeGreaterThan(60);
        expect(routing.travelMinutes(MARINA, {})).toBeNull();
        expect(routing.etaMinutes(MARINA, MARINA)).toBe(1);
    });

    it('flags a leg the gap between slots cannot cover', () => {
        const v = (id, start, where) => ({ _id: id, slot: { start: new Date(start), end: new Date(new Date(start).getTime() + 30 * 60000) }, address: where });
        const legs = routing.legsFor([v('b', '2026-10-11T04:30:00Z', AIRPORT), v('a', '2026-10-11T04:00:00Z', MARINA)], MARINA);
        expect(legs.map((l) => [l.visitId, l.tight])).toEqual([['a', false], ['b', true]]);
        expect(legs[0].fromBase).toBe(true);
    });

    it('treats a slot as an arrival window, so back-to-back visits nearby are fine', () => {
        const v = (id, start, where) => ({ _id: id, slot: { start: new Date(start), end: new Date(new Date(start).getTime() + 30 * 60000) }, address: where });
        const sameBuilding = [v('a', '2026-10-11T04:00:00Z', MARINA), v('b', '2026-10-11T04:30:00Z', MARINA)];
        expect(routing.reachable(...sameBuilding)).toBe(true);
        expect(routing.reachable(v('a', '2026-10-11T04:00:00Z', MARINA), v('b', '2026-10-11T04:30:00Z', JLT))).toBe(true);
        expect(routing.legsFor(sameBuilding, null).map((l) => l.tight)).toEqual([false, false]);
    });

    it('auto-assigns the nearest technician, and never one who cannot make it in time', () => {
        const ae = M.completeMarket('AE', null);
        const near = { _id: 'near', name: 'Zed', active: true, market: 'AE', shifts: ALL_WEEK, base: JLT };
        const far = { _id: 'far', name: 'Amal', active: true, market: 'AE', shifts: ALL_WEEK, base: AIRPORT };
        const v = (id, start, where, extra = {}) => ({ _id: id, status: 'booked', slot: { start: new Date(start), end: new Date(new Date(start).getTime() + 30 * 60000) }, address: { city: 'Dubai', ...where }, ...extra });

        const first = R.autoAssign(ae, [v('v1', '2026-10-11T04:00:00Z', MARINA)], [far, near]);
        expect(first.assignments[0]).toMatchObject({ technicianId: 'near' });
        expect(first.assignments[0].travelMinutes).toBeLessThan(20);

        // Zed is at the airport at 08:00; a Marina visit at 08:30 is out of reach for him.
        const busy = [v('done', '2026-10-11T04:00:00Z', AIRPORT, { status: 'assigned', technicianId: 'near' })];
        const next = R.autoAssign(ae, [...busy, v('v2', '2026-10-11T04:30:00Z', MARINA)], [near]);
        expect(next.unassigned[0].reason).toMatch(/get there in time/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('on the way', () => {
    const enRoute = async (door = MARINA) => {
        const { user, visit } = await bookedVisit({ at: door });
        const { t, auth } = await makeTech();
        await call(visits.adminAssign, { auth: ADMIN, params: { id: String(visit._id) }, body: { technicianId: String(t._id) } });
        await call(tech.start, { auth, params: { id: String(visit._id) } });
        return { user, visit, auth };
    };

    it('turns positions into minutes for the customer, tells them once when near, and never shows where', async () => {
        const { user, visit, auth } = await enRoute();
        const far = await call(tech.location, { auth, params: { id: String(visit._id) }, body: { ...AIRPORT, accuracy: 20 } });
        expect(far.body.etaMinutes).toBeGreaterThan(30);

        const close = await call(tech.location, { auth, params: { id: String(visit._id) }, body: { ...JLT, accuracy: 20 } });
        expect(close.body.etaMinutes).toBeLessThanOrEqual(10);
        // Right outside, at a point that is not the door itself, so it can be looked for.
        await call(tech.location, { auth, params: { id: String(visit._id) }, body: { lat: 25.0811, lng: 55.1407, accuracy: 10 } });
        await titlesFor(user._id, ['Your technician is nearly there']);
        expect(await Notification.countDocuments({ userId: user._id, title: 'Your technician is nearly there' })).toBe(1);

        const mine = await call(visits.getMine, { auth: authFor(user), params: { id: String(visit._id) } });
        expect(mine.body.visit.eta.minutes).toBeGreaterThanOrEqual(1);
        // The customer's own door is theirs to see; the technician's position never is.
        expect(JSON.stringify(mine.body)).not.toMatch(/25\.0811|55\.1407|25\.0693|tracking/);
    });

    it('ignores a queued older fix, refuses location off the road, and forgets it at the door', async () => {
        const { visit, auth } = await enRoute();
        await call(tech.location, { auth, params: { id: String(visit._id) }, body: { ...JLT, at: new Date().toISOString() } });
        await call(tech.location, { auth, params: { id: String(visit._id) }, body: { ...AIRPORT, at: new Date(Date.now() - 60000).toISOString() } });
        expect((await CollectionVisit.findById(visit._id)).tracking.lat).toBe(JLT.lat);

        await call(tech.arrive, { auth, params: { id: String(visit._id) } });
        expect((await CollectionVisit.findById(visit._id)).tracking?.lat).toBeUndefined();
        expect((await call(tech.location, { auth, params: { id: String(visit._id) }, body: JLT })).code).toBe(409);
    });

    it('withholds a stale estimate', () => {
        const visit = { status: 'en_route', tracking: { at: new Date(Date.now() - 20 * 60000), etaMinutes: 4 } };
        expect(centre.etaOf(visit)).toBeNull();
        expect(centre.etaOf({ ...visit, tracking: { ...visit.tracking, at: new Date() } })).toMatchObject({ minutes: 4 });
    });

    it('pins an unpinned door from a precise fix at arrival, and only then', async () => {
        const a = await enRoute({});
        await call(tech.arrive, { auth: a.auth, params: { id: String(a.visit._id) }, body: { location: { ...MARINA, accuracy: 400 } } });
        expect((await CollectionVisit.findById(a.visit._id)).address.lat).toBeUndefined();

        const b = await enRoute({});
        await call(tech.arrive, { auth: b.auth, params: { id: String(b.visit._id) }, body: { location: { ...MARINA, accuracy: 15 } } });
        const pinned = await CollectionVisit.findById(b.visit._id);
        expect(pinned.address).toMatchObject({ lat: MARINA.lat, coordSource: 'technician' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the technician’s report', () => {
    it('adds up the drive from fixes, ignores a jump, and reports it as measured', async () => {
        const { visit } = await bookedVisit({ at: MARINA });
        const { t, auth } = await makeTech({ base: AIRPORT });
        await call(visits.adminAssign, { auth: ADMIN, params: { id: String(visit._id) }, body: { technicianId: String(t._id) } });
        await call(tech.start, { auth, params: { id: String(visit._id) } });
        const id = String(visit._id);
        const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
        const MID = { lat: 25.0749, lng: 55.1410 };
        await call(tech.location, { auth, params: { id }, body: { ...JLT, accuracy: 10, at: ago(360) } });
        await call(tech.location, { auth, params: { id }, body: { ...MID, accuracy: 10, at: ago(240) } });
        await call(tech.arrive, { auth, params: { id }, body: { location: { ...MARINA, accuracy: 10 } } });

        const stored = await CollectionVisit.findById(id);
        const expected = routing.haversineKm(JLT, MID) + routing.haversineKm(MID, MARINA);
        expect(stored.driven.km).toBeCloseTo(expected, 2);
        expect(stored.tracking?.lat).toBeUndefined();

        const date = M.localDay(stored.slot.start, 'Asia/Dubai');
        const r = await call(tech.myReport, { auth, query: { period: 'week', date } });
        expect(r.code).toBe(200);
        expect(r.body.unit).toBe('km');
        expect(r.body.distance.measured).toBeCloseTo(expected, 1);
        expect(r.body.distance.estimated).toBe(0);
        expect(r.body.visits.toDo).toBe(1);
        // A report reads no customer: no name, phone or street in it.
        expect(JSON.stringify(r.body)).not.toMatch(/Layla|\+971|Tower 1/);

        const admin = await call(tech.report, { auth: ADMIN, params: { id: String(t._id) }, query: { period: 'month', date } });
        expect(admin.body.technician.name).toBe(t.name);
        expect(admin.body.period.kind).toBe('month');
        expect((await call(tech.report, { auth: ADMIN, params: { id: 'nope' } })).code).toBe(404);
    });

    it('drops a fix that jumped across the city', async () => {
        const { visit } = await bookedVisit({ at: MARINA });
        const { t, auth } = await makeTech();
        await call(visits.adminAssign, { auth: ADMIN, params: { id: String(visit._id) }, body: { technicianId: String(t._id) } });
        await call(tech.start, { auth, params: { id: String(visit._id) } });
        const id = String(visit._id);
        const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
        await call(tech.location, { auth, params: { id }, body: { ...JLT, accuracy: 10, at: ago(60) } });
        await call(tech.location, { auth, params: { id }, body: { ...AIRPORT, accuracy: 10, at: ago(50) } });
        expect((await CollectionVisit.findById(id)).driven?.km).toBeUndefined();
    });
});

describe('the operations board', () => {
    /** Move a booked visit into today, so the board (which reads today) sees it. */
    const intoToday = async (visit, minutesFromNow = 60) => {
        const start = new Date(Math.floor((Date.now() + minutesFromNow * 60000) / 1800000) * 1800000);
        await CollectionVisit.updateOne({ _id: visit._id }, { $set: { 'slot.start': start, 'slot.end': new Date(start.getTime() + 1800000) } });
    };

    it('places each technician by what they are doing, and says how it knows', async () => {
        const a = await bookedVisit({ at: MARINA });
        const b = await bookedVisit({ at: JLT });
        const c = await bookedVisit({ at: AIRPORT });
        for (const x of [a, b, c]) await intoToday(x.visit);
        const moving = await makeTech({ name: 'Amal', base: AIRPORT });
        const finished = await makeTech({ name: 'Zed' });

        await call(visits.adminAssign, { auth: ADMIN, params: { id: String(a.visit._id) }, body: { technicianId: String(moving.t._id) } });
        await call(tech.start, { auth: moving.auth, params: { id: String(a.visit._id) } });
        await call(tech.location, { auth: moving.auth, params: { id: String(a.visit._id) }, body: { ...JLT, accuracy: 12 } });

        await call(visits.adminAssign, { auth: ADMIN, params: { id: String(b.visit._id) }, body: { technicianId: String(finished.t._id) } });
        await call(tech.arrive, { auth: finished.auth, params: { id: String(b.visit._id) } });
        await call(tech.complete, {
            auth: finished.auth, params: { id: String(b.visit._id) },
            body: { identityConfirmed: true, tasks: b.visit.tasks.map((t, i) => ({ taskId: String(t._id), status: 'done', barcode: `PQX-${String(b.visit._id).slice(-5)}${i}` })) },
        });

        const r = await call(tech.ops, { auth: ADMIN, query: { market: 'AE' } });
        expect(r.code).toBe(200);
        const crew = Object.fromEntries(r.body.crew.filter((x) => ['Amal', 'Zed'].includes(x.name)).map((x) => [x.name, x]));
        expect(crew.Amal).toMatchObject({ state: 'en_route', position: { lat: JLT.lat, source: 'live', stale: false } });
        expect(crew.Amal.current.eta.minutes).toBeGreaterThanOrEqual(1);
        expect(crew.Amal.route[0]).toEqual({ lat: AIRPORT.lat, lng: AIRPORT.lng });
        expect(crew.Zed).toMatchObject({ state: 'done_today', position: { source: 'last_door' }, today: { done: 1, samples: 2 } });
        expect(crew.Zed.week.done).toBe(1);

        expect(r.body.visits.find((v) => v._id === String(c.visit._id)).status).toBe('booked');
        expect(r.body.totals.unassigned).toBeGreaterThanOrEqual(1);
        expect(r.body.pipeline.booked).toBeGreaterThanOrEqual(2);
        expect(r.body.specimens.withTechnicians).toBeGreaterThanOrEqual(2);
        // A dispatcher's board, not a customer file.
        expect(JSON.stringify(r.body)).not.toMatch(/Layla|\+971 50|passCode|email/);
    });

    it('never shows a position for a technician who has not worked today', async () => {
        const idle = await makeTech({ name: 'Nadia' });
        const r = await call(tech.ops, { auth: ADMIN, query: { market: 'AE' } });
        const row = r.body.crew.find((x) => x._id === String(idle.t._id));
        expect(row.position).toBeNull();
        expect(['idle', 'off_shift']).toContain(row.state);
    });
});

describe('offline retries', () => {
    it('answers a repeated key with the first answer and does not act twice', async () => {
        const { visit } = await bookedVisit();
        const { t, auth } = await makeTech();
        await call(visits.adminAssign, { auth: ADMIN, params: { id: String(visit._id) }, body: { technicianId: String(t._id) } });
        const tasks = visit.tasks.map((task, i) => ({ taskId: String(task._id), status: 'done', barcode: `RETRY-${i}${String(visit._id).slice(-4)}` }));
        const send = () => call(tech.complete, {
            auth, params: { id: String(visit._id) }, headers: { 'Idempotency-Key': 'complete-1' },
            body: { tasks, identityConfirmed: true },
        });
        const first = await send();
        const again = await send();
        expect(first.code).toBe(200);
        expect(again).toEqual(first);
        expect(await Specimen.countDocuments({ visitId: visit._id })).toBe(2);

        // A different key is a different request, and meets the real state.
        const fresh = await call(tech.complete, { auth, params: { id: String(visit._id) }, headers: { 'Idempotency-Key': 'complete-2' }, body: { tasks, identityConfirmed: true } });
        expect(fresh.code).toBe(409);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the bag to the lab', () => {
    it('lists tubes by lab, refuses the wrong bag, and seals the right one', async () => {
        const { auth, barcodes } = await collectedTubes();
        const list = await call(tech.mySpecimens, { auth });
        expect(list.body.labs.map((l) => l.lab).sort()).toEqual(['M42', 'MICRO_HEALTH']);

        const wrong = await call(tech.handOver, { auth, body: { lab: 'M42', barcodes: [barcodes.blood] } });
        expect(wrong.body.reason).toBe('lab');

        const bag = await call(tech.handOver, { auth, body: { lab: 'MICRO_HEALTH', barcodes: [barcodes.blood] }, headers: { 'Idempotency-Key': 'bag-1' } });
        expect(bag.code).toBe(201);
        expect(bag.body.manifest.code).toMatch(/^PQM-[2-9A-Z]{6}$/);
        expect((await Specimen.findOne({ barcode: barcodes.blood })).status).toBe('in_transit');

        const twice = await call(tech.handOver, { auth, body: { lab: 'MICRO_HEALTH', barcodes: [barcodes.blood] }, headers: { 'Idempotency-Key': 'bag-1' } });
        expect(twice.body.manifest.code).toBe(bag.body.manifest.code);
        expect(await SampleManifest.countDocuments()).toBe(1);
    });

    it('refuses somebody else’s tubes', async () => {
        const { barcodes } = await collectedTubes();
        const other = await makeTech();
        const r = await call(tech.handOver, { auth: other.auth, body: { lab: 'MICRO_HEALTH', barcodes: [barcodes.blood] } });
        expect(r.code).toBe(404);
    });

    it('receives a bag at once and keeps a missing tube visible', async () => {
        const a = await collectedTubes();
        const b = await collectedTubes();
        const bag = await call(tech.handOver, { auth: a.auth, body: { lab: 'MICRO_HEALTH', barcodes: [a.barcodes.blood] } });
        const seen = await call(visits.adminManifest, { auth: ADMIN, params: { code: bag.body.manifest.code.toLowerCase() } });
        expect(seen.body.manifest).toMatchObject({ lab: 'MICRO_HEALTH', barcodes: [a.barcodes.blood], receivedAt: null });
        expect(JSON.stringify(seen.body)).not.toMatch(/email|phone|address/i);
        expect((await call(visits.adminManifest, { auth: ADMIN, params: { code: 'PQM-NOPE22' } })).code).toBe(404);
        const r = await call(visits.adminReceiveManifest, { auth: ADMIN, params: { code: bag.body.manifest.code } });
        expect(r.body.received).toEqual([a.barcodes.blood]);
        const order = await Order.findById(a.order._id);
        expect(order.items[0].components.find((c) => c.kind === 'blood').status).toBe('sample_received');

        const bagB = await call(tech.handOver, { auth: b.auth, body: { lab: 'MICRO_HEALTH', barcodes: [b.barcodes.blood] } });
        const short = await call(visits.adminReceiveManifest, { auth: ADMIN, params: { code: bagB.body.manifest.code }, body: { missing: [b.barcodes.blood] } });
        expect(short.body.missing).toEqual([b.barcodes.blood]);
        expect((await Specimen.findOne({ barcode: b.barcodes.blood })).status).toBe('in_transit');
        expect((await call(visits.adminReceiveManifest, { auth: ADMIN, params: { code: bagB.body.manifest.code } })).code).toBe(409);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the laboratories’ API', () => {
    const SECRETS = 'MICRO_HEALTH=blood-secret;M42=dna-secret';
    beforeAll(() => { process.env.LAB_WEBHOOK_SECRETS = SECRETS; });
    afterAll(() => { delete process.env.LAB_WEBHOOK_SECRETS; });

    const send = (handler, labCode, payload, secret = labCode === 'M42' ? 'dna-secret' : 'blood-secret', at = Math.floor(Date.now() / 1000)) => {
        const raw = JSON.stringify(payload);
        return call(handler, {
            params: { lab: labCode },
            body: Buffer.from(raw),
            headers: { 'Predyqt-Signature': `t=${at},v1=${labs.sign(secret, at, raw)}` },
        });
    };

    it('refuses an unsigned, mis-signed or replayed request, and says nothing more', async () => {
        const { barcodes } = await collectedTubes();
        const body = { eventId: 'e1', type: 'received', barcode: barcodes.blood };
        expect((await call(lab.events, { params: { lab: 'MICRO_HEALTH' }, body: Buffer.from(JSON.stringify(body)) })).code).toBe(401);
        expect((await send(lab.events, 'MICRO_HEALTH', body, 'wrong')).code).toBe(401);
        expect((await send(lab.events, 'MICRO_HEALTH', body, 'blood-secret', Math.floor(Date.now() / 1000) - 3600)).code).toBe(401);
        expect((await Specimen.findOne({ barcode: barcodes.blood })).status).toBe('collected');
    });

    it('answers an unknown barcode and another lab’s barcode identically', async () => {
        const { barcodes } = await collectedTubes();
        const unknown = await send(lab.events, 'MICRO_HEALTH', { eventId: 'e2', type: 'received', barcode: 'NOPE-123456' });
        const others = await send(lab.events, 'MICRO_HEALTH', { eventId: 'e3', type: 'received', barcode: barcodes.dna });
        expect(unknown.code).toBe(404);
        expect(others.code).toBe(404);
        expect(others.body).toEqual(unknown.body);
    });

    it('receives, processes, and results a blood tube into the record — once', async () => {
        const { user, order, barcodes } = await collectedTubes();
        expect((await send(lab.events, 'MICRO_HEALTH', { eventId: 'r1', type: 'received', barcode: barcodes.blood, accession: 'MH-1' })).code).toBe(200);
        expect((await send(lab.events, 'MICRO_HEALTH', { eventId: 'p1', type: 'processing', barcode: barcodes.blood })).code).toBe(200);

        const result = {
            resultId: 'res-1', barcode: barcodes.blood, reportedAt: new Date().toISOString(), panel: { name: 'Lipid profile' },
            analytes: [{ code: '2093-3', system: 'LOINC', name: 'Total Cholesterol', value: 5.4, unit: 'mmol/L', refLow: 0, refHigh: 5.2 }],
        };
        const r = await send(lab.results, 'MICRO_HEALTH', result);
        expect(r.code).toBe(202);
        const tr = await TestResult.findById(r.body.id).lean();
        expect(tr).toMatchObject({ source: 'lab_integration', patient: { lab_name: 'Micro Health Laboratories' } });
        expect(await Biomarker.countDocuments({ userId: user._id, testResultId: tr._id })).toBe(1);

        const blood = (await Order.findById(order._id)).items[0].components.find((c) => c.kind === 'blood');
        expect(blood.status).toBe('resulted');
        expect(String(blood.testResultId)).toBe(r.body.id);
        expect(mockRequestGeneration).toHaveBeenCalledWith(expect.objectContaining({ testResultId: blood.testResultId }));

        const replay = await send(lab.results, 'MICRO_HEALTH', result);
        expect(replay.code).toBe(200);
        expect(replay.body.replay).toBe(true);
        expect(await TestResult.countDocuments({ 'patient.user_id': user._id })).toBe(1);

        const again = await send(lab.results, 'MICRO_HEALTH', { ...result, resultId: 'res-2' });
        expect(again.body.reason).toBe('state');
        const corrected = await send(lab.results, 'MICRO_HEALTH', { ...result, resultId: 'res-3', supersedes: 'res-1' });
        expect(corrected.body.corrected).toBe(true);
        expect(await TestResult.countDocuments({ 'patient.user_id': user._id })).toBe(2);
    });

    it('lists every fault in a malformed result', async () => {
        const { barcodes } = await collectedTubes();
        const r = await send(lab.results, 'MICRO_HEALTH', {
            resultId: 'bad-1', barcode: barcodes.blood, analytes: [{ name: 'Glucose', value: 'high' }, { value: 3 }],
        });
        expect(r.code).toBe(422);
    });

    it('takes a DNA result as a report, even one with nothing to report', async () => {
        const { order, barcodes } = await collectedTubes();
        const r = await send(lab.results, 'M42', { resultId: 'dna-1', barcode: barcodes.dna, variants: [] });
        expect(r.code).toBe(202);
        expect(await DnaReport.countDocuments({ orderId: order._id })).toBe(1);
        const dna = (await Order.findById(order._id)).items[0].components.find((c) => c.kind === 'dna');
        expect(dna.status).toBe('resulted');
    });

    it('a rejected tube puts the kit back and asks the customer for a new sample', async () => {
        const { user, order, barcodes } = await collectedTubes();
        await send(lab.events, 'MICRO_HEALTH', { eventId: 'x1', type: 'rejected', barcode: barcodes.blood, reason: 'haemolysed' });
        const blood = (await Order.findById(order._id)).items[0].components.find((c) => c.kind === 'blood');
        expect(blood.status).toBe('placed');
        expect(await titlesFor(user._id, ['We need a new sample'])).toContain('We need a new sample');
        expect((await send(lab.results, 'MICRO_HEALTH', { resultId: 'late', barcode: barcodes.blood, analytes: [{ name: 'Glucose', value: 5 }] })).code).toBe(409);
    });

    it('is not open when a lab has no secret configured', async () => {
        process.env.LAB_WEBHOOK_SECRETS = 'M42=dna-secret';
        const r = await send(lab.events, 'MICRO_HEALTH', { eventId: 'n1', type: 'received', barcode: 'PQB-000000' });
        expect(r.code).toBe(503);
        process.env.LAB_WEBHOOK_SECRETS = SECRETS;
    });
});
