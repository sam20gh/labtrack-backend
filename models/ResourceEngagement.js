const mongoose = require('mongoose');

/**
 * One person's relationship with one resource: liked, saved, rated, how far through it they got.
 *
 * One row per pair rather than an array on the user document — the mistake `Plan.plan[]` made
 * and `MealLog` avoids. Someone who reads a piece a day for a year would otherwise carry 365
 * subdocuments inside a document every authenticated request loads.
 *
 * ## Why progress lives here and not in the player
 *
 * "Continue where you left off" has to survive the app being killed mid-video and reopened on
 * another device. The player posts `progressSeconds` periodically; this row is what a later
 * session reads back.
 *
 * ## Rating is three-valued, not five
 *
 * The design asks "How would you rate this article?" with Bad / Neutral / Great. It is stored
 * as that vocabulary and mapped to 1/3/5 only when averaging, so a later move to stars does
 * not silently reinterpret votes cast on a three-point scale. The mapping is in
 * `utils/resourceRating.js` and nowhere else.
 */
const ResourceEngagementSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    resourceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Resource', required: true, index: true },

    liked: { type: Boolean, default: false },
    saved: { type: Boolean, default: false },

    rating: { type: String, enum: ['bad', 'neutral', 'great', null], default: null },
    ratedAt: { type: Date, default: null },

    /** Furthest point reached, in seconds. Video and audio only. */
    progressSeconds: { type: Number, default: 0, min: 0 },
    completedAt: { type: Date, default: null },

    viewCount: { type: Number, default: 0, min: 0 },
    lastViewedAt: { type: Date, default: null },
}, { timestamps: true });

// One row per person per resource — the upsert every write path relies on.
ResourceEngagementSchema.index({ userId: 1, resourceId: 1 }, { unique: true });
// "Saved" and "Continue watching" both read one person's rows, newest first.
ResourceEngagementSchema.index({ userId: 1, saved: 1, updatedAt: -1 });
ResourceEngagementSchema.index({ userId: 1, lastViewedAt: -1 });

module.exports = mongoose.model('ResourceEngagement', ResourceEngagementSchema);
