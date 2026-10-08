const Product = require('../models/Product');
const ExchangeRates = require('../models/ExchangeRates');
const { normaliseIncludes } = require('../utils/orderComponents');
const currency = require('../utils/currency');

/**
 * How many pictures one product may carry.
 *
 * A cap rather than a free-for-all because the catalogue is loaded whole by the home
 * screen and the orders tab — an unbounded array is an unbounded response on the two
 * screens that must paint fastest.
 */
const MAX_IMAGES = 8;

/**
 * Accept a stored image URL, or reject it.
 *
 * **https only.** The frontend's picker hands back `file:///…` paths into the app's own
 * cache, and a `file://` in the catalogue is a picture that renders on the device that
 * chose it and nowhere else — the exact failure `createMeal` guards the nutrition gallery
 * against. Cloudflare delivery URLs are always https, so nothing legitimate is refused.
 */
const isStoredUrl = (value) =>
    typeof value === 'string' && /^https:\/\/\S+$/i.test(value.trim());

/** Trim, drop anything unusable, de-duplicate, and cap. Order is preserved: [0] is the cover. */
const normaliseImages = (values) => {
    const list = Array.isArray(values) ? values : [values];
    const seen = new Set();
    const out = [];

    for (const value of list) {
        if (!isStoredUrl(value)) continue;
        const url = value.trim();
        if (seen.has(url)) continue;
        seen.add(url);
        out.push(url);
        if (out.length === MAX_IMAGES) break;
    }

    return out;
};

/**
 * Build the `{ image, images }` pair from whatever a client sent.
 *
 * Three shapes arrive and all three have to work:
 *   - `images: [...]`  the portal's gallery editor — the gallery is exactly this
 *   - `image: '…'`     an older client sending only a cover — it becomes the cover, and is
 *                      promoted to the front of the existing gallery rather than replacing it
 *   - neither          leave the record's pictures alone
 *
 * Returns `null` when there is nothing to write, so a partial update does not blank a
 * gallery it never mentioned.
 */
const imagePatch = (body, existing = []) => {
    if (Array.isArray(body.images)) {
        const images = normaliseImages(body.images);
        return { images, image: images[0] || null };
    }

    if (body.image !== undefined) {
        // An explicit null/empty cover means "this product has no picture", which for a
        // record whose gallery is drawn from the cover down can only mean an empty gallery.
        if (!isStoredUrl(body.image)) return { images: [], image: null };
        const images = normaliseImages([body.image, ...existing]);
        return { images, image: images[0] || null };
    }

    return null;
};

/** The fields a client may set. Anything else in the body is ignored, not stored. */
const EDITABLE = ['name', 'sku', 'description', 'type', 'price'];

const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/**
 * A package's storefront copy, cleaned. Bullets are capped in number and length because the
 * website and the app both lay them out as a fixed card, and a ninth bullet or a paragraph in
 * one pushes the price off the card on a phone.
 */
const packagePatch = (pkg) => {
    if (!pkg || typeof pkg !== 'object') return undefined;
    return {
        tier: text(pkg.tier, 40),
        tagline: text(pkg.tagline, 140),
        highlights: (Array.isArray(pkg.highlights) ? pkg.highlights : [])
            .map((h) => text(h, 120))
            .filter(Boolean)
            .slice(0, 8),
        rank: Number.isFinite(Number(pkg.rank)) ? Number(pkg.rank) : 0,
        featured: pkg.featured === true,
    };
};

/** A 400 rather than a 500: the request was understood, one of its figures was not usable. */
const invalid = (message) => Object.assign(new Error(message), { status: 400 });

/**
 * The per-currency prices a client sent, merged over what the product already has.
 *
 * Only codes the body names are touched, so a client that knows nothing about currencies —
 * the older portal, a script setting `price` alone — cannot clear a price somebody set.
 * `null` or `''` clears one, which means "convert from GBP". A figure that is not a usable
 * price is refused, not dropped: a dropped AED price is a product that quietly goes back to
 * being converted, and nobody would notice until a customer did.
 */
const pricesPatch = (sent, existing = {}) => {
    if (sent === undefined) return undefined;
    if (sent === null || typeof sent !== 'object' || Array.isArray(sent)) {
        throw invalid('prices must be an object of currency codes to amounts.');
    }

    const out = {};
    for (const code of currency.OTHER_CODES) out[code] = currency.cleanAmount(existing?.[code]);

    for (const [key, value] of Object.entries(sent)) {
        const code = currency.normaliseCurrency(key);
        if (!code || code === currency.BASE) continue;
        if (value === null || value === '') {
            out[code] = null;
            continue;
        }
        const amount = currency.cleanAmount(value);
        if (amount === null) throw invalid(`Enter a ${code} price of zero or more, or leave it blank to convert.`);
        out[code] = amount;
    }
    return out;
};

const scalarPatch = (body, existing = null) => {
    const patch = {};
    for (const key of EDITABLE) {
        if (body[key] !== undefined) patch[key] = body[key];
    }
    // What the product ships — what its order line will track. Unknown kinds are dropped.
    if (body.includes !== undefined) patch.includes = normaliseIncludes(body.includes);
    if (body.package !== undefined) patch.package = packagePatch(body.package);
    const prices = pricesPatch(body.prices, existing?.prices);
    if (prices) patch.prices = prices;
    return patch;
};

/**
 * A product as every client reads it: the stored row, plus `pricing` — what it costs in each
 * currency and whether that figure was set or converted. `prices` is always complete, null
 * where unset, so an editor can tell "convert" from "missing".
 */
const withPricing = (product, rates) => {
    const plain = typeof product?.toObject === 'function' ? product.toObject() : product;
    const prices = {};
    for (const code of currency.OTHER_CODES) prices[code] = currency.cleanAmount(plain.prices?.[code]);
    return { ...plain, prices, pricing: currency.pricingFor(plain, rates) };
};

const currentRates = async () => (await ExchangeRates.current()).rates;

/** One featured package at a time: the storefronts mark exactly one as the default choice. */
const keepOneFeatured = async (product) => {
    if (product?.type === 'package' && product.package?.featured) {
        await Product.updateMany(
            { _id: { $ne: product._id }, 'package.featured': true },
            { $set: { 'package.featured': false } }
        );
    }
};

// Add new product
exports.addProduct = async (req, res) => {
    try {
        const patch = scalarPatch(req.body);
        const pictures = imagePatch(req.body) || { images: [], image: null };

        const product = await Product.create({ ...patch, ...pictures });
        await keepOneFeatured(product);
        res.status(201).json(withPricing(product, await currentRates()));
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

exports.getProducts = async (req, res) => {
    try {
        const [products, rates] = await Promise.all([Product.find().lean(), currentRates()]);
        res.json(products.map((p) => withPricing(p, rates)));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};
exports.getProduct = async (req, res) => {
    try {
        const product = await Product.findById(req.params.id).lean();
        if (!product) return res.status(404).json({ error: 'Product not found' });
        res.json(withPricing(product, await currentRates()));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};


exports.updateProduct = async (req, res) => {
    try {
        const existing = await Product.findById(req.params.id);
        if (!existing) return res.status(404).json({ error: 'Product not found' });

        const patch = scalarPatch(req.body, existing);
        const pictures = imagePatch(req.body, existing.images || []);
        if (pictures) Object.assign(patch, pictures);

        const product = await Product.findByIdAndUpdate(
            req.params.id,
            patch,
            { new: true, runValidators: true }
        );
        await keepOneFeatured(product);
        res.json(withPricing(product, await currentRates()));
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

exports.deleteProduct = async (req, res) => {
    try {
        const product = await Product.findByIdAndDelete(req.params.id);
        if (!product) return res.status(404).json({ error: 'Product not found' });
        res.json({ message: 'Product deleted' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * GET /api/products/currencies — the currencies sold in and the rates in force.
 *
 * Readable by any signed-in user, so the app can draw its picker; the rates themselves are no
 * secret, since every converted price on the storefront discloses them anyway.
 */
exports.getCurrencies = async (req, res) => {
    try {
        const current = await ExchangeRates.current();
        res.json({ base: currency.BASE, currencies: currency.currencyList(), ...current });
    } catch (error) {
        console.error('❌ Loading exchange rates failed:', error);
        res.status(500).json({ message: 'Could not load exchange rates' });
    }
};

/**
 * PUT /api/products/currencies { rates: { AED, SAR, EUR } } — admin.
 *
 * Every rate is required and must be usable: saving two of three would leave the third on a
 * placeholder nobody chose, under a "set" label. Orders already placed are not re-priced.
 */
exports.updateRates = async (req, res) => {
    try {
        const sent = req.body?.rates || {};
        const rates = {};
        for (const code of currency.OTHER_CODES) {
            const rate = currency.cleanRate(sent[code]);
            if (rate === null) {
                return res.status(400).json({ message: `Enter how many ${code} one GBP buys — a number above zero.` });
            }
            rates[code] = rate;
        }

        const by = req.auth?.userId || undefined;
        await ExchangeRates.findOneAndUpdate(
            { key: 'current' },
            {
                $set: { rates, updatedBy: by },
                $push: { history: { $each: [{ rates, at: new Date(), by }], $slice: -100 } },
            },
            { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
        );
        console.log('💱 Exchange rates updated:', rates);

        const current = await ExchangeRates.current();
        res.json({ base: currency.BASE, currencies: currency.currencyList(), ...current });
    } catch (error) {
        console.error('❌ Saving exchange rates failed:', error);
        res.status(500).json({ message: 'Could not save exchange rates' });
    }
};

// Exported for the tests, which assert the sanitising rules directly.
exports._internal = { MAX_IMAGES, normaliseImages, imagePatch, isStoredUrl, packagePatch, scalarPatch, pricesPatch, withPricing };
