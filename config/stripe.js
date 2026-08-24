/**
 * Stripe configuration.
 *
 * Inert when `STRIPE_SECRET_KEY` is absent: `isConfigured()` returns false and the order
 * flow falls back to placing orders unpaid, exactly as it did before payment existed. That
 * keeps the app working in environments without Stripe credentials rather than failing at
 * checkout.
 */
const Stripe = require('stripe');

const SECRET_KEY = process.env.STRIPE_SECRET_KEY;

/**
 * Webhook signing secrets.
 *
 * Every Stripe endpoint destination has its OWN signing secret, and one backend often
 * receives from several — a hosted endpoint plus a `stripe listen` forward during
 * development, or separate destinations per environment. Supporting a single secret means
 * traffic from the other destination fails verification and is rejected.
 *
 * Accepts a comma-separated list in STRIPE_WEBHOOK_SECRET; each is tried in turn.
 */
const WEBHOOK_SECRETS = (process.env.STRIPE_WEBHOOK_SECRET || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Zero-decimal currencies aside, Stripe amounts are in the smallest unit. */
const CURRENCY = (process.env.STRIPE_CURRENCY || 'gbp').toLowerCase();

let client = null;

const isConfigured = () => Boolean(SECRET_KEY);

const getStripe = () => {
    if (!isConfigured()) throw new Error('Stripe is not configured on this server');
    if (!client) client = new Stripe(SECRET_KEY);
    return client;
};

/**
 * Convert a decimal amount to Stripe's smallest currency unit.
 * `Math.round` matters: 718.98 * 100 is 71897.99999999999 in floating point, and Stripe
 * rejects non-integer amounts.
 */
const toMinorUnits = (amount) => Math.round(Number(amount) * 100);

/** True when running against test keys — surfaced to the client so the UI can say so. */
const isTestMode = () => Boolean(SECRET_KEY && SECRET_KEY.startsWith('sk_test_'));

module.exports = { getStripe, isConfigured, isTestMode, toMinorUnits, CURRENCY, WEBHOOK_SECRETS };
