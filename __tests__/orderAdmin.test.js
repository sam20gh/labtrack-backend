/**
 * Admin order fulfilment, for the staff portal.
 *
 * Two things are asserted here, and the second is the one that matters.
 *
 * The list crosses the user boundary, so it must be reachable only through its own
 * admin-gated handler and must not leak a customer's medical record into a fulfilment
 * queue.
 *
 * The transition guard stops a terminal order re-entering fulfilment. Without it, marking a
 * cancelled order `resulted` re-runs this handler's side effects — completing the linked
 * plan items, advancing recurring surveillance, and pushing "your results are ready" to
 * someone whose order was cancelled. None of that is idempotent, and none of it can be
 * undone from the portal.
 */
const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/userModel');
const PlanItem = require('../models/PlanItem');
const {
    listAllOrders,
    updateOrderStatus,
    getOrderStats,
} = require('../controllers/orderController');

const mockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
};

const customer = async (suffix) => User.create({
    username: `c${suffix}`,
    email: `c${suffix}@example.com`,
    password: 'x',
    firstName: 'Cust',
    lastName: String(suffix),
    healthAssessment: {
        // The thing an order list must never carry back to a browser.
        conditions: [{ name: 'Hypertension', severity: 'moderate' }],
    },
});

const orderFor = async (userId, status = 'placed') => Order.create({
    userId,
    items: [{ productId: new mongoose.Types.ObjectId(), name: 'Lipid Panel', price: 49, quantity: 1 }],
    subtotal: 49,
    total: 49,
    status,
    statusHistory: [{ status, at: new Date() }],
});

describe('listAllOrders', () => {
    it('returns orders across every customer, newest first', async () => {
        const a = await customer(1);
        const b = await customer(2);
        await orderFor(a._id);
        await orderFor(b._id);

        const res = mockRes();
        await listAllOrders({ query: {} }, res);

        const payload = res.json.mock.calls[0][0];
        expect(payload.total).toBe(2);
        expect(payload.items).toHaveLength(2);
        expect(payload.items.map((o) => o.customer.email).sort())
            .toEqual(['c1@example.com', 'c2@example.com']);
    });

    it('carries no health assessment into the fulfilment queue', async () => {
        const a = await customer(3);
        await orderFor(a._id);

        const res = mockRes();
        await listAllOrders({ query: {} }, res);

        const serialised = JSON.stringify(res.json.mock.calls[0][0]);
        expect(serialised).not.toContain('Hypertension');
        expect(serialised).not.toContain('healthAssessment');
    });

    it('filters by status', async () => {
        const a = await customer(4);
        await orderFor(a._id, 'placed');
        await orderFor(a._id, 'kit_sent');

        const res = mockRes();
        await listAllOrders({ query: { status: 'kit_sent' } }, res);

        const payload = res.json.mock.calls[0][0];
        expect(payload.total).toBe(1);
        expect(payload.items[0].status).toBe('kit_sent');
    });

    it('rejects a status outside the enum rather than ignoring it', async () => {
        const res = mockRes();
        await listAllOrders({ query: { status: 'lost_in_post' } }, res);

        expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns nothing when an email search matches nobody', async () => {
        const a = await customer(5);
        await orderFor(a._id);

        const res = mockRes();
        await listAllOrders({ query: { search: 'nobody@example.com' } }, res);

        // The failure this guards: an unmatched filter dropping itself and showing
        // every order as though it were the search result.
        expect(res.json.mock.calls[0][0].total).toBe(0);
    });

    it('finds a customer’s orders by email', async () => {
        const a = await customer(6);
        await orderFor(a._id);

        const res = mockRes();
        await listAllOrders({ query: { search: 'c6@example.com' } }, res);

        expect(res.json.mock.calls[0][0].total).toBe(1);
    });
});

describe('getOrderStats', () => {
    it('returns every status in the enum, zeroes included', async () => {
        const a = await customer(20);
        await orderFor(a._id, 'placed');

        const res = mockRes();
        await getOrderStats({}, res);

        const { counts } = res.json.mock.calls[0][0];
        // A board that hides an empty column makes "nothing here" indistinguishable from
        // "this failed to load".
        for (const status of Order.schema.path('status').enumValues) {
            expect(counts).toHaveProperty(status);
        }
        expect(counts.placed).toBe(1);
        expect(counts.resulted).toBe(0);
    });

    it('counts what is waiting on staff, excluding payment', async () => {
        const a = await customer(21);
        await orderFor(a._id, 'placed');
        await orderFor(a._id, 'processing');
        await orderFor(a._id, 'pending_payment');
        await orderFor(a._id, 'resulted');

        const res = mockRes();
        await getOrderStats({}, res);

        const payload = res.json.mock.calls[0][0];
        expect(payload.total).toBe(4);
        // pending_payment waits on the customer; resulted is done. Neither is staff work.
        expect(payload.actionable).toBe(2);
    });

    it('reports zero across the board when nothing has been ordered', async () => {
        const res = mockRes();
        await getOrderStats({}, res);

        const payload = res.json.mock.calls[0][0];
        expect(payload.total).toBe(0);
        expect(payload.actionable).toBe(0);
    });
});

describe('updateOrderStatus', () => {
    it('advances along the fulfilment path', async () => {
        const a = await customer(7);
        const order = await orderFor(a._id, 'placed');

        const res = mockRes();
        await updateOrderStatus({ params: { id: order._id }, body: { status: 'kit_sent' } }, res);

        const saved = await Order.findById(order._id);
        expect(saved.status).toBe('kit_sent');
        expect(saved.statusHistory.at(-1).status).toBe('kit_sent');
    });

    it('refuses to move a cancelled order back into fulfilment', async () => {
        const a = await customer(8);
        const order = await orderFor(a._id, 'cancelled');

        const res = mockRes();
        await updateOrderStatus({ params: { id: order._id }, body: { status: 'resulted' } }, res);

        expect(res.status).toHaveBeenCalledWith(409);
        expect(await Order.findById(order._id)).toHaveProperty('status', 'cancelled');
    });

    it('does not complete plan items when a terminal order is pushed to resulted', async () => {
        const a = await customer(9);
        const planItem = await PlanItem.create({
            userId: a._id,
            type: 'test',
            title: 'Lipid Panel',
            status: 'due',
            dueDate: new Date('2026-10-01'),
        });
        const order = await Order.create({
            userId: a._id,
            items: [{
                productId: new mongoose.Types.ObjectId(),
                name: 'Lipid Panel',
                price: 49,
                quantity: 1,
                planItemId: planItem._id,
            }],
            subtotal: 49,
            total: 49,
            status: 'cancelled',
            statusHistory: [{ status: 'cancelled', at: new Date() }],
        });

        await updateOrderStatus({ params: { id: order._id }, body: { status: 'resulted' } }, mockRes());

        // The side effect the guard exists to prevent.
        expect(await PlanItem.findById(planItem._id)).toHaveProperty('status', 'due');
    });

    it('rejects a status outside the enum', async () => {
        const a = await customer(10);
        const order = await orderFor(a._id, 'placed');

        const res = mockRes();
        await updateOrderStatus({ params: { id: order._id }, body: { status: 'posted' } }, res);

        expect(res.status).toHaveBeenCalledWith(400);
    });

    it('rejects a no-op transition', async () => {
        const a = await customer(11);
        const order = await orderFor(a._id, 'placed');

        const res = mockRes();
        await updateOrderStatus({ params: { id: order._id }, body: { status: 'placed' } }, res);

        expect(res.status).toHaveBeenCalledWith(409);
    });

    it('still allows a refund from a resulted order', async () => {
        const a = await customer(12);
        const order = await orderFor(a._id, 'resulted');

        const res = mockRes();
        await updateOrderStatus({ params: { id: order._id }, body: { status: 'refunded' } }, res);

        expect(await Order.findById(order._id)).toHaveProperty('status', 'refunded');
    });
});
