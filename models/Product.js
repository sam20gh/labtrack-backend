const mongoose = require('mongoose');

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
    price: { type: Number, required: true }
});

module.exports = mongoose.model('Product', ProductSchema);
