const mongoose = require('mongoose');

/**
 * A content category — "Sleep", "Nutrients", "Meditation".
 *
 * The Explore Categories screen draws these grouped under a heading ("Wellness", "Fitness",
 * "Nutrition") with a resource count under each tile, so a category carries both its own
 * identity and the `group` it is filed under. Two levels, not a tree: the design has exactly
 * two, and a self-referencing parent would let someone build a five-deep hierarchy the UI
 * cannot render.
 *
 * `slug` is the stable identifier. It is what the app puts in a route and what an import
 * from the website keys on, so renaming a category's display name never breaks a link.
 *
 * **Counts are not stored here.** `GET /resources/categories` aggregates them from the
 * published resources, because a stored count drifts the moment anything is unpublished and
 * a category that claims 125 resources and lists 12 is worse than one that claims 12.
 */
const ResourceCategorySchema = new mongoose.Schema({
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },

    /** The heading this category sits under on the Explore screen. */
    group: { type: String, required: true, trim: true },

    /**
     * Sort order of the *group heading*, not of this category within it.
     *
     * Without it, group order fell out of a global sort on `order` then `name` — so
     * "Understanding your results" led the Explore screen because `health-metrics` happened
     * to sort before `healthcare`. Every category in a group should carry the same value;
     * the aggregate takes the lowest it sees.
     */
    groupOrder: { type: Number, default: 0 },

    /** Ionicons name. Held server-side so a new category needs no app release. */
    icon: { type: String, default: 'sparkles-outline' },

    /** Sort order within the group. Ties fall back to name. */
    order: { type: Number, default: 0 },

    /**
     * A retired category is hidden from browse but still resolves, so resources that
     * reference it keep rendering rather than losing their chip.
     */
    active: { type: Boolean, default: true },
}, { timestamps: true });

ResourceCategorySchema.index({ groupOrder: 1, group: 1, order: 1, name: 1 });

module.exports = mongoose.model('ResourceCategory', ResourceCategorySchema);
