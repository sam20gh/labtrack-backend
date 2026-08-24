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
 * PATCH /api/orders/:id/status — fulfilment transitions (admin only).
 * Reaching `resulted` closes the loop: the linked plan item is completed.
 */
exports.updateOrderStatus = async (req, res) => {
    try {
        const { status, note, testResultId, dnaReportId } = req.body;
        const order = await Order.findById(req.params.id);
        if (!order) return res.status(404).json({ message: 'Order not found' });

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
