/**
 * Technicians — the roster, assignment, and what happens at the door.
 *
 * The failures each block prevents:
 *
 *   - a slot offered when nobody is working, so a customer books a visit no one will make;
 *   - a technician given two visits in one half-hour on opposite sides of a city;
 *   - an auto-assign that answers differently each time it is pressed;
 *   - a technician reading another technician's round of home addresses;
 *   - a tube labelled at the wrong door, because nobody checked who opened it;
 *   - a bracelet handed over that nothing can link back to the person who has it.
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

const mongoose = require('mongoose');
const User = require('../models/userModel');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Market = require('../models/Market');
const Technician = require('../models/Technician');
const CollectionVisit = require('../models/CollectionVisit');
const CollectionSlot = require('../models/CollectionSlot');
const Notification = require('../models/Notification');

const M = require('../utils/markets');
const R = require('../utils/roster');
const centre = require('../utils/collectionCentre');
const orders = require('../controllers/orderController');
const visits = require('../controllers/collectionController');
const tech = require('../controllers/technicianController');

const call = async (handler, req) => {
    let body = null;
    let code = 200;
    const res = {
        status(c) { code = c; return this; },
        json(p) { body = p; return this; },
        set() { return this; },
    };
    await handler({ params: {}, query: {}, body: {}, ...req }, res);
    return { code, body };
};

const ALL_WEEK = (start = 0, end = 1440) => [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, startMinute: start, endMinute: end }));
const makeUser = (over = {}) => User.create({
    username: `u${new mongoose.Types.ObjectId()}`,
    email: `${new mongoose.Types.ObjectId()}@example.com`,
    supabaseId: String(new mongoose.Types.ObjectId()),
    ...over,
});
const authFor = (u, role = 'user') => ({ userId: String(u._id), email: u.email, emailVerified: true, role });
const ADMIN = { userId: String(new mongoose.Types.ObjectId()), role: 'admin' };
const ADDRESS = {
    address: { building: 'Villa 12', area: 'Jumeirah 1', city: 'Dubai' },
    phone: '+971 50 000 0000',
};

/** A technician with a login, on shift all week unless told otherwise. */
const makeTech = async (over = {}) => {
    const user = await makeUser();
    const t = await Technician.create({
        name: `Tech ${new mongoose.Types.ObjectId().toString().slice(-4)}`,
        email: user.email, market: 'AE', userId: user._id, shifts: ALL_WEEK(), ...over,
    });
    return { user, t, auth: authFor(user, 'technician') };
};

const firstSlot = async (hours = 30) => {
    const market = await Market.resolve('AE');
    const after = Date.now() + hours * 3600000;
    return M.slotsFor(market, { now: new Date() }).flatMap((d) => d.slots).find((s) => new Date(s.start).getTime() >= after).start;
};

/** A booked visit (no payment provider in this suite, so orders are placed and booked at once). */
const bookedVisit = async ({ customer, start, includes = ['blood', 'dna', 'bracelet'], city = 'Dubai' } = {}) => {
    const user = customer || await makeUser({ firstName: 'Layla' });
    const p = await Product.create({ name: 'Plus', sku: `P-${new mongoose.Types.ObjectId()}`, price: 1, includes, type: 'package' });
    const { code, body } = await call(orders.createOrder, {
        auth: authFor(user),
        body: {
            items: [{ productId: String(p._id) }], currency: 'AED',
            fulfilment: { method: 'home_collection', slotStart: start || await firstSlot(), ...ADDRESS, address: { ...ADDRESS.address, city } },
        },
    });
    expect(code).toBe(201);
    return { user, visit: await CollectionVisit.findById(body.order.fulfilment.visitId), order: body.order };
};

// ─────────────────────────────────────────────────────────────────────────────
describe('the roster', () => {
    const ae = M.completeMarket('AE', { visits: { capacityMode: 'roster' } });
    const sunday8 = '2026-10-11T04:00:00Z'; // Sun 11 Oct, 08:00 Dubai

    it('counts a technician only for a slot their shift covers whole, in the market’s clock', () => {
        const t = { _id: 'a', name: 'A', active: true, market: 'AE', shifts: [{ day: 0, startMinute: 480, endMinute: 1020 }] };
        expect(R.onShift(t, ae, sunday8)).toBe(true);
        expect(R.onShift(t, ae, '2026-10-11T12:45:00Z')).toBe(false); // 16:45–17:15 overruns the shift
        expect(R.onShift(t, ae, '2026-10-12T04:00:00Z')).toBe(false); // Monday
        expect(R.onShift({ ...t, timeOff: [{ from: '2026-10-10', to: '2026-10-12' }] }, ae, sunday8)).toBe(false);
        expect(R.onShift({ ...t, active: false }, ae, sunday8)).toBe(false);
        expect(R.onShift({ ...t, market: 'GB' }, ae, sunday8)).toBe(false);
    });

    it('makes capacity the technicians on shift, or the fixed figure', () => {
        const t = (id, n = 1) => ({ _id: id, name: id, active: true, market: 'AE', visitsPerSlot: n, shifts: ALL_WEEK() });
        expect(R.capacityAt(ae, [t('a'), t('b', 2)], sunday8)).toBe(3);
        expect(R.capacityAt(ae, [], sunday8)).toBe(0);
        expect(R.capacityAt(M.completeMarket('AE', null), [], sunday8)).toBe(5);
    });

    it('auto-assigns by shift, area and load — and the same way every time', () => {
        const techs = [
            { _id: 't1', name: 'Amal', active: true, market: 'AE', areas: ['Dubai'], shifts: ALL_WEEK() },
            { _id: 't2', name: 'Bilal', active: true, market: 'AE', areas: [], shifts: ALL_WEEK() },
        ];
        const v = (id, iso, city) => ({ _id: id, status: 'booked', slot: { start: new Date(iso) }, address: { city } });
        const day = [
            v('v1', sunday8, 'Dubai'),
            v('v2', sunday8, 'Dubai'),
            v('v3', sunday8, 'Dubai'),
            v('v4', '2026-10-11T05:00:00Z', 'Sharjah'),
        ];
        const plan = R.autoAssign(ae, day, techs);
        expect(plan.assignments).toEqual([
            { visitId: 'v1', technicianId: 't1' },
            { visitId: 'v2', technicianId: 't2' },
            { visitId: 'v4', technicianId: 't2' },
        ]);
        expect(plan.unassigned).toEqual([{ visitId: 'v3', reason: 'Everyone covering that area is busy in that slot' }]);
        expect(R.autoAssign(ae, day, techs)).toEqual(plan);
        expect(R.autoAssign(ae, [v('v9', sunday8, 'Fujairah')], [techs[0]]).unassigned[0].reason).toMatch(/covers Fujairah/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('capacity from the roster', () => {
    it('offers nothing when nobody is working, and exactly the people on shift when they are', async () => {
        await Market.create({ code: 'AE', visits: { capacityMode: 'roster' } });
        const market = await Market.resolve('AE');
        const start = await firstSlot();

        expect(await centre.reserve(market, new Date(start))).toBe(false);
        expect(await CollectionSlot.countDocuments()).toBe(0);
        const empty = (await centre.availability(market)).flatMap((d) => d.slots);
        expect(empty.every((s) => s.remaining === 0)).toBe(true);

        await makeTech();
        await makeTech();
        expect((await centre.availability(market)).flatMap((d) => d.slots).find((s) => s.start === start).remaining).toBe(2);
        expect(await centre.reserve(market, new Date(start))).toBe(true);
        expect(await centre.reserve(market, new Date(start))).toBe(true);
        expect(await centre.reserve(market, new Date(start))).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('assigning', () => {
    it('refuses a technician off shift, busy, or in another market — unless forced', async () => {
        const { visit } = await bookedVisit();
        const night = await makeTech({ shifts: [] });
        const r1 = await call(visits.adminAssign, { auth: ADMIN, params: { id: String(visit._id) }, body: { technicianId: String(night.t._id) } });
        expect(r1.body.reason).toBe('shift');
        const forced = await call(visits.adminAssign, { auth: ADMIN, params: { id: String(visit._id) }, body: { technicianId: String(night.t._id), force: true } });
        expect(forced.body.visit.technician.name).toBe(night.t.name);

        const day = await makeTech();
        const second = await bookedVisit({ start: visit.slot.start.toISOString() });
        await call(visits.adminAssign, { auth: ADMIN, params: { id: String(second.visit._id) }, body: { technicianId: String(day.t._id) } });
        const third = await bookedVisit({ start: visit.slot.start.toISOString() });
        const busy = await call(visits.adminAssign, { auth: ADMIN, params: { id: String(third.visit._id) }, body: { technicianId: String(day.t._id) } });
        expect(busy.body.reason).toBe('busy');

        const abroad = await makeTech({ market: 'GB' });
        const other = await call(visits.adminAssign, { auth: ADMIN, params: { id: String(third.visit._id) }, body: { technicianId: String(abroad.t._id) } });
        expect(other.body.reason).toBe('market');
    });

    it('auto-assigns a day through the API and says why anything was left', async () => {
        const start = await firstSlot();
        const a = await bookedVisit({ start });
        const b = await bookedVisit({ start, city: 'Fujairah' });
        await makeTech({ areas: ['Dubai'] });
        const date = M.localDay(new Date(start), 'Asia/Dubai');
        const { body } = await call(visits.adminAutoAssign, { auth: ADMIN, body: { market: 'AE', date } });
        expect(body.assigned).toBe(1);
        expect(body.unassigned).toEqual([{ visitId: String(b.visit._id), reason: 'Nobody on shift covers Fujairah' }]);
        expect((await CollectionVisit.findById(a.visit._id)).status).toBe('assigned');
    });

    it('a moved visit loses its technician', async () => {
        const { user, visit } = await bookedVisit();
        const t = await makeTech();
        await call(visits.adminAssign, { auth: ADMIN, params: { id: String(visit._id) }, body: { technicianId: String(t.t._id) } });
        await call(visits.rescheduleMine, { auth: authFor(user), params: { id: String(visit._id) }, body: { slotStart: await firstSlot(60) } });
        const moved = await CollectionVisit.findById(visit._id);
        expect(moved.technicianId).toBeUndefined();
        expect(moved.status).toBe('booked');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a technician’s own day', () => {
    it('links a profile by the verified email on first use, never by an unverified one', async () => {
        const user = await makeUser({ email: 'new.tech@example.ae' });
        await Technician.create({ name: 'New Tech', email: 'new.tech@example.ae', market: 'AE' });
        const refused = await call(tech.getMe, { auth: { ...authFor(user, 'technician'), emailVerified: false } });
        expect(refused.code).toBe(403);
        const ok = await call(tech.getMe, { auth: authFor(user, 'technician') });
        expect(ok.code).toBe(200);
        expect(String((await Technician.findOne({ email: 'new.tech@example.ae' })).userId)).toBe(String(user._id));
    });

    it('shows only their own visits, and nothing a door does not need', async () => {
        const { visit } = await bookedVisit();
        const mine = await makeTech();
        const theirs = await makeTech();
        await call(visits.adminAssign, { auth: ADMIN, params: { id: String(visit._id) }, body: { technicianId: String(mine.t._id) } });

        const date = M.localDay(visit.slot.start, 'Asia/Dubai');
        const day = await call(tech.myDay, { auth: mine.auth, query: { date } });
        expect(day.body.visits).toHaveLength(1);
        const seen = day.body.visits[0];
        expect(seen).toMatchObject({ name: 'Layla', phone: '+971 50 000 0000' });
        expect(JSON.stringify(seen)).not.toMatch(new RegExp(visit.passCode));
        expect(seen).not.toHaveProperty('email');

        expect((await call(tech.myDay, { auth: theirs.auth, query: { date } })).body.visits).toHaveLength(0);
        expect((await call(tech.getVisit, { auth: theirs.auth, params: { id: String(visit._id) } })).code).toBe(404);
        expect((await call(tech.start, { auth: theirs.auth, params: { id: String(visit._id) } })).code).toBe(404);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('at the door', () => {
    const doorResults = (v) => v.tasks.map((t) => ({
        taskId: String(t._id),
        status: 'done',
        barcode: t.kind === 'collect_blood' ? `B-${String(v._id).slice(-8)}` : t.kind === 'collect_dna' ? `D-${String(v._id).slice(-8)}` : `SN:${String(v._id).slice(-8)}`,
    }));

    const assignedVisit = async () => {
        const booked = await bookedVisit();
        const t = await makeTech();
        await call(visits.adminAssign, { auth: ADMIN, params: { id: String(booked.visit._id) }, body: { technicianId: String(t.t._id) } });
        return { ...booked, t, visit: await CollectionVisit.findById(booked.visit._id) };
    };

    it('tells the customer when the technician sets off', async () => {
        const { user, visit, t } = await assignedVisit();
        const r = await call(tech.start, { auth: t.auth, params: { id: String(visit._id) } });
        expect(r.body.visit.status).toBe('en_route');
        const until = Date.now() + 2000;
        let card = null;
        while (!card && Date.now() < until) {
            card = await Notification.findOne({ userId: user._id, title: 'Your technician is on the way' }).lean();
            if (!card) await new Promise((res) => setTimeout(res, 25));
        }
        expect(card.body).toMatch(new RegExp(t.t.name.split(' ')[0]));
    });

    it('checks the visit pass: wrong code, another visit’s QR, then the right one', async () => {
        const { visit, t } = await assignedVisit();
        const other = await assignedVisit();
        const id = { id: String(visit._id) };

        expect((await call(tech.verify, { auth: t.auth, params: id, body: { code: 'AAAAAA' } })).body.reason).toBe('mismatch');
        const wrongDoor = await call(tech.verify, { auth: t.auth, params: id, body: { code: `PQV1:${other.visit._id}:${other.visit.passCode}` } });
        expect(wrongDoor.body.message).toMatch(/different visit/);

        const ok = await call(tech.verify, { auth: t.auth, params: id, body: { code: `PQV1:${visit._id}:${visit.passCode}` } });
        expect(ok.body.visit).toMatchObject({ status: 'arrived', identityChecked: true });
        // Typed, with a space, also works.
        const typed = await assignedVisit();
        const code = `${typed.visit.passCode.slice(0, 3)} ${typed.visit.passCode.slice(3).toLowerCase()}`;
        expect((await call(tech.verify, { auth: typed.t.auth, params: { id: String(typed.visit._id) }, body: { code } })).code).toBe(200);
    });

    it('will not record a visit until identity is checked one way or the other', async () => {
        const { visit, t } = await assignedVisit();
        const id = { id: String(visit._id) };
        const blind = await call(tech.complete, { auth: t.auth, params: id, body: { tasks: doorResults(visit) } });
        expect(blind.body.reason).toBe('identity');

        const manual = await call(tech.complete, { auth: t.auth, params: id, body: { tasks: doorResults(visit), identityConfirmed: true } });
        expect(manual.code).toBe(200);
        expect((await CollectionVisit.findById(visit._id)).identity.method).toBe('manual');
    });

    it('records the pass check when it was scanned, without asking again', async () => {
        const { visit, t } = await assignedVisit();
        const id = { id: String(visit._id) };
        await call(tech.verify, { auth: t.auth, params: id, body: { code: visit.passCode } });
        const r = await call(tech.complete, { auth: t.auth, params: id, body: { tasks: doorResults(visit) } });
        expect(r.code).toBe(200);
        expect((await CollectionVisit.findById(visit._id)).identity.method).toBe('pass');
    });

    it('needs the bracelet’s serial, stores it on the parcel, and never takes it twice', async () => {
        const { visit, t, order } = await assignedVisit();
        const id = { id: String(visit._id) };
        const noSerial = doorResults(visit).map((r) => (visit.tasks.find((x) => String(x._id) === r.taskId).kind === 'handover_bracelet' ? { ...r, barcode: '' } : r));
        expect((await call(tech.complete, { auth: t.auth, params: id, body: { tasks: noSerial, identityConfirmed: true } })).body.reason).toBe('serial');

        await call(tech.complete, { auth: t.auth, params: id, body: { tasks: doorResults(visit), identityConfirmed: true } });
        const bracelet = (await Order.findById(order._id)).items[0].components.find((c) => c.kind === 'bracelet');
        expect({ status: bracelet.status, deviceSerial: bracelet.deviceSerial }).toEqual({ status: 'delivered', deviceSerial: `SN:${String(visit._id).slice(-8)}`.toUpperCase() });

        const again = await assignedVisit();
        const reuse = doorResults(again.visit).map((r) => (again.visit.tasks.find((x) => String(x._id) === r.taskId).kind === 'handover_bracelet'
            ? { ...r, barcode: bracelet.deviceSerial } : r));
        const dup = await call(tech.complete, { auth: again.t.auth, params: { id: String(again.visit._id) }, body: { tasks: reuse, identityConfirmed: true } });
        expect(dup.code).toBe(409);
    });

    it('gives the customer a pass while a technician is coming, and only them', async () => {
        const { user, visit } = await assignedVisit();
        const pass = await call(visits.getPass, { auth: authFor(user), params: { id: String(visit._id) } });
        expect(pass.code).toBe(200);
        expect(pass.body.svg).toMatch(/^<svg/);
        expect(pass.body.code.replace(' ', '')).toBe(visit.passCode);
        const stranger = await makeUser();
        expect((await call(visits.getPass, { auth: authFor(stranger), params: { id: String(visit._id) } })).code).toBe(404);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the roster API', () => {
    it('validates areas against the market and shifts in 15-minute steps', async () => {
        const bad = await call(tech.create, { auth: ADMIN, body: { name: 'X', email: 'x@example.ae', market: 'AE', areas: ['Muscat'] } });
        expect(bad.code).toBe(400);
        const shifts = await call(tech.create, { auth: ADMIN, body: { name: 'X', email: 'x@example.ae', market: 'AE', shifts: [{ day: 1, startMinute: 485, endMinute: 900 }] } });
        expect(shifts.code).toBe(400);
        const ok = await call(tech.create, { auth: ADMIN, body: { name: 'Sara', email: 'Sara@Example.ae', market: 'AE', areas: ['Dubai'], shifts: ALL_WEEK(480, 1020) } });
        expect(ok.code).toBe(201);
        expect(ok.body.technician).toMatchObject({ email: 'sara@example.ae', linked: false, areas: ['Dubai'] });
        expect((await call(tech.create, { auth: ADMIN, body: { name: 'Sara 2', email: 'sara@example.ae', market: 'AE' } })).code).toBe(409);
    });
});
