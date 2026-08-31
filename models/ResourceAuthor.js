const mongoose = require('mongoose');

/**
 * Whoever wrote, presented or taught a piece of content.
 *
 * The design's Speaker Details screen is a real page — credentials, an instructor course
 * list, a rating breakdown, contact details and socials — so an author is an entity, not a
 * string on a resource.
 *
 * **Deliberately separate from `Professional`.** A `Professional` is someone a person can
 * book a consultation with; an author is someone whose article they can read. Most authors
 * are not bookable and most clinicians in the directory have written nothing, so folding
 * the two together would mean either publishing unbookable clinicians into the directory or
 * carrying a "can you actually book this one" flag through every professional screen.
 * `professionalId` links the overlap where it exists, which is what powers a "Book a
 * consultation" affordance on an author who happens to be both.
 *
 * ## Ratings are not stored here
 *
 * `ratingSum`/`ratingCount` live on `Resource`. An author's 4.2 is aggregated across their
 * published resources at read time. Storing a second copy here means two counters that must
 * be kept in step, and the one nobody remembers to decrement is the one that is wrong.
 */

const AchievementSchema = new mongoose.Schema({
    /** Ionicons name drawn beside it. */
    icon: { type: String, default: 'ribbon-outline' },
    title: { type: String, required: true, trim: true },
    detail: { type: String, default: '' },
}, { _id: false });

const ResourceAuthorSchema = new mongoose.Schema({
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },

    /** As it should be printed, honorifics included: "Prof. Dr. Hannibal Lector, PhD, MD." */
    name: { type: String, required: true, trim: true },

    /** The chip above the name on Speaker Details: "Psychiatrist", "Dietitian". */
    speciality: { type: String, default: null },

    /** One line under the name in a byline context. */
    headline: { type: String, default: null },

    /** Cloudflare delivery URLs. Read from the upload response, never assembled. */
    avatar: { type: String, default: null },
    coverImage: { type: String, default: null },

    bio: { type: String, default: '' },
    achievements: { type: [AchievementSchema], default: [] },

    contact: {
        tel: { type: String, default: null },
        email: { type: String, default: null },
        fax: { type: String, default: null },
    },

    socials: {
        facebook: { type: String, default: null },
        dribbble: { type: String, default: null },
        discord: { type: String, default: null },
        instagram: { type: String, default: null },
        linkedin: { type: String, default: null },
        x: { type: String, default: null },
        website: { type: String, default: null },
    },

    /** Set only where this author is also bookable. See the note above. */
    professionalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Professional', default: null },

    /**
     * Denormalised follower count.
     *
     * Unlike ratings this one IS stored, because it has no source of truth to aggregate
     * from other than the follow rows themselves, and "25K Followers" is drawn on a card in
     * a horizontal list — counting rows per card would be a query per card.
     * `ResourceAuthorFollow` is the record; this is the cache, moved by `$inc` on the same
     * request that writes the row.
     */
    followerCount: { type: Number, default: 0, min: 0 },

    active: { type: Boolean, default: true },
}, { timestamps: true });

ResourceAuthorSchema.index({ name: 'text', headline: 'text' });

module.exports = mongoose.model('ResourceAuthor', ResourceAuthorSchema);
