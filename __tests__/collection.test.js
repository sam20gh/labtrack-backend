/**
 * Home sample collection — markets, slots, visits, barcodes.
 *
 * What each block pins, as the failure it prevents:
 *
 *   - a slot in Dubai labelled in the server's clock, so a 08:00 visit arrives at noon;
 *   - two people taking the last place in a slot at the same moment;
 *   - a hold that never lapses, so an abandoned checkout keeps a technician's slot for ever;
 *   - a paid order lost because its hold lapsed a minute before the money landed;
 *   - a customer moving a visit an hour before a technician sets off;
 *   - a tube recorded as collected with no barcode, or with somebody else's;
 *   - the per-parcel admin button marking a kit "collected" with no visit behind it;
 *   - a website visit that never reaches the app account that claims the order.
 */
jest.mock('../utils/pushSender', () => {
    const actual = jest.requireActual('../utils/pushSender');
    return { ...actual, send: jest.fn(async (m) => ({ sent: m.length, failed: 0, pruned: 0 })) };
});

const mockStripe = { checkout: { sessions: { create: jest.fn(), retrieve: jest.fn() } } };
jest.mock('../config/stripe', () => ({
    getStripe: () => mockStripe,
    isConfigured: () => true,
    isTestMode: () => true,
    toMinorUnits: (a) => Math.round(Number(a) * 100),
    stripeCurrency: (c) => String(c).toLowerCase(),
    CURRENCY: 'gbp',
    WEBHOOK_SECRETS: [],
}));

const mongoose = require('mongoose');
const User = require('../models/userModel');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Market = require('../models/Market');
const CollectionSlot = require('../models/CollectionSlot');
const CollectionVisit = require('../models/CollectionVisit');
const Specimen = require('../models/Specimen');
const Notification = require('../models/Notification');

const M = require('../utils/markets');
const centre = require('../utils/collectionCentre');
const { deriveJourney } = require('../utils/onboardingState');
const orders = require('../controllers/orderController');
const checkout = require('../controllers/checkoutController');
const visits = require('../controllers/collectionController');
const { markOrderPaid } = require('../controllers/paymentController');
const { claimByEmail } = require('../utils/claimOrders');
const { runCollectionSweep } = require('../jobs/collectionJob');

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

const makeUser = (over = {}) => User.create({
    username: `u${new mongoose.Types.ObjectId()}`,
    email: `${new mongoose.Types.ObjectId()}@example.com`,
    supabaseId: String(new mongoose.Types.ObjectId()),
    ...over,
});
const authFor = (u) => ({ userId: String(u._id), email: u.email, emailVerified: true, role: 'user' });
const ADMIN = { userId: String(new mongoose.Types.ObjectId()), role: 'admin' };

const pkg = (over = {}) => Product.create({
    name: 'Predyqt Plus',
    sku: `PKG-${new mongoose.Types.ObjectId()}`,
    price: 249,
    prices: { AED: 999 },
    type: 'package',
    includes: ['blood', 'dna', 'bracelet'],
    package: { tier: 'Plus', rank: 1 },
    ...over,
});

const ADDRESS = {
    address: { building: 'Marina Heights, Apt 1204', street: 'Al Marsa St', area: 'Dubai Marina', city: 'Dubai', landmark: 'Near the tram stop' },
    phone: '+971 50 123 4567',
    contactName: 'Layla',
};

const ae = () => Market.resolve('AE');

/** The first slot at least `hours` from now, as the API would offer it. */
const slotAfter = async (hours = 30) => {
    const market = await ae();
    const days = M.slotsFor(market, { now: new Date() });
    const after = Date.now() + hours * 3600000;
    return days.flatMap((d) => d.slots).find((s) => new Date(s.start).getTime() >= after).start;
};

const titlesFor = async (userId, expected, timeoutMs = 2000) => {
    const until = Date.now() + timeoutMs;
    let titles = [];
    while (Date.now() < until) {
        titles = (await Notification.find({ userId }).lean()).map((c) => c.title);
        if (expected.every((t) => titles.includes(t))) return titles;
        await new Promise((r) => setTimeout(r, 25));
    }
    return titles;
};

/** An app order for a package, with a visit, paid. */
const paidVisitOrder = async (user, { slotStart } = {}) => {
    const p = await pkg();
    const start = slotStart || await slotAfter();
    const { code, body } = await call(orders.createOrder, {
        auth: authFor(user),
        body: { items: [{ productId: String(p._id) }], currency: 'AED', fulfilment: { method: 'home_collection', slotStart: start, ...ADDRESS } },
    });
    expect(code).toBe(201);
    await markOrderPaid({ id: 'pi_test', metadata: { orderId: String(body.order._id) } });
    const order = await Order.findById(body.order._id);
    const visit = await CollectionVisit.findById(order.fulfilment.visitId);
    return { order, visit, start };
};

beforeEach(() => {
    mockStripe.checkout.sessions.create.mockReset();
    mockStripe.checkout.sessions.retrieve.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('markets and their clock', () => {
    it('labels Dubai slots on the Dubai clock, whatever the server runs on', () => {
        expect(M.localToUtc('2026-10-14', 8 * 60, 'Asia/Dubai').toISOString()).toBe('2026-10-14T04:00:00.000Z');
        // London across a clock change still lands on the right instant.
        expect(M.localToUtc('2026-07-01', 8 * 60, 'Europe/London').toISOString()).toBe('2026-07-01T07:00:00.000Z');
        expect(M.describeSlot(new Date('2026-10-14T04:00:00Z'), new Date('2026-10-14T04:30:00Z'), 'Asia/Dubai'))
            .toBe('Wed 14 Oct, 08:00–08:30');
    });

    it('offers the UAE around the clock in 30-minute slots, five a slot, after the notice period', () => {
        const market = M.completeMarket('AE', null);
        const now = new Date('2026-10-09T20:47:00Z'); // 00:47 Dubai
        const days = M.slotsFor(market, { now });
        expect(days).toHaveLength(14);
        expect(days[1].slots).toHaveLength(48);
        expect(days[0].slots[0].label).toBe('07:00'); // six hours' notice from 00:47
        expect(days[1].slots[0]).toMatchObject({ label: '00:00', remaining: 5 });
    });

    it('subtracts what is taken, and keeps a full slot visible at zero', () => {
        const market = M.completeMarket('AE', null);
        const now = new Date('2026-10-09T20:47:00Z');
        const first = M.slotsFor(market, { now })[1].slots[0].start;
        const days = M.slotsFor(market, { now, taken: new Map([[first, 5]]) });
        expect(days[1].slots[0].remaining).toBe(0);
    });

    it('refuses a time that is not one of the slots, too soon, or too far', () => {
        const market = M.completeMarket('AE', null);
        const now = new Date('2026-10-09T20:47:00Z');
        expect(M.isBookableStart(market, '2026-10-11T04:00:00Z', now)).toEqual({ ok: true });
        expect(M.isBookableStart(market, '2026-10-11T04:10:00Z', now).reason).toBe('not_a_slot');
        expect(M.isBookableStart(market, '2026-10-10T00:00:00Z', now).reason).toBe('too_soon');
        expect(M.isBookableStart(market, '2026-11-30T04:00:00Z', now).reason).toBe('too_far');
        const closed = M.completeMarket('AE', { visits: { blackoutDates: ['2026-10-11'] } });
        expect(M.isBookableStart(closed, '2026-10-11T04:00:00Z', now).reason).toBe('closed');
    });

    it('validates an admin edit whole, and never leaves a market with no way to sell', () => {
        expect(M.cleanMarketPatch('AE', { fulfilment: { post: false, homeCollection: false } }).ok).toBe(false);
        expect(M.cleanMarketPatch('AE', { visits: { slotMinutes: 7 } }).ok).toBe(false);
        expect(M.cleanMarketPatch('AE', { visits: { openMinute: 600, closeMinute: 540 } }).ok).toBe(false);
        expect(M.cleanMarketPatch('GB', { fulfilment: { homeCollection: true } }).errors).toContain('Home collection needs at least one service area.');
        // Turning off the default falls to the other rather than refusing.
        expect(M.cleanMarketPatch('AE', { fulfilment: { homeCollection: false } }).value.fulfilment.default).toBe('post');
    });

    it('lists collection first in the UAE, with its price, and only post elsewhere', () => {
        expect(M.fulfilmentOptions(M.completeMarket('AE', { visits: { price: 50 } })).map((o) => [o.method, o.price]))
            .toEqual([['post', 0], ['home_collection', 50]]);
        expect(M.fulfilmentOptions(M.completeMarket('GB', null)).map((o) => o.method)).toEqual(['post']);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('capacity', () => {
    it('sells exactly the slot’s capacity when everybody taps at once', async () => {
        const market = await ae();
        const start = new Date(await slotAfter());
        const results = await Promise.all(Array.from({ length: 8 }, () => centre.reserve(market, start)));
        expect(results.filter(Boolean)).toHaveLength(5);
        expect((await CollectionSlot.findOne({ market: 'AE', start })).count).toBe(5);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('booking at checkout (app)', () => {
    it('charges the market’s visit price, holds the slot, and books it when paid', async () => {
        await Market.create({ code: 'AE', visits: { price: 50 } });
        const user = await makeUser();
        const p = await pkg();
        const start = await slotAfter();
        const { code, body } = await call(orders.createOrder, {
            auth: authFor(user),
            body: { items: [{ productId: String(p._id) }], currency: 'AED', fulfilment: { method: 'home_collection', slotStart: start, ...ADDRESS } },
        });
        expect(code).toBe(201);
        expect(body.order).toMatchObject({ total: 1049, subtotal: 999, status: 'pending_payment' });
        expect(body.order.fulfilment).toMatchObject({ method: 'home_collection', market: 'AE', fee: 50 });
        expect(body.order.items[0].components.every((c) => c.method === 'home_collection')).toBe(true);
        expect(body.order.shippingAddress.city).toBe('Dubai');

        let visit = await CollectionVisit.findById(body.order.fulfilment.visitId);
        expect(visit.status).toBe('held');
        expect(visit.holdExpiresAt.getTime()).toBeGreaterThan(Date.now() + 30 * 60000);
        expect(visit.tasks.map((t) => t.kind).sort()).toEqual(['collect_blood', 'collect_dna', 'handover_bracelet']);

        await markOrderPaid({ id: 'pi_1', metadata: { orderId: String(body.order._id) } });
        visit = await CollectionVisit.findById(visit._id);
        expect(visit.status).toBe('booked');
        const order = await Order.findById(body.order._id);
        expect(order.items[0].components.map((c) => c.status)).toEqual(['visit_booked', 'visit_booked', 'visit_booked']);
        expect(await titlesFor(user._id, ['Your collection visit is booked'])).toContain('Your collection visit is booked');
    });

    it('refuses a method the market does not offer, and an address it cannot visit', async () => {
        const user = await makeUser();
        const p = await pkg();
        const gb = await call(orders.createOrder, { auth: authFor(user), body: { items: [{ productId: String(p._id) }], currency: 'GBP', fulfilment: { method: 'home_collection' } } });
        expect(gb.code).toBe(400);

        const start = await slotAfter();
        const far = await call(orders.createOrder, {
            auth: authFor(user),
            body: { items: [{ productId: String(p._id) }], currency: 'AED', fulfilment: { method: 'home_collection', slotStart: start, ...ADDRESS, address: { ...ADDRESS.address, city: 'Muscat' } } },
        });
        expect(far.code).toBe(400);
        expect(far.body.message).toMatch(/do not visit Muscat/);
    });

    it('withdraws the order when the slot filled in the seconds since it was chosen', async () => {
        const user = await makeUser();
        const p = await pkg();
        const start = await slotAfter();
        await CollectionSlot.create({ market: 'AE', start: new Date(start), count: 5 });
        const { code, body } = await call(orders.createOrder, {
            auth: authFor(user),
            body: { items: [{ productId: String(p._id) }], currency: 'AED', fulfilment: { method: 'home_collection', slotStart: start, ...ADDRESS } },
        });
        expect(code).toBe(409);
        expect(body.reason).toBe('full');
        expect(await Order.countDocuments({ userId: user._id })).toBe(0);
    });

    it('lets the customer book later — the journey then asks for it', async () => {
        const user = await makeUser({ dob: '1990-01-01', gender: 'Female', height: 160, weight: 60 });
        const p = await pkg();
        const { body } = await call(orders.createOrder, {
            auth: authFor(user), body: { items: [{ productId: String(p._id) }], currency: 'AED', fulfilment: { method: 'home_collection' } },
        });
        await markOrderPaid({ id: 'pi_2', metadata: { orderId: String(body.order._id) } });
        const order = await Order.findById(body.order._id).lean();
        const j = deriveJourney({ user, orders: [order], visits: [] });
        const step = j.steps.find((s) => s.key === 'package');
        expect(step.action.route).toBe(`/collection/book?orderId=${order._id}`);
        expect(j.kits[0].wait).toMatch(/Book a visit/);

        const booked = await call(visits.bookMine, { auth: authFor(user), body: { orderId: String(order._id), slotStart: await slotAfter(), ...ADDRESS } });
        expect(booked.code).toBe(201);
        expect(booked.body.visit.status).toBe('booked');
        const again = await call(visits.bookMine, { auth: authFor(user), body: { orderId: String(order._id), slotStart: await slotAfter(40), ...ADDRESS } });
        expect(again.code).toBe(409);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('holds that lapse', () => {
    it('gives the place back when nobody pays', async () => {
        const user = await makeUser();
        const p = await pkg();
        const start = await slotAfter();
        const { body } = await call(orders.createOrder, {
            auth: authFor(user), body: { items: [{ productId: String(p._id) }], currency: 'AED', fulfilment: { method: 'home_collection', slotStart: start, ...ADDRESS } },
        });
        expect((await CollectionSlot.findOne({ start: new Date(start) })).count).toBe(1);

        const later = new Date(Date.now() + 40 * 60000);
        expect(await runCollectionSweep(later)).toMatchObject({ expired: 1 });
        expect((await CollectionSlot.findOne({ start: new Date(start) })).count).toBe(0);
        expect((await CollectionVisit.findById(body.order.fulfilment.visitId)).status).toBe('expired');
    });

    it('still books a lapsed hold when the money lands and the slot is free; asks to rebook when it is not', async () => {
        const user = await makeUser();
        const p = await pkg();
        const start = await slotAfter();
        const make = async () => (await call(orders.createOrder, {
            auth: authFor(user), body: { items: [{ productId: String(p._id) }], currency: 'AED', fulfilment: { method: 'home_collection', slotStart: start, ...ADDRESS } },
        })).body.order;

        const a = await make();
        await centre.expireHolds(new Date(Date.now() + 40 * 60000));
        await markOrderPaid({ id: 'pi_a', metadata: { orderId: String(a._id) } });
        expect((await CollectionVisit.findById(a.fulfilment.visitId)).status).toBe('booked');

        const b = await make();
        await centre.expireHolds(new Date(Date.now() + 40 * 60000));
        await CollectionSlot.updateOne({ market: 'AE', start: new Date(start) }, { $set: { count: 5 } });
        await markOrderPaid({ id: 'pi_b', metadata: { orderId: String(b._id) } });
        expect((await CollectionVisit.findById(b.fulfilment.visitId)).status).toBe('needs_rebooking');
        expect((await Order.findById(b._id)).payment.status).toBe('paid');
        expect(await titlesFor(user._id, ['Please choose a new visit time'])).toContain('Please choose a new visit time');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('moving and cancelling', () => {
    it('moves a visit, releasing the old place; refuses inside the cut-off; admins are not cut off', async () => {
        const user = await makeUser();
        const { visit, start } = await paidVisitOrder(user);
        const next = await slotAfter(50);
        const moved = await call(visits.rescheduleMine, { auth: authFor(user), params: { id: String(visit._id) }, body: { slotStart: next } });
        expect(moved.code).toBe(200);
        expect((await CollectionSlot.findOne({ start: new Date(start) })).count).toBe(0);
        expect((await CollectionSlot.findOne({ start: new Date(next) })).count).toBe(1);

        // An hour away, with a three-hour cut-off.
        const soon = new Date(Date.now() + 3600000);
        await CollectionVisit.updateOne({ _id: visit._id }, { $set: { 'slot.start': soon, 'slot.end': new Date(soon.getTime() + 1800000) } });
        const late = await call(visits.rescheduleMine, { auth: authFor(user), params: { id: String(visit._id) }, body: { slotStart: await slotAfter(60) } });
        expect(late.code).toBe(409);
        expect(late.body.reason).toBe('cutoff');
        const byAdmin = await call(visits.adminReschedule, { auth: ADMIN, params: { id: String(visit._id) }, body: { slotStart: await slotAfter(60) } });
        expect(byAdmin.code).toBe(200);
    });

    it('cancelling a visit keeps the order and returns its kits to waiting', async () => {
        const user = await makeUser();
        const { order, visit, start } = await paidVisitOrder(user);
        const r = await call(visits.cancelMine, { auth: authFor(user), params: { id: String(visit._id) } });
        expect(r.code).toBe(200);
        const fresh = await Order.findById(order._id);
        expect(fresh.status).not.toBe('cancelled');
        expect(fresh.items[0].components.map((c) => c.status)).toEqual(['placed', 'placed', 'placed']);
        expect((await CollectionSlot.findOne({ start: new Date(start) })).count).toBe(0);
    });

    it('cancelling the order cancels its visit, whatever the cut-off', async () => {
        const user = await makeUser();
        const { order, visit } = await paidVisitOrder(user);
        await call(orders.cancelOrder, { auth: authFor(user), params: { id: String(order._id) } });
        expect((await CollectionVisit.findById(visit._id)).status).toBe('cancelled');
    });

    it('never shows somebody else’s visit', async () => {
        const user = await makeUser();
        const stranger = await makeUser();
        const { visit } = await paidVisitOrder(user);
        expect((await call(visits.getMine, { auth: authFor(stranger), params: { id: String(visit._id) } })).code).toBe(404);
        expect((await call(visits.cancelMine, { auth: authFor(stranger), params: { id: String(visit._id) } })).code).toBe(404);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('at the door', () => {
    const results = (visit, over = {}) => visit.tasks.map((t) => ({
        taskId: String(t._id),
        status: 'done',
        barcode: t.kind === 'collect_blood' ? 'PQB-000123' : t.kind === 'collect_dna' ? 'PQD-000456' : `SN-${String(visit._id).slice(-8)}`,
        ...(over[t.kind] || {}),
    }));

    it('needs every task answered, and a barcode on every collected sample', async () => {
        const user = await makeUser();
        const { visit } = await paidVisitOrder(user);
        const partial = await call(visits.adminComplete, { auth: ADMIN, params: { id: String(visit._id) }, body: { identityConfirmed: true, tasks: results(visit).slice(0, 1) } });
        expect(partial.code).toBe(400);
        const unlabelled = await call(visits.adminComplete, { auth: ADMIN, params: { id: String(visit._id) }, body: { identityConfirmed: true, tasks: results(visit, { collect_blood: { barcode: '' } }) } });
        expect(unlabelled.body.reason).toBe('barcode');
        const twice = await call(visits.adminComplete, { auth: ADMIN, params: { id: String(visit._id) }, body: { identityConfirmed: true, tasks: results(visit, { collect_dna: { barcode: 'PQB-000123' } }) } });
        expect(twice.body.reason).toBe('duplicate');
        expect(await Specimen.countDocuments()).toBe(0);
    });

    it('records the samples, hands over the bracelet, and moves each parcel on', async () => {
        const user = await makeUser();
        const { order, visit } = await paidVisitOrder(user);
        const r = await call(visits.adminComplete, { auth: ADMIN, params: { id: String(visit._id) }, body: { identityConfirmed: true, tasks: results(visit) } });
        expect(r.code).toBe(200);
        expect(r.body.specimens.sort()).toEqual(['PQB-000123', 'PQD-000456']);
        expect(r.body.visit.status).toBe('completed');

        const fresh = await Order.findById(order._id);
        const by = Object.fromEntries(fresh.items[0].components.map((c) => [c.kind, c.status]));
        expect(by).toEqual({ blood: 'collected', dna: 'collected', bracelet: 'delivered' });
        expect(fresh.status).toBe('kit_sent');
        const dna = await Specimen.findOne({ barcode: 'PQD-000456' });
        expect(dna).toMatchObject({ kind: 'dna', lab: 'M42', status: 'collected' });
        expect(String(dna.userId)).toBe(String(user._id));
        expect(await titlesFor(user._id, ['Your samples are on their way to the lab'])).toContain('Your samples are on their way to the lab');
    });

    it('refuses a barcode already on another sample', async () => {
        const a = await makeUser();
        const b = await makeUser();
        const first = await paidVisitOrder(a);
        await call(visits.adminComplete, { auth: ADMIN, params: { id: String(first.visit._id) }, body: { identityConfirmed: true, tasks: results(first.visit) } });
        const second = await paidVisitOrder(b, { slotStart: await slotAfter(60) });
        const r = await call(visits.adminComplete, { auth: ADMIN, params: { id: String(second.visit._id) }, body: { identityConfirmed: true, tasks: results(second.visit) } });
        expect(r.code).toBe(409);
        expect(r.body.message).toMatch(/PQB-000123|already/);
    });

    it('a task not done sends that parcel back to waiting for a visit', async () => {
        const user = await makeUser();
        const { order, visit } = await paidVisitOrder(user);
        await call(visits.adminComplete, {
            auth: ADMIN, params: { id: String(visit._id) },
            body: { identityConfirmed: true, tasks: results(visit, { collect_blood: { status: 'not_done', note: 'Could not find a vein', barcode: undefined } }) },
        });
        const by = Object.fromEntries((await Order.findById(order._id)).items[0].components.map((c) => [c.kind, c.status]));
        expect(by.blood).toBe('placed');
        expect(by.dna).toBe('collected');
    });

    it('a missed visit sends the kits back and asks for a new booking', async () => {
        const user = await makeUser();
        const { order, visit } = await paidVisitOrder(user);
        await call(visits.adminMissed, { auth: ADMIN, params: { id: String(visit._id) } });
        expect((await Order.findById(order._id)).items[0].components.every((c) => c.status === 'placed')).toBe(true);
        const j = deriveJourney({
            user, orders: [(await Order.findById(order._id)).toObject()],
            visits: [(await CollectionVisit.findById(visit._id)).toObject()],
        });
        expect(j.steps.find((s) => s.key === 'package').detail).toMatch(/missed you/);
    });

    it('the per-parcel admin button cannot mark a kit collected', async () => {
        const user = await makeUser();
        const { order } = await paidVisitOrder(user);
        const r = await call(orders.updateComponentStatus, {
            auth: ADMIN, params: { id: String(order._id), itemId: String(order.items[0]._id), kind: 'dna' }, body: { status: 'collected' },
        });
        expect(r.code).toBe(409);
        expect(r.body.message).toMatch(/barcode/);
    });

    it('a lab scan of the barcode moves the kit to the lab, once', async () => {
        const user = await makeUser();
        const { order, visit } = await paidVisitOrder(user);
        await call(visits.adminComplete, { auth: ADMIN, params: { id: String(visit._id) }, body: { identityConfirmed: true, tasks: results(visit) } });
        const r = await call(visits.adminReceive, { auth: ADMIN, body: { barcode: ' pqd-000456 ' } });
        expect(r.code).toBe(200);
        expect(r.body.specimen.status).toBe('received');
        const dna = (await Order.findById(order._id)).items[0].components.find((c) => c.kind === 'dna');
        expect(dna.status).toBe('sample_received');
        expect((await call(visits.adminReceive, { auth: ADMIN, body: { barcode: 'PQD-000456' } })).code).toBe(409);
        expect((await call(visits.adminReceive, { auth: ADMIN, body: { barcode: 'NOPE-999999' } })).code).toBe(404);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('reminders', () => {
    it('reminds once, twelve hours ahead, with the fasting note when a test needs it', async () => {
        const user = await makeUser();
        await Product.create({ name: 'Lipids', sku: `L-${new mongoose.Types.ObjectId()}`, price: 1, includes: ['blood'], requiresFasting: true });
        const p = await Product.findOne({ requiresFasting: true });
        const start = await slotAfter(10);
        const { body } = await call(orders.createOrder, {
            auth: authFor(user), body: { items: [{ productId: String(p._id) }], currency: 'AED', fulfilment: { method: 'home_collection', slotStart: start, ...ADDRESS } },
        });
        await markOrderPaid({ id: 'pi_r', metadata: { orderId: String(body.order._id) } });

        expect((await runCollectionSweep()).reminded).toBe(1);
        expect((await runCollectionSweep()).reminded).toBe(0);
        await titlesFor(user._id, ['Your collection visit is coming up']);
        const card = await Notification.findOne({ userId: user._id, title: 'Your collection visit is coming up' }).lean();
        expect(card.body).toMatch(/fast for 8 hours/);
        expect(card.route).toBe(`/collection/${body.order.fulfilment.visitId}`);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('website checkout with a visit', () => {
    it('takes the address itself, holds the slot for the session, and the visit follows the claim', async () => {
        await Market.create({ code: 'AE', visits: { price: 75 } });
        const p = await pkg();
        mockStripe.checkout.sessions.create.mockResolvedValue({ id: 'cs_test_visit123456', url: 'https://checkout.stripe.com/v' });
        const start = await slotAfter();

        const { code } = await call(checkout.createSession, {
            body: { productId: String(p._id), email: 'buyer@example.ae', currency: 'AED', fulfilment: { method: 'home_collection', slotStart: start, ...ADDRESS } },
        });
        expect(code).toBe(201);
        const args = mockStripe.checkout.sessions.create.mock.calls[0][0];
        expect(args.shipping_address_collection).toBeUndefined();
        expect(args.line_items.map((l) => l.price_data.unit_amount)).toEqual([99900, 7500]);
        expect(args.expires_at - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(30 * 60);

        const order = await Order.findOne({ guestEmail: 'buyer@example.ae' });
        expect(order.total).toBe(1074);
        const visit = await CollectionVisit.findById(order.fulfilment.visitId);
        expect(visit.status).toBe('held');
        expect(visit.userId).toBeUndefined();

        const buyer = await makeUser({ email: 'buyer@example.ae' });
        await claimByEmail(buyer._id, 'buyer@example.ae');
        expect(String((await CollectionVisit.findById(visit._id)).userId)).toBe(String(buyer._id));
    });

    it('refuses a website visit with no time chosen — there is no app yet to book later in', async () => {
        const p = await pkg();
        const r = await call(checkout.createSession, {
            body: { productId: String(p._id), email: 'x@example.ae', currency: 'AED', fulfilment: { method: 'home_collection', ...ADDRESS } },
        });
        expect(r.code).toBe(400);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the portal', () => {
    it('draws a day as its slot grid, with what each slot has taken', async () => {
        const user = await makeUser();
        const { visit } = await paidVisitOrder(user);
        const date = M.localDay(visit.slot.start, 'Asia/Dubai');
        const { body } = await call(visits.adminDay, { auth: ADMIN, query: { market: 'AE', date } });
        expect(body.slots).toHaveLength(48);
        const slot = body.slots.find((s) => s.start === visit.slot.start.toISOString());
        expect(slot).toMatchObject({ capacity: 5, taken: 1 });
        expect(slot.visits[0].customer.email).toBe(user.email);
        expect(body.totals.unassigned).toBe(1);

        const omar = await require('../models/Technician').create({
            name: 'Omar Haddad', email: 'omar@example.ae', market: 'AE',
            shifts: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, startMinute: 0, endMinute: 1440 })),
        });
        const assigned = await call(visits.adminAssign, { auth: ADMIN, params: { id: String(visit._id) }, body: { technicianId: String(omar._id) } });
        expect(assigned.body.visit).toMatchObject({ status: 'assigned', technician: { name: 'Omar Haddad' } });
    });

    it('reads an order with its visit: the booked time, its day, and who is going', async () => {
        const user = await makeUser();
        const { order, visit } = await paidVisitOrder(user);
        const before = await call(orders.getOrderForAdmin, { auth: ADMIN, params: { id: String(order._id) } });
        expect(before.body.visit).toMatchObject({
            _id: String(visit._id),
            status: 'booked',
            day: M.localDay(visit.slot.start, 'Asia/Dubai'),
            label: M.describeSlot(visit.slot.start, visit.slot.end, 'Asia/Dubai'),
            technician: null,
        });

        const nadia = await require('../models/Technician').create({
            name: 'Nadia Saleh', email: 'nadia@example.ae', market: 'AE',
            shifts: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, startMinute: 0, endMinute: 1440 })),
        });
        await call(visits.adminAssign, { auth: ADMIN, params: { id: String(visit._id) }, body: { technicianId: String(nadia._id) } });
        const after = await call(orders.getOrderForAdmin, { auth: ADMIN, params: { id: String(order._id) } });
        expect(after.body.visit).toMatchObject({ status: 'assigned', technician: { name: 'Nadia Saleh' } });
    });

    it('saves a market edit over what is stored, and refuses a broken one', async () => {
        const admin = await makeUser();
        const auth = { userId: String(admin._id), role: 'admin' };
        const ok = await call(visits.updateMarket, { auth, params: { code: 'AE' }, body: { visits: { price: 60 } } });
        expect(ok.code).toBe(200);
        expect(ok.body.market).toMatchObject({ source: 'set', visits: { price: 60, capacityPerSlot: 5, slotMinutes: 30 } });
        const kept = await call(visits.updateMarket, { auth, params: { code: 'AE' }, body: { visits: { capacityPerSlot: 6 } } });
        expect(kept.body.market.visits).toMatchObject({ price: 60, capacityPerSlot: 6 });
        const bad = await call(visits.updateMarket, { auth, params: { code: 'AE' }, body: { visits: { slotMinutes: 11 } } });
        expect(bad.code).toBe(400);
    });

    it('answers the public storefront with options and slots, and nothing internal', async () => {
        const { body } = await call(visits.getSlots, { query: { currency: 'AED' } });
        expect(body.market.options.map((o) => o.method)).toEqual(['home_collection', 'post']);
        expect(body.market).not.toHaveProperty('labs');
        expect(body.days.length).toBe(14);
        expect((await call(visits.getSlots, { query: { currency: 'GBP' } })).code).toBe(404);
    });
});
