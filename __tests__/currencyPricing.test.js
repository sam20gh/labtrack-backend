/**
 * Selling in GBP, AED, SAR and EUR.
 *
 * Each block pins a way the naive version would charge somebody the wrong amount:
 *
 *   - a set price that a rate change quietly moves is a price nobody chose;
 *   - a GBP figure charged in dirhams is a fifth of the price, and the reverse is five times it;
 *   - a client that never heard of currencies must not clear a price somebody set;
 *   - a rate saved two-of-three leaves the third on a placeholder under a "set" label;
 *   - a regional price that ships anywhere is a discount anybody can take.
 */
const mockStripe = {
    checkout: { sessions: { create: jest.fn(), retrieve: jest.fn() } },
    customers: { create: jest.fn(async () => ({ id: 'cus_1' })) },
    paymentIntents: { create: jest.fn(), retrieve: jest.fn() },
    ephemeralKeys: { create: jest.fn(async () => ({ secret: 'ek_1' })) },
};
jest.mock('../config/stripe', () => ({
    getStripe: () => mockStripe,
    isConfigured: () => true,
    isTestMode: () => true,
    toMinorUnits: (a) => Math.round(Number(a) * 100),
    stripeCurrency: (c) => String(c || 'GBP').toLowerCase(),
    WEBHOOK_SECRETS: [],
}));

const mongoose = require('mongoose');
const User = require('../models/userModel');
const Order = require('../models/Order');
const Product = require('../models/Product');
const ExchangeRates = require('../models/ExchangeRates');
const currency = require('../utils/currency');
const products = require('../controllers/productController');
const orders = require('../controllers/orderController');
const checkout = require('../controllers/checkoutController');
const payments = require('../controllers/paymentController');

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

const RATES = { AED: 4.9, SAR: 5, EUR: 1.17 };

describe('priceFor', () => {
    const product = { price: 149, prices: { AED: 699, SAR: null } };

    it('uses the GBP price as the base', () => {
        expect(currency.priceFor(product, 'gbp', RATES)).toEqual({ currency: 'GBP', amount: 149, source: 'base' });
    });

    it('uses a set price exactly, whatever the rate', () => {
        expect(currency.priceFor(product, 'AED', RATES)).toMatchObject({ amount: 699, source: 'set' });
        expect(currency.priceFor(product, 'AED', { ...RATES, AED: 9 })).toMatchObject({ amount: 699, source: 'set' });
    });

    it('converts an unset price at the rate and rounds to a whole unit', () => {
        expect(currency.priceFor(product, 'SAR', RATES)).toMatchObject({ amount: 745, source: 'converted' });
        // 149 × 1.17 = 174.33
        expect(currency.priceFor(product, 'EUR', RATES)).toMatchObject({ amount: 174, source: 'converted' });
    });

    it('treats a zero set price as set, not as missing', () => {
        expect(currency.priceFor({ price: 10, prices: { EUR: 0 } }, 'EUR', RATES)).toMatchObject({ amount: 0, source: 'set' });
    });

    it('falls back to the placeholder rate rather than pricing at nothing', () => {
        expect(currency.priceFor({ price: 100 }, 'AED', { AED: 0 }).amount).toBe(Math.round(100 * currency.DEFAULT_RATES.AED));
    });

    it('throws on a currency it does not sell in, so nothing charges GBP in other units', () => {
        expect(() => currency.priceFor(product, 'USD', RATES)).toThrow(/Unsupported/);
    });

    it('ships each currency only to where it is sold', () => {
        expect(currency.CURRENCIES.GBP.shipTo).toEqual(['GB']);
        expect(currency.CURRENCIES.AED.shipTo).toEqual(['AE']);
        expect(currency.CURRENCIES.SAR.shipTo).toEqual(['SA']);
        expect(currency.CURRENCIES.EUR.shipTo).toContain('IE');
        expect(currency.CURRENCIES.EUR.shipTo).not.toContain('GB');
    });
});

describe('product prices', () => {
    const admin = { userId: String(new mongoose.Types.ObjectId()), role: 'admin' };

    it('stores set prices and reads every currency back with its source', async () => {
        const { code, body } = await call(products.addProduct, {
            auth: admin,
            body: { name: 'Lipid panel', sku: 'LP', price: 39, prices: { AED: 199, EUR: '' } },
        });
        expect(code).toBe(201);
        expect(body.prices).toEqual({ AED: 199, SAR: null, EUR: null });
        expect(body.pricing.GBP).toEqual({ amount: 39, source: 'base' });
        expect(body.pricing.AED).toEqual({ amount: 199, source: 'set' });
        expect(body.pricing.SAR.source).toBe('converted');
    });

    it('leaves set prices alone when an update does not mention them', async () => {
        const p = await Product.create({ name: 'MRI', sku: 'MRI', price: 649, prices: { AED: 2999 } });
        const { body } = await call(products.updateProduct, { auth: admin, params: { id: String(p._id) }, body: { price: 599 } });
        expect(body.prices.AED).toBe(2999);
        expect(body.pricing.EUR.amount).toBe(Math.round(599 * currency.DEFAULT_RATES.EUR));
    });

    it('clears one currency with null and keeps the others', async () => {
        const p = await Product.create({ name: 'DNA', sku: 'DNA', price: 199, prices: { AED: 999, SAR: 999 } });
        const { body } = await call(products.updateProduct, { auth: admin, params: { id: String(p._id) }, body: { prices: { AED: null } } });
        expect(body.prices).toEqual({ AED: null, SAR: 999, EUR: null });
        expect(body.pricing.AED.source).toBe('converted');
    });

    it('refuses an unusable price rather than dropping it back to a conversion', async () => {
        const p = await Product.create({ name: 'DNA', sku: 'DNA2', price: 199, prices: { AED: 999 } });
        const { code } = await call(products.updateProduct, { auth: admin, params: { id: String(p._id) }, body: { prices: { AED: -5 } } });
        expect(code).toBe(400);
        expect((await Product.findById(p._id).lean()).prices.AED).toBe(999);
    });

    it('lists the catalogue at the stored rates', async () => {
        await ExchangeRates.create({ rates: { AED: 5, SAR: 5, EUR: 1.2 } });
        await Product.create({ name: 'Blood', sku: 'B', price: 100 });
        const { body } = await call(products.getProducts, {});
        expect(body[0].pricing).toMatchObject({ AED: { amount: 500 }, EUR: { amount: 120 } });
    });
});

describe('exchange rates', () => {
    const admin = { userId: String(new mongoose.Types.ObjectId()), role: 'admin' };

    it('reports placeholders as never chosen', async () => {
        const { body } = await call(products.getCurrencies, {});
        expect(body.source).toBe('default');
        expect(body.base).toBe('GBP');
        expect(body.currencies.map((c) => c.code)).toEqual(['GBP', 'AED', 'SAR', 'EUR']);
    });

    it('saves all three, records who, and refuses a partial set', async () => {
        expect((await call(products.updateRates, { auth: admin, body: { rates: { AED: 4.9, SAR: 5 } } })).code).toBe(400);
        expect(await ExchangeRates.countDocuments()).toBe(0);

        const { code, body } = await call(products.updateRates, { auth: admin, body: { rates: { AED: '4.91', SAR: 5.02, EUR: 1.16 } } });
        expect(code).toBe(200);
        expect(body).toMatchObject({ source: 'set', rates: { AED: 4.91, SAR: 5.02, EUR: 1.16 } });

        await call(products.updateRates, { auth: admin, body: { rates: { AED: 4.95, SAR: 5.02, EUR: 1.16 } } });
        const row = await ExchangeRates.findOne().lean();
        expect(row.history).toHaveLength(2);
        expect(String(row.updatedBy)).toBe(admin.userId);
    });
});

describe('orders', () => {
    const makeUser = () => User.create({
        username: `u${new mongoose.Types.ObjectId()}`,
        email: `${new mongoose.Types.ObjectId()}@example.com`,
        supabaseId: String(new mongoose.Types.ObjectId()),
    });

    it('prices every line in the chosen currency and snapshots it', async () => {
        const user = await makeUser();
        const a = await Product.create({ name: 'Blood', sku: 'B', price: 100, prices: { AED: 450 } });
        const b = await Product.create({ name: 'DNA', sku: 'D', price: 200 });

        const { code, body } = await call(orders.createOrder, {
            auth: { userId: String(user._id) },
            body: { currency: 'aed', items: [{ productId: String(a._id), quantity: 2, price: 1 }, { productId: String(b._id) }] },
        });
        expect(code).toBe(201);
        expect(body.order.currency).toBe('AED');
        expect(body.order.items.map((i) => i.price)).toEqual([450, Math.round(200 * currency.DEFAULT_RATES.AED)]);
        expect(body.order.total).toBe(900 + Math.round(200 * currency.DEFAULT_RATES.AED));

        // A later price change does not touch what was charged.
        await Product.updateOne({ _id: a._id }, { $set: { 'prices.AED': 999 } });
        expect((await Order.findById(body.order._id).lean()).items[0].price).toBe(450);
    });

    it('defaults to GBP for a client that sends no currency, and refuses one we do not sell in', async () => {
        const user = await makeUser();
        const p = await Product.create({ name: 'Blood', sku: 'B', price: 100 });
        const auth = { userId: String(user._id) };

        const plain = await call(orders.createOrder, { auth, body: { items: [{ productId: String(p._id) }] } });
        expect(plain.body.order).toMatchObject({ currency: 'GBP', total: 100 });

        const usd = await call(orders.createOrder, { auth, body: { currency: 'USD', items: [{ productId: String(p._id) }] } });
        expect(usd.code).toBe(400);
    });

    it('charges the payment intent in the order currency, not the base', async () => {
        const user = await makeUser();
        const order = await Order.create({
            userId: user._id, currency: 'SAR', subtotal: 745, total: 745, status: 'pending_payment',
            items: [{ productId: new mongoose.Types.ObjectId(), name: 'Blood', price: 745 }],
        });
        mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_1', client_secret: 'sec' });

        const { code, body } = await call(payments.createPaymentIntent, { auth: { userId: String(user._id) }, params: { orderId: String(order._id) } });
        expect(code).toBe(200);
        expect(mockStripe.paymentIntents.create.mock.calls.at(-1)[0]).toMatchObject({ amount: 74500, currency: 'sar' });
        expect(body.currency).toBe('sar');
    });
});

describe('website checkout', () => {
    const pkg = (over = {}) => Product.create({
        name: 'Complete', sku: `PKG-${new mongoose.Types.ObjectId()}`, price: 249, type: 'package',
        includes: ['blood', 'dna', 'bracelet'], package: { tier: 'Complete', rank: 2 }, ...over,
    });

    it('lists packages in the currency asked for, with every currency alongside', async () => {
        await pkg({ prices: { EUR: 279 } });
        const { body } = await call(checkout.listPackages, { query: { currency: 'eur' } });
        expect(body.currency).toBe('EUR');
        expect(body.packages[0]).toMatchObject({ price: 279, currency: 'EUR' });
        expect(body.packages[0].pricing.GBP.amount).toBe(249);

        const fallback = await call(checkout.listPackages, { query: { currency: 'XYZ' } });
        expect(fallback.body.packages[0]).toMatchObject({ price: 249, currency: 'GBP' });
    });

    it('starts checkout in the chosen currency and ships only where it is sold', async () => {
        const p = await pkg({ prices: { AED: 1199 } });
        mockStripe.checkout.sessions.create.mockResolvedValue({ id: 'cs_test_abcdefghijkl', url: 'https://checkout.stripe.com/x' });

        const { code } = await call(checkout.createSession, { body: { productId: String(p._id), email: 'a@b.co', currency: 'AED' } });
        expect(code).toBe(201);

        const args = mockStripe.checkout.sessions.create.mock.calls.at(-1)[0];
        expect(args.line_items[0].price_data).toMatchObject({ currency: 'aed', unit_amount: 119900 });
        expect(args.shipping_address_collection.allowed_countries).toEqual(['AE']);
        expect(await Order.findOne({ guestEmail: 'a@b.co' }).lean()).toMatchObject({ currency: 'AED', total: 1199 });
    });

    it('refuses a currency it does not sell in', async () => {
        const p = await pkg();
        const { code } = await call(checkout.createSession, { body: { productId: String(p._id), email: 'a@b.co', currency: 'USD' } });
        expect(code).toBe(400);
    });
});
