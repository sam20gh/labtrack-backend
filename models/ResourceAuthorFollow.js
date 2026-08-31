const mongoose = require('mongoose');

/**
 * One person following one author.
 *
 * The row is the source of truth; `ResourceAuthor.followerCount` is a cache moved by `$inc`
 * on the same request. A unique compound index is what makes the toggle safe from two
 * devices at once — the second insert fails rather than incrementing the counter twice.
 */
const ResourceAuthorFollowSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'ResourceAuthor', required: true, index: true },
}, { timestamps: true });

ResourceAuthorFollowSchema.index({ userId: 1, authorId: 1 }, { unique: true });

module.exports = mongoose.model('ResourceAuthorFollow', ResourceAuthorFollowSchema);
