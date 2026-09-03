const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const PlanItem = require('../models/PlanItem');
const { advanceRecurringItem } = require('../utils/planGeneratorV2');
const { notifyUser } = require('../jobs/reminderJob');

/**
 * POST /api/orders — place a home-collection order.
 * Prices come from the catalogue, never from the request body: a client-supplied price is
 * a client-controlled price.
 */
exports.createOrder = async (req, res) => {
    try {
        const { items, shippingAddress } = req.body;
        if (!Array.isArray(items) || !items.length) {
            return res.status(400).json({ message: 'items must be a non-empty array' });
        }

        // Validate ids before querying: an unparseable id would otherwise surface as a
        // Mongoose CastError string in the response rather than a clear message
        const productIds = items.map((i) => i.productId);
        const invalid = productIds.filter((id) => !mongoose.isValidObjectId(id));
        if (invalid.length) {
            return res.status(400).json({ message: `Invalid product id: ${invalid[0]}` });
        }

        const products = await Product.find({ _id: { $in: productIds } }).lean();
        const byId = new Map(products.map((p) => [String(p._id), p]));

        const lineItems = [];
        for (const item of items) {
            const product = byId.get(String(item.productId));
            if (!product) {
                return res.status(400).json({ message: `Unknown product: ${item.productId}` });
            }
            const quantity = Math.max(1, parseInt(item.quantity, 10) || 1);
            lineItems.push({
                productId: product._id,
                name: product.name,
                price: product.price,
                quantity,
                planItemId: item.planItemId,
            });
        }

        const subtotal = lineItems.reduce((sum, l) => sum + l.price * l.quantity, 0);

        // With Stripe configured the order waits for payment; without it, orders are
        // placed unpaid so the flow still works in environments with no payment provider.
        const { isConfigured: stripeConfigured } = require('../config/stripe');
        const initialStatus = stripeConfigured() ? 'pending_payment' : 'placed';

        const order = await Order.create({
            userId: req.auth.userId,
            items: lineItems,
            subtotal,
            total: subtotal,
            status: initialStatus,
            statusHistory: [{
                status: initialStatus,
                at: new Date(),
                note: stripeConfigured() ? 'Awaiting payment' : 'Placed without payment',
            }],
            shippingAddress,
        });

        // Mark any plan items this order fulfils, so the timeline reflects it immediately
        // Link the plan items now, but only mark them `ordered` once payment is settled —
        // an unpaid order should not make a screening disappear from the timeline.
        const planItemIds = lineItems.map((l) => l.planItemId).filter(Boolean);
        if (planItemIds.length) {
            await PlanItem.updateMany(
                { _id: { $in: planItemIds }, userId: req.auth.userId },
                {
                    $set: {
                        orderId: order._id,
                        ...(initialStatus === 'placed' ? { status: 'ordered' } : {}),
                    },
                },
                { runValidators: true }
            );
        }

        res.status(201).json({ message: 'Order placed', order });
    } catch (error) {
        console.error('❌ Error creating order:', error);
        res.status(400).json({ message: 'Error creating order', error: error.message });
    }
};

/** GET /api/orders */
exports.getOrders = async (req, res) => {
    try {
        const orders = await Order.find({ userId: req.auth.userId }).sort({ createdAt: -1 }).lean();
        res.json({ orders });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching orders', error: error.message });
    }
};

/** GET /api/orders/:id */
exports.getOrder = async (req, res) => {
    try {
        const order = await Order.findOne({ _id: req.params.id, userId: req.auth.userId });
        if (!order) return res.status(404).json({ message: 'Order not found' });
        res.json({ order });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching order', error: error.message });
    }
};

/** POST /api/orders/:id/cancel — users may cancel only before dispatch. */
exports.cancelOrder = async (req, res) => {
    try {
        const order = await Order.findOne({ _id: req.params.id, userId: req.auth.userId });
        if (!order) return res.status(404).json({ message: 'Order not found' });

        if (!['pending_payment', 'placed'].includes(order.status)) {
            return res.status(409).json({
                message: `An order that is already ${order.status} cannot be cancelled here`,
            });
        }

        order.transitionTo('cancelled', req.body.reason);
        await order.save();
        res.json({ message: 'Order cancelled', order });
    } catch (error) {
        res.status(500).json({ message: 'Error cancelling order', error: error.message });
    }
};

/**
 * GET /api/orders/admin/all — every order, for the staff portal (admin only).
 *
 * Separate from `getOrders` rather than a `?scope=all` flag on it, because the two differ
 * in what they are allowed to return, not merely in breadth: this one crosses the
 * user boundary, and a flag that widens a self-scoped endpoint is one refactor away from
 * being reachable without the role check.
 *
 * Projected to what a fulfilment queue displays. Line items are summarised rather than
 * embedded whole — the list needs "2 items", the detail view fetches the rest.
 *
 * Query: ?status= &search= (order id or customer email) &page= &limit=
 */
exports.listAllOrders = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));

        const filter = {};

        const status = (req.query.status || '').trim();
        if (status && status !== 'all') {
            const allowed = Order.schema.path('status').enumValues;
            if (!allowed.includes(status)) {
                return res.status(400).json({
                    message: `Unknown status "${status}". Expected one of: ${allowed.join(', ')}`,
                });
            }
            filter.status = status;
        }

        // An order id is the thing support is handed most often; an email is what the
        // customer gives on the phone. Accept either.
        const search = (req.query.search || '').trim();
        if (search) {
            if (mongoose.isValidObjectId(search)) {
                filter._id = search;
            } else {
                const User = require('../models/userModel');
                const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const matches = await User.find({ email: new RegExp(safe, 'i') })
                    .select('_id')
                    .limit(50)
                    .lean();
                // No match must return nothing, not everything: an unmatched filter that
                // silently drops itself would show the whole book of orders as if it were
                // the search result.
                filter.userId = { $in: matches.map((m) => m._id) };
            }
        }

        const [orders, total] = await Promise.all([
            Order.find(filter)
                .sort({ createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .populate('userId', 'firstName lastName email')
                .lean(),
            Order.countDocuments(filter),
        ]);

        res.json({
            items: orders.map((o) => ({
                _id: o._id,
                status: o.status,
                total: o.total,
                currency: o.currency,
                itemCount: (o.items || []).reduce((n, i) => n + (i.quantity || 1), 0),
                // A summary line, so the list is readable without opening every order.
                summary: (o.items || []).map((i) => i.name).join(', '),
                paymentStatus: o.payment?.status || 'unpaid',
                trackingReference: o.trackingReference || null,
                createdAt: o.createdAt,
                customer: o.userId
                    ? {
                        _id: o.userId._id,
                        name: [o.userId.firstName, o.userId.lastName].filter(Boolean).join(' '),
                        email: o.userId.email,
                    }
                    // A deleted account leaves its orders behind — the row must still render.
                    : null,
            })),
            page,
            limit,
            total,
            pages: Math.max(1, Math.ceil(total / limit)),
            hasMore: page * limit < total,
        });
    } catch (error) {
        console.error('❌ listAllOrders failed:', error);
        res.status(500).json({ message: 'Error fetching orders', error: error.message });
    }
};

/**
 * GET /api/orders/admin/stats — counts by status, for the portal overview (admin only).
 *
 * One aggregation rather than the portal asking for each status in turn: eight round trips
 * to render one card is how an overview screen becomes the slowest page in the product.
 * Every status in the enum is returned, including the zeroes — a fulfilment board that
 * hides "kit sent" because it happens to be empty is one an operator cannot trust as a
 * complete picture.
 */
exports.getOrderStats = async (req, res) => {
    try {
        const rows = await Order.aggregate([
            { $group: { _id: '$status', count: { $sum: 1 }, value: { $sum: '$total' } } },
        ]);

        const counts = {};
        for (const status of Order.schema.path('status').enumValues) counts[status] = 0;
        let total = 0;
        for (const row of rows) {
            if (row._id in counts) counts[row._id] = row.count;
            total += row.count;
        }

        /**
         * What an operator has to act on today. Deliberately excludes `pending_payment`:
         * that waits on the customer, not on staff, and mixing the two produces a number
         * nobody can clear to zero.
         */
        const actionable = counts.placed + counts.kit_sent + counts.sample_received + counts.processing;

        res.json({ counts, total, actionable });
    } catch (error) {
        console.error('❌ getOrderStats failed:', error);
        res.status(500).json({ message: 'Error computing order stats', error: error.message });
    }
};

/** GET /api/orders/admin/:id — one order in full, for the portal (admin only). */
exports.getOrderForAdmin = async (req, res) => {
    try {
        const order = await Order.findById(req.params.id)
            .populate('userId', 'firstName lastName email')
            .lean();
        if (!order) return res.status(404).json({ message: 'Order not found' });
        res.json({ order });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching order', error: error.message });
    }
};

/**
 * Which fulfilment moves are legal.
 *
 * Two things this prevents, both of which `transitionTo` would otherwise wave through.
 *
 * A status outside the enum reached `save()` and came back as a Mongoose validation string
 * — accurate, but it reads as a server fault rather than a typo in a request.
 *
 * More seriously, nothing stopped a **terminal** order moving back into fulfilment. Setting
 * a cancelled order to `resulted` re-runs the side effects at the bottom of this handler:
 * it completes the linked plan items, advances recurring surveillance, and pushes "your
 * results are ready" to someone whose order was cancelled. Those effects are not
 * idempotent and not reversible from here.
 */
const LEGAL_TRANSITIONS = {
    pending_payment: ['placed', 'cancelled'],
    placed: ['kit_sent', 'cancelled', 'refunded'],
    kit_sent: ['sample_received', 'cancelled', 'refunded'],
    sample_received: ['processing', 'refunded'],
    processing: ['resulted', 'refunded'],
    // Terminal. `resulted` may still be refunded — a result does not settle a billing
    // dispute — but it never returns to the fulfilment path.
    resulted: ['refunded'],
    cancelled: ['refunded'],
    refunded: [],
};

/**
 * PATCH /api/orders/:id/status — fulfilment transitions (admin only).
 * Reaching `resulted` closes the loop: the linked plan item is completed.
 */
exports.updateOrderStatus = async (req, res) => {
    try {
        const { status, note, testResultId, dnaReportId } = req.body;
        const order = await Order.findById(req.params.id);
        if (!order) return res.status(404).json({ message: 'Order not found' });

        const allowed = Order.schema.path('status').enumValues;
        if (!status || !allowed.includes(status)) {
            return res.status(400).json({
                message: `Unknown status "${status}". Expected one of: ${allowed.join(', ')}`,
            });
        }

        if (status === order.status) {
            return res.status(409).json({ message: `This order is already ${status}` });
        }

        const legal = LEGAL_TRANSITIONS[order.status] || [];
        if (!legal.includes(status)) {
            return res.status(409).json({
                message: legal.length
                    ? `An order that is ${order.status} can only move to: ${legal.join(', ')}`
                    : `An order that is ${order.status} is final and cannot change status`,
            });
        }

        order.transitionTo(status, note);
        if (testResultId) order.testResultId = testResultId;
        if (dnaReportId) order.dnaReportId = dnaReportId;
        await order.save();

        // Tell the person their kit moved. Fire-and-forget: a push failure must not fail
        // the fulfilment transition itself.
        const ANNOUNCE = {
            kit_sent: { title: 'Your kit is on its way', body: 'Your collection kit has been dispatched.', key: 'orderUpdates' },
            sample_received: { title: 'Sample received', body: 'The laboratory has your sample and is processing it.', key: 'orderUpdates' },
            resulted: { title: 'Your results are ready', body: 'Your new results are in your record. Tap to see them.', key: 'resultsReady' },
        };
        const announcement = ANNOUNCE[status];
        if (announcement) {
            notifyUser(order.userId, {
                title: announcement.title,
                body: announcement.body,
                data: { type: 'order', orderId: String(order._id), route: '/order-details' },
                preferenceKey: announcement.key,
            }).catch((e) => console.warn('⚠️ Order notification failed:', e.message));
        }

        if (status === 'resulted') {
            const planItemIds = order.items.map((i) => i.planItemId).filter(Boolean);
            if (planItemIds.length) {
                await PlanItem.updateMany(
                    { _id: { $in: planItemIds } },
                    { $set: { status: 'completed', completedAt: new Date(), resultingTestResultId: testResultId } },
                    { runValidators: true }
                );

                // Keep recurring surveillance rolling forward
                const completed = await PlanItem.find({ _id: { $in: planItemIds } });
                for (const item of completed) await advanceRecurringItem(item);
            }
        }

        res.json({ message: `Order marked ${status}`, order });
    } catch (error) {
        res.status(400).json({ message: 'Error updating order', error: error.message });
    }
};
