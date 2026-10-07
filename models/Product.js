const mongoose = require('mongoose');
const { KINDS } = require('../utils/orderComponents');

/**
 * The orderable catalogue.
 *
 * `image` is the **cover**, and `images` is the gallery it is drawn from — the cover is
 * always `images[0]`, kept in sync by `productController`. It is stored twice on purpose:
 * three mobile screens and `lib/basket.tsx` read `product.image` and predate the gallery,
 * so deriving the cover on read would have meant editing every one of them for a field
 * that is already there. A product with one picture is indistinguishable from what it was
 * before this existed.
 *
 * Both hold **Cloudflare delivery URLs, never bytes** — the same rule `User.profileImage`
 * and `MealLog.imageUrl` follow. A base64 catalogue would be re-sent on every home-screen
 * load, which is the mistake `Plan.plan[]` made.
 */
const ProductSchema = new mongoose.Schema({
    name: { type: String, required: true },
    sku: { type: String, required: true, unique: true },
    description: { type: String },
    /** Cover image — always the first entry of `images`. URL from Cloudflare. */
    image: { type: String },
    /** The gallery, cover first. Sanitised and capped by the controller. */
    images: { type: [String], default: [] },
    type: { type: String },
    price: { type: Number, required: true },

    /**
     * What this product physically ships, and therefore what its order line tracks.
     *
     * `['blood']` for a blood test, `['bracelet']` for the bracelet sold on its own, all three
     * for the top package. An order snapshots these into `items[].components` when it is
     * placed — see `utils/orderComponents.js`. Empty on every product that predates it, and an
     * order for such a product moves on the order-level status exactly as it always did.
     */
    includes: { type: [{ type: String, enum: KINDS }], default: [] },

    /**
     * Present on a package — a product with `type: 'package'` — and nowhere else.
     *
     * The three packages are sold on the website and in the app from the same rows, so the
     * copy lives here rather than in either client: a price or a bullet changed in one place
     * and not the other is a customer who was sold one thing and shown another.
     */
    package: {
        /** Short name for the tier, e.g. "Essential". `name` stays the full product name. */
        tier: { type: String },
        tagline: { type: String },
        /** Bullets, in order. Plain sentences — no prices, no clinical claims. */
        highlights: { type: [String], default: [] },
        /** Sort order on both storefronts, lowest first. */
        rank: { type: Number, default: 0 },
        /** The one the storefronts mark as the default choice. */
        featured: { type: Boolean, default: false },
    },
});

ProductSchema.index({ type: 1 });

module.exports = mongoose.model('Product', ProductSchema);
