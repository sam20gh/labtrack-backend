const Order = require('../models/Order');
const PlanItem = require('../models/PlanItem');
const User = require('../models/userModel');
const { getStripe, isConfigured, isTestMode, toMinorUnits, CURRENCY, WEBHOOK_SECRETS } = require('../config/stripe');

/** GET /api/payments/status — lets the client decide whether to show a payment step. */
exports.getPaymentStatus = async (req, res) => {
    res.json({
        available: isConfigured(),
        testMode: isTestMode(),
        currency: CURRENCY,
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
    });
};

/**
 * POST /api/payments/orders/:orderId/intent
 *
 * Creates (or reuses) a PaymentIntent for an order and returns everything the mobile
 * PaymentSheet needs.
 *
 * The amount comes from the stored order, never from the request — the whole point of
 * pricing server-side at order creation is undone if the payment step trusts a client
 * figure.
 */
exports.createPaymentIntent = async (req, res) => {
    try {
        if (!isConfigured()) {
            return res.status(503).json({ message: 'Payment is not available on this server' });
        }

        const order = await Order.findOne({ _id: req.params.orderId, userId: req.auth.userId });
        if (!order) return res.status(404).json({ message: 'Order not found' });

        if (order.payment?.status === 'paid') {
            return res.status(409).json({ message: 'This order has already been paid' });
        }
        if (['cancelled', 'refunded'].includes(order.status)) {
            return res.status(409).json({ message: `A ${order.status} order cannot be paid` });
        }

        const stripe = getStripe();
        const user = await User.findById(req.auth.userId).select('email firstName lastName stripeCustomerId');

        // One Stripe customer per user, so saved cards and receipts stay together
        let customerId = user.stripeCustomerId;
        if (!customerId) {
            const customer = await stripe.customers.create({
                email: user.email,
                name: [user.firstName, user.lastName].filter(Boolean).join(' ') || undefined,
                metadata: { labtrackUserId: String(user._id) },
            });
            customerId = customer.id;
            await User.findByIdAndUpdate(user._id, { $set: { stripeCustomerId: customerId } });
        }

        // Reuse an existing intent rather than stacking new ones on retries
        let intent;
        if (order.payment?.reference) {
            try {
                const existing = await stripe.paymentIntents.retrieve(order.payment.reference);
                if (['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(existing.status)) {
                    intent = existing;
                }
            } catch {
                // Intent no longer retrievable — fall through and create a fresh one
            }
        }

        if (!intent) {
            intent = await stripe.paymentIntents.create({
                amount: toMinorUnits(order.total),
                currency: CURRENCY,
                customer: customerId,
                automatic_payment_methods: { enabled: true },
                // The webhook is the source of truth, and it only receives metadata
                metadata: { orderId: String(order._id), labtrackUserId: String(user._id) },
                description: `LabTrack order ${order._id}`,
            });

            await Order.findByIdAndUpdate(order._id, {
                $set: { 'payment.provider': 'stripe', 'payment.reference': intent.id, 'payment.status': 'unpaid' },
            }, { runValidators: true });
        }

        // Short-lived key that lets the mobile SDK talk to Stripe as this customer
        const ephemeralKey = await stripe.ephemeralKeys.create(
            { customer: customerId },
            { apiVersion: '2024-06-20' }
        );

        res.json({
            clientSecret: intent.client_secret,
            ephemeralKey: ephemeralKey.secret,
            customerId,
            publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
            amount: order.total,
            currency: CURRENCY,
            testMode: isTestMode(),
        });
    } catch (error) {
        console.error('❌ Payment intent failed:', error);
        res.status(500).json({ message: 'Could not start payment', error: error.message });
    }
};

/**
 * Apply a successful payment to an order. Idempotent — Stripe retries webhooks, and the
 * client may also confirm, so this can legitimately run more than once per payment.
 */
const markOrderPaid = async (intent) => {
    const orderId = intent.metadata?.orderId;
    if (!orderId) return;

    const order = await Order.findById(orderId);
    if (!order || order.payment?.status === 'paid') return;

    order.payment.provider = 'stripe';
    order.payment.reference = intent.id;
    order.payment.status = 'paid';
    order.payment.paidAt = new Date();

    // Only advance the order itself if it was waiting on payment
    if (order.status === 'pending_payment') {
        order.transitionTo('placed', 'Payment received');
    } else {
        order.statusHistory.push({ status: order.status, at: new Date(), note: 'Payment received' });
    }

    await order.save();

    // Now that money has changed hands, the linked screenings genuinely are ordered
    const planItemIds = order.items.map((i) => i.planItemId).filter(Boolean);
    if (planItemIds.length) {
        await PlanItem.updateMany(
            { _id: { $in: planItemIds }, status: { $in: PlanItem.MUTABLE_STATUSES } },
            { $set: { status: 'ordered', orderId: order._id } },
            { runValidators: true }
        );
    }

    console.log('💳 Order paid:', orderId);
};

const markOrderFailed = async (intent) => {
    const orderId = intent.metadata?.orderId;
    if (!orderId) return;
    await Order.findByIdAndUpdate(orderId, {
        $set: { 'payment.status': 'failed' },
        $push: { statusHistory: { status: 'pending_payment', at: new Date(), note: 'Payment failed' } },
    }, { runValidators: true });
};

/**
 * POST /api/payments/webhook
 *
 * Stripe's callback and the authoritative record of payment: a client can be closed,
 * backgrounded, or lose signal between paying and telling us.
 *
 * Requires the RAW body for signature verification — see how this route is mounted in
 * index.js, before express.json().
 */
exports.handleWebhook = async (req, res) => {
    if (!isConfigured()) return res.status(503).send('Stripe not configured');

    let event;
    const signature = req.headers['stripe-signature'];

    if (!WEBHOOK_SECRETS.length) {
        // Without a signing secret the payload cannot be trusted: anyone who finds this URL
        // could POST a fake "payment succeeded". Accepted only so local development works.
        console.warn('⚠️ STRIPE_WEBHOOK_SECRET is not set — webhook signature NOT verified');
        try {
            event = JSON.parse(req.body.toString());
        } catch (error) {
            return res.status(400).send('Webhook Error: invalid payload');
        }
    } else {
        // Try each configured destination's secret; only one will match a given event
        let lastError;
        for (const secret of WEBHOOK_SECRETS) {
            try {
                event = getStripe().webhooks.constructEvent(req.body, signature, secret);
                break;
            } catch (error) {
                lastError = error;
            }
        }

        if (!event) {
            console.error('❌ Webhook signature verification failed against all configured secrets:', lastError?.message);
            return res.status(400).send(`Webhook Error: ${lastError?.message ?? 'signature mismatch'}`);
        }
    }

    try {
        switch (event.type) {
            case 'payment_intent.succeeded':
                await markOrderPaid(event.data.object);
                break;
            case 'payment_intent.payment_failed':
                await markOrderFailed(event.data.object);
                break;
            default:
                break;
        }
        // Acknowledge fast: Stripe retries anything it does not get a 2xx for
        res.json({ received: true });
    } catch (error) {
        console.error('❌ Webhook handling failed:', error);
        res.status(500).send('Webhook handler failed');
    }
};

/**
 * POST /api/payments/orders/:orderId/confirm
 *
 * Called by the app right after the PaymentSheet reports success, so the UI can move on
 * without waiting for the webhook. Verifies with Stripe rather than trusting the client,
 * and is safe to run alongside the webhook because `markOrderPaid` is idempotent.
 */
exports.confirmPayment = async (req, res) => {
    try {
        if (!isConfigured()) return res.status(503).json({ message: 'Payment is not available' });

        const order = await Order.findOne({ _id: req.params.orderId, userId: req.auth.userId });
        if (!order) return res.status(404).json({ message: 'Order not found' });
        if (!order.payment?.reference) return res.status(400).json({ message: 'No payment started for this order' });

        const intent = await getStripe().paymentIntents.retrieve(order.payment.reference);

        if (intent.status !== 'succeeded') {
            return res.status(409).json({ message: `Payment is ${intent.status}`, paymentStatus: intent.status });
        }

        await markOrderPaid(intent);
        const updated = await Order.findById(order._id);
        res.json({ message: 'Payment confirmed', order: updated });
    } catch (error) {
        console.error('❌ Payment confirmation failed:', error);
        res.status(500).json({ message: 'Could not confirm payment', error: error.message });
    }
};

exports.markOrderPaid = markOrderPaid;
