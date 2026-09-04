const Product = require('../models/Product');

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

const scalarPatch = (body) => {
    const patch = {};
    for (const key of EDITABLE) {
        if (body[key] !== undefined) patch[key] = body[key];
    }
    return patch;
};

// Add new product
exports.addProduct = async (req, res) => {
    try {
        const patch = scalarPatch(req.body);
        const pictures = imagePatch(req.body) || { images: [], image: null };

        const product = await Product.create({ ...patch, ...pictures });
        res.status(201).json(product);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

exports.getProducts = async (req, res) => {
    try {
        const products = await Product.find();
        res.json(products);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};
exports.getProduct = async (req, res) => {
    try {
        const product = await Product.findById(req.params.id);
        if (!product) return res.status(404).json({ error: 'Product not found' });
        res.json(product);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};


exports.updateProduct = async (req, res) => {
    try {
        const existing = await Product.findById(req.params.id);
        if (!existing) return res.status(404).json({ error: 'Product not found' });

        const patch = scalarPatch(req.body);
        const pictures = imagePatch(req.body, existing.images || []);
        if (pictures) Object.assign(patch, pictures);

        const product = await Product.findByIdAndUpdate(
            req.params.id,
            patch,
            { new: true, runValidators: true }
        );
        res.json(product);
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

// Exported for the tests, which assert the sanitising rules directly.
exports._internal = { MAX_IMAGES, normaliseImages, imagePatch, isStoredUrl };
