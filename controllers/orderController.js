const Order = require('../models/Order');
const Product = require('../models/Product');
const PlanItem = require('../models/PlanItem');
const { advanceRecurringItem } = require('../utils/planGeneratorV2');

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

        const productIds = items.map((i) => i.productId);
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

        const order = await Order.create({
            userId: req.auth.userId,
            items: lineItems,
            subtotal,
            total: subtotal,
            status: 'placed',
            statusHistory: [{ status: 'placed', at: new Date() }],
            shippingAddress,
        });

        // Mark any plan items this order fulfils, so the timeline reflects it immediately
        const planItemIds = lineItems.map((l) => l.planItemId).filter(Boolean);
        if (planItemIds.length) {
            await PlanItem.updateMany(
                { _id: { $in: planItemIds }, userId: req.auth.userId },
                { $set: { status: 'ordered', orderId: order._id } },
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
