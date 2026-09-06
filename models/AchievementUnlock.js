const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * One badge, at one level, earned once.
 *
 * Append-only, like `Interpretation`, `MedicationCheck` and `HealthScore`, and for a reason
 * this feature makes sharper than any of them: **an unlock is never revoked.**
 *
 * Progress is derived on every read from the rows the trackers hold — there is no stored
 * counter, so nothing can drift. But that means progress *falls* when data goes away: a
 * person who deletes six months of meals, or whose watch resyncs and dedupes, would see
 * their meal count drop below a threshold they had already crossed. Recomputing the badge
 * from that number would take it back.
 *
 * Taking a badge back is the wrong behaviour twice over. It punishes somebody for tidying
 * their own records, and it makes a shared card a lie after the fact — the link in a
 * WhatsApp thread would keep pointing at an achievement the app no longer agrees they have.
 * So the row below is the record: written the first time a threshold is crossed, and read in
 * preference to the live grade for `unlocked` and `level`. It is the same call
 * `MetricLog.category` makes about a blood-pressure band classified under an older
 * guideline — what somebody was told stays true.
 *
 * One row per level, not one per achievement, so "Heart Champ reached level 3 on the 14th"
 * is answerable and the celebration fires once per level rather than once ever.
 */

/**
 * A share token, or null until somebody shares.
 *
 * 32 URL-safe characters from `randomBytes`, which is unguessable: the token is the entire
 * credential for a page anyone with the link can open, so it must not be derivable from the
 * user id, the badge key or the date. Minted lazily rather than at unlock, because a token
 * that exists is a URL that resolves, and most badges are never shared.
 */
const mintToken = () => crypto.randomBytes(24).toString('base64url');

const AchievementUnlockSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** The catalogue key. Not an enum: the catalogue is the source of truth, not this file. */
    key: { type: String, required: true },

    /** 1-based. Level 1 is the first threshold crossed. */
    level: { type: Number, required: true, min: 1 },

    /** The threshold this level required, and what they actually had when it fired. */
    threshold: { type: Number, required: true },
    value: { type: Number, required: true },

    /** Points this level was worth at the time. Frozen: the catalogue's values may change. */
    points: { type: Number, required: true, default: 0 },

    unlockedAt: { type: Date, required: true, default: Date.now },

    /**
     * Whether the person has seen the celebration.
     *
     * The unlock modal fires once. Unlocks are detected on a background evaluation that may
     * run while the app is closed, so "show it next time they look" needs a flag rather than
     * a response field.
     */
    seen: { type: Boolean, default: false },

    /** Null until this badge is shared. See `mintToken`. */
    shareToken: { type: String, default: null },
    /** When the current token was minted, so revoking and re-sharing is distinguishable. */
    sharedAt: { type: Date, default: null },
}, { timestamps: true });

// The unique key is what makes `recordUnlocks` idempotent: two evaluations racing on the
// same threshold produce one row, and the loser's duplicate-key error is expected.
AchievementUnlockSchema.index({ userId: 1, key: 1, level: 1 }, { unique: true });
// The achievements screen: everything one person has, newest first.
AchievementUnlockSchema.index({ userId: 1, unlockedAt: -1 });
// Resolving a share link. Sparse — most rows never carry a token.
AchievementUnlockSchema.index(
    { shareToken: 1 },
    { unique: true, partialFilterExpression: { shareToken: { $type: 'string' } } },
);

AchievementUnlockSchema.statics.mintToken = mintToken;

module.exports = mongoose.model('AchievementUnlock', AchievementUnlockSchema);
