const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const PlanItem = require('../models/PlanItem');
const { advanceRecurringItem } = require('../utils/planGeneratorV2');
const { publish } = require('../utils/notificationCentre');
const C = require('../utils/orderComponents');
const ExchangeRates = require('../models/ExchangeRates');
const { BASE, normaliseCurrency, priceFor } = require('../utils/currency');
const Market = require('../models/Market');
const { marketCodeForCurrency, localDay } = require('../utils/markets');
const CollectionVisit = require('../models/CollectionVisit');
const collection = require('../utils/collectionCentre');

/**
 * POST /api/orders { items, currency? } — place a home-collection order.
 * Prices come from the catalogue, never from the request body: a client-supplied price is
 * a client-controlled price. The client chooses only the *currency*, and every line is
 * priced in it by `utils/currency.priceFor`. No currency means GBP, which is what every
 * client sent before there was a choice.
 */
exports.createOrder = async (req, res) => {
    try {
        const { items, shippingAddress } = req.body;
        if (!Array.isArray(items) || !items.length) {
            return res.status(400).json({ message: 'items must be a non-empty array' });
        }

        const sentCurrency = req.body.currency;
        const orderCurrency = sentCurrency === undefined || sentCurrency === null || sentCurrency === ''
            ? BASE
            : normaliseCurrency(sentCurrency);
        // Refused rather than defaulted: charging GBP to somebody who chose AED is the one
        // outcome worse than an error.
        if (!orderCurrency) {
            return res.status(400).json({ message: `We do not sell in ${String(sentCurrency).slice(0, 8)}.` });
        }

        // Validate ids before querying: an unparseable id would otherwise surface as a
        // Mongoose CastError string in the response rather than a clear message
        const productIds = items.map((i) => i.productId);
        const invalid = productIds.filter((id) => !mongoose.isValidObjectId(id));
        if (invalid.length) {
            return res.status(400).json({ message: `Invalid product id: ${invalid[0]}` });
        }

        const [products, { rates }, market] = await Promise.all([
            Product.find({ _id: { $in: productIds } }).lean(),
            ExchangeRates.current(),
            Market.resolve(marketCodeForCurrency(orderCurrency)),
        ]);

        // How the order reaches the lab. The market decides what is on offer; the customer
        // chooses within it; nothing chosen means the market's default. A request for a
        // method the market does not offer is refused, never quietly swapped.
        const f = req.body.fulfilment || {};
        // No choice sent means post where post is offered: every client that predates the
        // choice — the website before it, and app builds an update cannot reach — knows only
        // post and sends nothing. The market's default decides what the new screens preselect.
        const method = f.method || (market.fulfilment.post ? 'post' : market.fulfilment.default);
        const offered = method === 'post' ? market.fulfilment.post : method === 'home_collection' && market.fulfilment.homeCollection;
        if (!offered) {
            return res.status(400).json({ message: `${method === 'home_collection' ? 'Home collection' : 'Delivery by post'} is not available in ${market.name}.` });
        }
        let visitDetails = null;
        if (method === 'home_collection' && f.slotStart) {
            const details = collection.cleanVisitDetails(f, market);
            if (!details.ok) return res.status(400).json({ message: details.errors[0], errors: details.errors });
            visitDetails = details.value;
        }
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
                price: priceFor(product, orderCurrency, rates).amount,
                quantity,
                planItemId: item.planItemId,
                // What this line ships, each on its own timeline. Empty for a product that
                // predates `includes`, whose order moves on the order-level status as before.
                components: C.componentsFor(product, new Date(), method),
            });
        }

        // A visit with nothing to collect is a wasted trip: only products that ship a kit or
        // a bracelet (`Product.includes`) can go by home collection.
        if (method === 'home_collection' && !lineItems.some((l) => (l.components || []).length)) {
            return res.status(400).json({ message: 'Nothing in this order can be collected at home. Choose delivery by post.' });
        }

        // Rounded to the minor unit: 3 × 19.99 is 59.97000000000001 in floating point.
        const subtotal = Math.round(lineItems.reduce((sum, l) => sum + l.price * l.quantity, 0) * 100) / 100;
        // The visit's price is the market's, in the market's currency — which is the order's.
        const fee = method === 'home_collection' ? market.visits.price : 0;
        const total = Math.round((subtotal + fee) * 100) / 100;

        // With Stripe configured the order waits for payment; without it, orders are
        // placed unpaid so the flow still works in environments with no payment provider.
        const { isConfigured: stripeConfigured } = require('../config/stripe');
        const initialStatus = stripeConfigured() ? 'pending_payment' : 'placed';

        const order = await Order.create({
            userId: req.auth.userId,
            source: 'app',
            items: lineItems,
            currency: orderCurrency,
            fulfilment: { method, market: market.code, fee },
            subtotal,
            total,
            status: initialStatus,
            statusHistory: [{
                status: initialStatus,
                at: new Date(),
                note: stripeConfigured() ? 'Awaiting payment' : 'Placed without payment',
            }],
            // For a visit, the address the technician goes to is the delivery address.
            shippingAddress: visitDetails
                ? {
                    line1: visitDetails.address.building,
                    line2: [visitDetails.address.street, visitDetails.address.area].filter(Boolean).join(', '),
                    city: visitDetails.address.city,
                    country: visitDetails.address.country,
                }
                : shippingAddress,
        });

        // Hold the visit while the customer pays. If the slot went in the seconds since they
        // chose it, the order is withdrawn and they are asked to choose again — an unpaid
        // order with no visit would be one more thing to clean up.
        if (visitDetails) {
            const held = await collection.holdForOrder({ order, market, start: f.slotStart, details: visitDetails });
            if (!held.ok) {
                await Order.deleteOne({ _id: order._id });
                return res.status(held.status).json({ message: held.message, reason: held.reason });
            }
            order.fulfilment.visitId = held.visit._id;
            // No payment provider: the order is placed now, so the visit is booked now.
            if (initialStatus === 'placed') await collection.confirmForOrder(order._id);
        }

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
        await collection.cancelForOrder(order._id, 'customer');
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
                // A website purchase nobody has claimed yet has no user to match, only the
                // email it was bought with — and that is exactly the one support is asked about.
                filter.$or = [
                    { userId: { $in: matches.map((m) => m._id) } },
                    { guestEmail: new RegExp(safe, 'i') },
                ];
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
                source: o.source || 'app',
                guestEmail: o.userId ? null : o.guestEmail || null,
                components: (o.items || []).flatMap((i) => (i.components || []).map((c) => ({ kind: c.kind, status: c.status }))),
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
        // The visit carries the booked time; without it the order page can say a visit is
        // booked but not when, or whether anybody is going.
        let visit = null;
        if (order.fulfilment?.visitId) {
            const v = await CollectionVisit.findById(order.fulfilment.visitId).populate('technicianId', 'name').lean();
            if (v) {
                visit = {
                    ...collection.visitView(v),
                    day: localDay(new Date(v.slot.start), v.timezone),
                    technician: v.technicianId?.name ? { _id: String(v.technicianId._id), name: v.technicianId.name } : null,
                };
            }
        }
        res.json({ order, visit });
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

        // A package moves one parcel at a time. Marking the whole order `kit_sent` would say
        // the DNA kit left when only the bracelet did. Cancelling or refunding is still a
        // decision about the whole order, and stays here.
        const tracked = order.items.some((i) => (i.components || []).length);
        if (tracked && !['cancelled', 'refunded', 'placed'].includes(status)) {
            return res.status(409).json({
                message: 'This order ships several items. Update each one from its own row.',
            });
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
        if (['cancelled', 'refunded'].includes(status)) await collection.cancelForOrder(order._id, 'admin');
        if (testResultId) order.testResultId = testResultId;
        if (dnaReportId) order.dnaReportId = dnaReportId;
        await order.save();

        // Tell the person their kit moved — a card in the centre, and a push unless they
        // turned order updates off. Never awaited: a notification must not fail fulfilment.
        announce(order, null, status);

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

/**
 * The words for each move, per thing that moved. `null` kind is a whole order with no
 * components — the shape every order had before packages.
 */
const WORDING = {
    kit_sent: (label) => ({ title: `Your ${label} kit is on its way`, body: 'It has been dispatched. Follow the instructions in the box when it arrives.' }),
    sample_received: (label) => ({ title: 'Sample received', body: `The laboratory has your ${label} sample and will start on it shortly.` }),
    processing: (label) => ({ title: `Your ${label} sample is being analysed`, body: 'We will let you know the moment your results are in.' }),
    resulted: (label) => ({
        title: `Your ${label} results are in`,
        body: label === 'test'
            ? 'They are in your record. Tap to see them.'
            : 'They are in your record. We are updating your analysis with them now.',
    }),
    dispatched: () => ({ title: 'Your bracelet is on its way', body: 'Pair it from the app when it arrives — it takes about a minute.' }),
    delivered: () => ({ title: 'Your bracelet has arrived', body: 'Pair it now and it starts learning your sleep and heart rate tonight.' }),
};

const LABEL = { blood: 'blood test', dna: 'DNA', bracelet: 'bracelet', null: 'test' };

/** Where a card about each move opens. A bracelet that has arrived opens the pairing screen. */
const ROUTE = { delivered: '/bracelet', resulted: '/results' };

const announce = (order, component, status) => {
    if (!order.userId) return; // a website order nobody has claimed yet has nobody to tell
    const words = WORDING[status]?.(LABEL[component?.kind ?? null]);
    if (!words) return;
    publish(String(order.userId), {
        category: status === 'resulted' ? 'results' : 'order',
        title: words.title,
        body: words.body,
        route: ROUTE[status] || `/order-details?orderId=${order._id}`,
        data: { type: 'order', orderId: String(order._id) },
        // One card per parcel per stage, however many times fulfilment re-sends it.
        dedupeKey: `order:${order._id}:${component?._id || 'all'}:${status}`,
        source: 'orders',
    });
};

/** Which result id a kit must be resulted with, and the collection it must belong to. */
const RESULT_REFS = {
    blood: [{ field: 'testResultId', model: () => require('../models/testResultModel'), owner: 'patient.user_id' }],
    dna: [
        { field: 'dnaReportId', model: () => require('../models/DnaReport'), owner: 'userId' },
        { field: 'genotypeFileId', model: () => require('../models/GenotypeFile'), owner: 'userId' },
    ],
};

/**
 * A kit came back: re-read everything with the new result in it, then say so.
 *
 * Not awaited by the request. The model call takes seconds, and the regeneration guard may
 * refuse it (too soon after the last one) — in which case the person still has the "results
 * are in" card and can ask for the analysis themselves, which is what they could always do.
 * The "full analysis" card is only published when a new analysis was actually written.
 */
const reinterpret = (order, component) => {
    const { requestGeneration } = require('./interpretationController');
    requestGeneration({
        userId: order.userId,
        dnaReportId: component.dnaReportId || component.genotypeFileId || undefined,
        testResultId: component.testResultId || undefined,
    }).then((outcome) => {
        if (outcome?.status !== 201) {
            console.log(`ℹ️ No new analysis after ${component.kind} result (${outcome?.status}): ${outcome?.body?.message || ''}`);
            return;
        }
        publish(String(order.userId), {
            category: 'insight',
            title: component.kind === 'dna'
                ? 'Your full analysis is ready'
                : 'Your analysis has been updated',
            body: component.kind === 'dna'
                ? 'Your DNA is now part of the picture. See what changed in your plan.'
                : 'Your new blood results are now part of it. See what changed.',
            route: '/journey/update',
            dedupeKey: `analysis:${order._id}:${component._id}`,
            source: 'orders',
        });
    }).catch((e) => console.error('❌ Re-analysis after result failed:', e.message));
};

/**
 * PATCH /api/orders/:id/items/:itemId/components/:kind — move one parcel on (admin only).
 *
 * Body: { status, note?, trackingReference?, testResultId? | dnaReportId? | genotypeFileId? }
 *
 * One stage at a time, forwards only — the same rule the order-level table enforces, for
 * the same reason: `resulted` has side effects that cannot be run twice. The order's own
 * status is then re-derived from all of its components.
 */
exports.updateComponentStatus = async (req, res) => {
    try {
        const { status, note, trackingReference } = req.body;
        const order = await Order.findById(req.params.id);
        if (!order) return res.status(404).json({ message: 'Order not found' });

        if (['pending_payment', 'cancelled', 'refunded'].includes(order.status)) {
            return res.status(409).json({ message: `An order that is ${order.status} cannot be fulfilled` });
        }

        const item = order.items.id(req.params.itemId);
        const component = item?.components?.find((c) => c.kind === req.params.kind);
        if (!component) return res.status(404).json({ message: 'That item does not ship one of those' });

        const expected = C.nextStage(component);
        // Booking and collecting belong to the visit, which records the slot and the barcode.
        // Marking a kit collected here would be a tube with no label and no visit behind it.
        if (C.VISIT_OWNED.includes(expected)) {
            return res.status(409).json({
                message: expected === 'visit_booked'
                    ? 'This kit is waiting for its collection visit to be booked.'
                    : 'Record this collection on the visit, with the barcode on the tube.',
                expected,
            });
        }
        if (status !== expected) {
            return res.status(409).json({
                message: expected
                    ? `This ${LABEL[component.kind]} is ${C.labelFor(component).toLowerCase()} — the next step is "${C.labelFor(component, expected)}".`
                    : `This ${LABEL[component.kind]} is finished and cannot change.`,
                expected,
            });
        }

        if (status === 'resulted') {
            if (!order.userId) {
                return res.status(409).json({
                    message: 'Nobody has claimed this order in the app yet, so there is no record to attach a result to.',
                });
            }
            const refs = RESULT_REFS[component.kind] || [];
            const given = refs.filter((r) => req.body[r.field]);
            if (given.length !== 1) {
                return res.status(400).json({
                    message: `Attach the result: one of ${refs.map((r) => r.field).join(' or ')}.`,
                });
            }
            const ref = given[0];
            const exists = await ref.model().exists({ _id: req.body[ref.field], [ref.owner]: order.userId });
            if (!exists) {
                return res.status(400).json({ message: 'That result does not belong to this customer.' });
            }
            component[ref.field] = req.body[ref.field];
        }

        component.status = status;
        component.statusHistory.push({ status, at: new Date(), note });
        if (trackingReference) component.trackingReference = String(trackingReference).slice(0, 80);

        const rolled = C.rollupStatus(order.items.flatMap((i) => i.components || []));
        const finished = rolled === 'resulted' && order.status !== 'resulted';
        if (rolled && rolled !== order.status) order.transitionTo(rolled, `Rolled up from ${component.kind}`);
        await order.save();

        announce(order, component, status);
        if (status === 'resulted') reinterpret(order, component);

        // The whole order has come back: close the plan items it was bought for, as the
        // order-level path does.
        if (finished) {
            const planItemIds = order.items.map((i) => i.planItemId).filter(Boolean);
            if (planItemIds.length) {
                await PlanItem.updateMany(
                    { _id: { $in: planItemIds } },
                    { $set: { status: 'completed', completedAt: new Date() } },
                    { runValidators: true }
                );
                const completed = await PlanItem.find({ _id: { $in: planItemIds } });
                for (const done of completed) await advanceRecurringItem(done);
            }
        }

        res.json({ message: `${C.KIND_META[component.kind].label}: ${C.labelFor(component, status)}`, order });
    } catch (error) {
        console.error('❌ Component update failed:', error);
        res.status(400).json({ message: 'Error updating order', error: error.message });
    }
};

exports._internal = { LEGAL_TRANSITIONS, announce };
