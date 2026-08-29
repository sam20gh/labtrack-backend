const mongoose = require('mongoose');

/**
 * One person's weekly activity targets, and the plan advice those targets encode.
 *
 * The same shape and the same reasoning as `NutritionPlan`. The point of this feature is
 * that it pushes people towards the exercise advice on their interpretation rather than
 * towards a number they typed once — and `guidance[]` is the link that makes that true. It
 * is derived from the person's `PlanItem`s where `type: 'lifestyle'` and
 * `condition: 'exercise'`, so a regenerated interpretation moves the targets with it.
 *
 * `User.healthAssessment.lifestyle.exerciseFrequency` is left alone. It records what
 * someone said about themselves once, at signup, which is a different fact from what their
 * results say they should be doing.
 */

/**
 * One exercise directive taken from the plan.
 *
 * `directive` is the recommendation as the interpretation actually worded it. That exact
 * sentence is what the person is shown and what goes into the insight prompt — paraphrasing
 * clinical advice on the way through is how a tracker ends up coaching something the plan
 * never said.
 */
const GuidanceSchema = new mongoose.Schema({
    planItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlanItem' },
    /** Matched key from `activityTargets.ACTIVITY_SHIFTS`, or 'other' when unrecognised. */
    key: { type: String, required: true },
    kind: { type: String, enum: ['volume', 'intensity', 'modality', 'caution', 'other'], default: 'other' },
    /** Short chip label, e.g. 'More aerobic work'. */
    label: { type: String },
    directive: { type: String, required: true },
    rationale: { type: String },
    /** Activity types this directive points towards, and any it warns off. */
    favour: [{ type: String }],
    avoid: [{ type: String }],
}, { _id: false });

const ActivityPlanSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true,
        index: true,
    },

    /**
     * The weekly targets the dashboard's goal card measures against.
     *
     * Weekly, not daily, because that is the unit exercise guidance is written in — "150
     * minutes of moderate activity a week" is the standard form, and a daily target derived
     * from it would mark someone as failing on a rest day they were right to take.
     */
    targets: {
        sessions: { type: Number, required: true, min: 0 },
        minutes: { type: Number, required: true, min: 0 },
        distanceKm: { type: Number, default: null },
        calories: { type: Number, default: null },
    },

    /** How the numbers were arrived at. Rendered verbatim by `explain()`. */
    basis: {
        method: { type: String, enum: ['guideline', 'user'] },
        /** The starting point before guidance was applied, for the explainer. */
        baseMinutes: { type: Number },
        baseSessions: { type: Number },
        activity: { type: String },
        appliedKeys: [{ type: String }],
    },

    guidance: [GuidanceSchema],
    guidanceSyncedAt: { type: Date },

    /**
     * Targets the person set themselves. Null means "follow the plan".
     *
     * Kept separate from `targets` so a later recalculation preserves their number instead
     * of silently overwriting it, and so the explainer can say which figures are theirs.
     */
    overrides: {
        sessions: { type: Number, default: null },
        minutes: { type: Number, default: null },
        distanceKm: { type: Number, default: null },
        calories: { type: Number, default: null },
    },

    /** The onboarding answers, frames 1 to 4 of the design. */
    preferences: {
        /** Activity types they said they enjoy. Used to bias suggestions, never targets. */
        types: [{ type: String }],
        timeOfDay: { type: String, enum: ['morning', 'afternoon', 'evening', null], default: null },
        typicalMinutes: { type: Number, default: null },
        /**
         * The 1–5 gauge, Lazy to Athletic. Self-reported, and used only as the starting
         * point before guidance is applied — never to adjust the score, which would let
         * someone improve their number by re-answering a question.
         */
        selfRatedLevel: { type: Number, min: 1, max: 5, default: null },
    },

    /** True once the person has been through onboarding, so it is not offered again. */
    onboarded: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model('ActivityPlan', ActivityPlanSchema);
