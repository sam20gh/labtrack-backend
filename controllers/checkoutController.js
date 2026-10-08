const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const C = require('../utils/orderComponents');
const { newClaimCode } = require('../utils/claimOrders');
const ExchangeRates = require('../models/ExchangeRates');
const { BASE, CURRENCIES, normaliseCurrency, priceFor, pricingFor, currencyList } = require('../utils/currency');
const { getStripe, isConfigured, isTestMode, toMinorUnits, stripeCurrency } = require('../config/stripe');
const { markOrderPaid } = require('./paymentController');

/**
 * The storefront: packages, sold on the website to people with no account and in the app to
 * people with one, from the same rows.
 *
 * **Public on purpose.** The website is where the packages are advertised, and asking
 * somebody to make an account before they can see a price — or pay — is how a marketing
 * page loses the people it brought in. So the website buys as a guest: the order is held
 * against the buyer's email, Stripe's hosted Checkout takes the card and the address, and the
 * order becomes theirs when they sign in to the app (`utils/claimOrders.js`).
 *
 * The app buys through the existing basket and PaymentSheet, as a signed-in person, and reads
 * the same `GET /packages`.
 */

const SITE_URL = () => (process.env.PUBLIC_SITE_URL || process.env.PORTAL_URL || 'http://localhost:3000').replace(/\/+$/, '');

/** Where the thank-you page sends people to install. Unset links are omitted, never invented. */
const appLinks = () => ({
    ios: process.env.APP_STORE_URL || null,
    android: process.env.PLAY_STORE_URL || null,
});

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * What a storefront may show. Never the SKU-level internals, never anything per-customer.
 *
 * `price`/`currency` are in the currency asked for; `pricing` carries all four, so switching
 * the picker redraws without another request.
 */
const storefrontView = (p, currency = BASE, rates) => ({
    _id: String(p._id),
    name: p.name,
    description: p.description || null,
    price: priceFor(p, currency, rates).amount,
    currency,
    pricing: pricingFor(p, rates),
    image: p.image || null,
    images: p.images || [],
    includes: C.normaliseIncludes(p.includes),
    package: p.package
        ? {
            tier: p.package.tier || p.name,
            tagline: p.package.tagline || null,
            highlights: p.package.highlights || [],
            rank: p.package.rank ?? 0,
            featured: Boolean(p.package.featured),
        }
        : null,
});

/**
 * GET /api/checkout/packages?currency=AED
 *
 * An unknown or absent currency answers in GBP rather than refusing: this is the page a
 * marketing link lands on, and a 400 there is a blank page.
 *
 * `packages`: every `type: 'package'` product, lowest `rank` first.
 * `addons`: what can be bought alongside or afterwards — today, the bracelet on its own, for
 * somebody whose package did not include one.
 */
exports.listPackages = async (req, res) => {
    try {
        const currency = normaliseCurrency(req.query?.currency) || BASE;
        const [packages, addons, { rates }] = await Promise.all([
            Product.find({ type: 'package' }).lean(),
            Product.find({ type: { $ne: 'package' }, includes: 'bracelet' }).lean(),
            ExchangeRates.current(),
        ]);
        const view = (p) => storefrontView(p, currency, rates);
        res.json({
            currency,
            currencies: currencyList(),
            packages: packages
                .map(view)
                .sort((a, b) => (a.package.rank - b.package.rank) || (a.price - b.price)),
            addons: addons.map(view),
            payment: { available: isConfigured(), testMode: isTestMode() },
        });
    } catch (error) {
        console.error('❌ Listing packages failed:', error);
        res.status(500).json({ message: 'Could not load packages' });
    }
};

/** Create the order, retrying the claim code on the (vanishingly rare) collision. */
const createGuestOrder = async ({ product, email, currency, price }) => {
    const now = new Date();
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await Order.create({
                guestEmail: email,
                source: 'web',
                claimCode: newClaimCode(),
                items: [{
                    productId: product._id,
                    name: product.name,
                    price,
                    quantity: 1,
                    components: C.componentsFor(product, now),
                }],
                currency,
                subtotal: price,
                total: price,
                status: 'pending_payment',
                statusHistory: [{ status: 'pending_payment', at: now, note: 'Website checkout started' }],
            });
        } catch (error) {
            if (error.code !== 11000) throw error;
        }
    }
    throw new Error('Could not allocate a claim code');
};

/**
 * POST /api/checkout/session { productId, email, currency? }
 *
 * Starts a Stripe Checkout Session for one package and answers with its URL. The price comes
 * from the catalogue, never the request — the rule `createOrder` follows; the buyer picks only
 * the currency, and delivery is limited to where that currency is sold. Stripe collects the
 * card and the delivery address; the webhook (`checkout.session.completed`) is what marks the
 * order paid and copies the address onto it.
 */
exports.createSession = async (req, res) => {
    try {
        if (!isConfigured()) return res.status(503).json({ message: 'Checkout is not available right now.' });

        const { productId, email, website } = req.body || {};
        // The landing page's honeypot field: a bot that fills it is answered like a person and
        // given nothing to pay.
        if (typeof website === 'string' && website.trim()) return res.status(400).json({ message: 'Please try again.' });

        const normalised = typeof email === 'string' ? email.trim().toLowerCase() : '';
        if (!EMAIL.test(normalised) || normalised.length > 254) {
            return res.status(400).json({ message: 'Enter the email you will use for the app.' });
        }
        if (!mongoose.isValidObjectId(productId)) return res.status(400).json({ message: 'Choose a package.' });

        const sent = req.body?.currency;
        const currency = sent === undefined || sent === null || sent === '' ? BASE : normaliseCurrency(sent);
        if (!currency) return res.status(400).json({ message: 'Choose a currency we sell in.' });

        const product = await Product.findOne({
            _id: productId,
            $or: [{ type: 'package' }, { includes: 'bracelet' }],
        }).lean();
        if (!product) return res.status(404).json({ message: 'That package is not available.' });

        const { rates } = await ExchangeRates.current();
        const { amount } = priceFor(product, currency, rates);
        const order = await createGuestOrder({ product, email: normalised, currency, price: amount });

        const site = SITE_URL();
        const session = await getStripe().checkout.sessions.create({
            mode: 'payment',
            customer_email: normalised,
            line_items: [{
                quantity: 1,
                price_data: {
                    currency: stripeCurrency(currency),
                    unit_amount: toMinorUnits(amount),
                    product_data: {
                        name: product.name,
                        ...(product.package?.tagline ? { description: product.package.tagline } : {}),
                        ...(product.image && /^https:\/\//.test(product.image) ? { images: [product.image] } : {}),
                    },
                },
            }],
            // Where this currency's prices apply. See `CURRENCIES[].shipTo`.
            shipping_address_collection: { allowed_countries: CURRENCIES[currency].shipTo },
            // The webhook only sees metadata. Both carry the order, so whichever event arrives
            // first — the session or the payment intent — can settle it.
            metadata: { orderId: String(order._id), source: 'web' },
            payment_intent_data: { metadata: { orderId: String(order._id), source: 'web' } },
            success_url: `${site}/packages/thanks?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${site}/packages?cancelled=1`,
        });

        await Order.updateOne(
            { _id: order._id },
            { $set: { 'payment.provider': 'stripe', 'payment.status': 'unpaid', 'payment.checkoutSessionId': session.id } }
        );

        console.log(`🛒 Website checkout started: ${product.name}, ${currency} ${amount} (order ${order._id})`);
        res.status(201).json({ url: session.url });
    } catch (error) {
        console.error('❌ Website checkout failed:', error);
        res.status(500).json({ message: 'Could not start checkout. Please try again.' });
    }
};

/** Stripe moved the shipping block under `collected_information`; read either. */
const shippingFrom = (session) =>
    session?.collected_information?.shipping_details || session?.shipping_details || null;

/**
 * Settle a completed Checkout Session against its order. Idempotent — the webhook and the
 * thank-you page can both run it.
 */
const applyCheckoutSession = async (session) => {
    const orderId = session?.metadata?.orderId;
    if (!orderId) return null;

    const order = await Order.findById(orderId);
    if (!order) return null;

    const shipping = shippingFrom(session);
    if (shipping?.address && !order.shippingAddress?.line1) {
        order.shippingAddress = {
            line1: shipping.address.line1 || undefined,
            line2: shipping.address.line2 || undefined,
            city: shipping.address.city || undefined,
            postcode: shipping.address.postal_code || undefined,
            country: shipping.address.country || undefined,
        };
        await order.save();
    }

    if (session.payment_status === 'paid' && order.payment?.status !== 'paid') {
        const intentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
        await markOrderPaid({ id: intentId || session.id, metadata: { orderId } });
    }
    return Order.findById(orderId);
};

/** "s***@gmail.com" — enough for the buyer to recognise, not enough to harvest. */
const maskEmail = (email) => {
    const [name, domain] = String(email || '').split('@');
    if (!name || !domain) return null;
    return `${name[0]}${'*'.repeat(Math.max(1, Math.min(name.length - 1, 6)))}@${domain}`;
};

/**
 * GET /api/checkout/session/:sessionId — the thank-you page.
 *
 * The session id is in the URL Stripe returned the buyer to, and is long and unguessable, so
 * holding it is treated as holding the receipt: it shows that order's claim code and nothing
 * else. If the webhook has not landed yet, Stripe is asked directly, so the page does not say
 * "payment pending" to somebody who has just paid.
 */
exports.getSession = async (req, res) => {
    try {
        const sessionId = String(req.params.sessionId || '');
        if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(sessionId)) return res.status(404).json({ message: 'Not found' });

        let order = await Order.findOne({ 'payment.checkoutSessionId': sessionId });
        if (!order) return res.status(404).json({ message: 'Not found' });

        if (order.payment?.status !== 'paid' && isConfigured()) {
            const session = await getStripe().checkout.sessions.retrieve(sessionId);
            order = (await applyCheckoutSession(session)) || order;
        }

        const paid = order.payment?.status === 'paid';
        res.json({
            paid,
            product: order.items?.[0]?.name || null,
            includes: (order.items?.[0]?.components || []).map((c) => c.kind),
            email: maskEmail(order.guestEmail),
            // Only once paid: an unpaid order's code claims an order that will never ship.
            claimCode: paid ? order.claimCode : null,
            claimed: Boolean(order.userId),
            appLinks: appLinks(),
        });
    } catch (error) {
        console.error('❌ Checkout session lookup failed:', error);
        res.status(500).json({ message: 'Could not load your order' });
    }
};

exports.applyCheckoutSession = applyCheckoutSession;
exports._internal = { storefrontView, maskEmail, shippingFrom };
