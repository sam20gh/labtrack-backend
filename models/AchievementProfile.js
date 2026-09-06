const mongoose = require('mongoose');

/**
 * One person's standing, and whether they want to be on the board at all.
 *
 * ## The leaderboard is opt-in, and that is not a preference
 *
 * Every other collection in this API is read by its owner and by a clinician with a reason.
 * A leaderboard is the first thing here that shows one patient something about another, and
 * the people using this app are using it because of their health. Someone with a diagnosis
 * they have told nobody about must not find their name on a list that a colleague can also
 * open, because they tapped a badge once.
 *
 * So `optedIn` defaults to **false**, and a profile that has not opted in is never returned
 * by a board query. Opting in is a decision made on a screen that says what will be visible;
 * opting out again removes the row from the board immediately, and no history of it is kept.
 *
 * ## The board carries no health data
 *
 * `points` and `unlockedCount` are counts of *actions taken in the app* — see the note at
 * the top of `achievementCatalogue.js` on why no achievement measures a result. `displayName`
 * is the person's own choice of name, not their account name, so being on the board never
 * requires publishing a legal name. There is deliberately no field here for a score, a
 * biomarker, a condition, a medication or an age.
 *
 * That is the same rule `AccessLog` follows about the records it audits: hold the identifier,
 * never the content.
 *
 * ## Denormalised on purpose
 *
 * `points` duplicates what `AchievementUnlock` rows already say. A board of a thousand
 * people would otherwise be a thousand aggregations per open. This row is rewritten by
 * `achievementController.refreshProfile` whenever an evaluation runs, from the rows — a
 * rebuild, never an increment, the same rule `DailyMetrics` and `observedProfile` follow.
 */
const AchievementProfileSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId, ref: 'User',
        required: true, unique: true, index: true,
    },

    /** Sum of the points on every unlocked level. Rebuilt, never incremented. */
    points: { type: Number, default: 0 },
    unlockedCount: { type: Number, default: 0 },

    /**
     * Opt-in to the public board. False until the person says otherwise on `/achievements`.
     * A false row still exists and still tracks points — it is only hidden from other people.
     */
    optedIn: { type: Boolean, default: false },
    optedInAt: { type: Date, default: null },

    /**
     * What other people see. Chosen by the person, defaulted from their first name, and
     * capped so the row cannot be used to broadcast a paragraph.
     */
    displayName: { type: String, default: '', maxlength: 40, trim: true },
    /** Their avatar URL, or null. Shown only while `optedIn`. */
    avatar: { type: String, default: null },

    computedAt: { type: Date, default: Date.now },
}, { timestamps: true });

// The board query: opted-in rows, highest first. Compound so the filter and the sort share
// one index rather than sorting the whole collection in memory.
AchievementProfileSchema.index({ optedIn: 1, points: -1 });

module.exports = mongoose.model('AchievementProfile', AchievementProfileSchema);
