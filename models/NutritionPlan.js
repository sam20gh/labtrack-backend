const mongoose = require('mongoose');

/**
 * One person's daily nutrition targets, and the plan advice those targets encode.
 *
 * Deliberately its own collection rather than `User.healthAssessment.nutritionGoals`, which
 * already exists and holds a bare set of numbers. That field cannot record *why* a target
 * is what it is, and the whole point of this feature is that the tracker enforces the
 * health plan rather than a number the user typed once. `guidance[]` is that link: it is
 * derived from the person's `PlanItem`s where `type: 'lifestyle'` and `condition: 'diet'`,
 * so when a new interpretation changes the dietary advice, the tracker changes with it.
 *
 * `nutritionGoals` on the user document is left alone. Nothing reads it, and migrating it
 * would touch the health-assessment write path for no gain.
 */

/**
 * One directive taken from the plan.
 *
 * `directive` is the recommendation as the interpretation actually worded it — that exact
 * sentence is what the person is shown and what goes into the meal-analysis prompt.
 * Paraphrasing clinical advice on the way through is how a tracker ends up coaching
 * something the plan never said.
 */
const GuidanceSchema = new mongoose.Schema({
    /** The PlanItem this came from, so the tracker can link back to the plan. */
    planItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlanItem' },
    /** Matched key from `nutritionTargets.GUIDANCE_SHIFTS`, or 'other' when unrecognised. */
    key: { type: String, required: true },
    kind: { type: String, enum: ['pattern', 'emphasise', 'reduce', 'other'], default: 'other' },
    /** Short chip label, e.g. 'Mediterranean'. */
    label: { type: String },
    directive: { type: String, required: true },
    rationale: { type: String },
    emphasise: [{ type: String }],
    reduce: [{ type: String }],
}, { _id: false });

const NutritionPlanSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true,
        index: true,
    },

    targets: {
        calories: { type: Number, required: true },
        protein: { type: Number },
        carbs: { type: Number },
        fat: { type: Number },
        /** Reserved. The hydration UI lives in the Home section of the design, not here. */
        water: { type: Number, default: null },
    },

    /** Fraction of energy per macro, kept so the setup screen can show the shape of the day. */
    split: {
        protein: { type: Number },
        carbs: { type: Number },
        fat: { type: Number },
    },

    /** How the calorie figure was arrived at. Rendered verbatim by `explain()`. */
    basis: {
        method: { type: String, enum: ['mifflin_st_jeor', 'user'] },
        bmr: { type: Number },
        activity: { type: String },
        activityFactor: { type: Number },
        calories: { type: Number },
    },

    guidance: [GuidanceSchema],

    /**
     * Whether the person overrode the computed calorie figure. Kept separate from
     * `basis.method` so a later recalculation knows to preserve their number.
     */
    calorieOverride: { type: Number, default: null },

    /** Frame 359 in the design: how many times a day they eat. Drives meal-slot prompts. */
    mealsPerDay: { type: Number, default: 3, min: 1, max: 8 },

    /** Multi-select from setup, e.g. ['vegetarian', 'halal', 'gluten_free']. */
    dietaryPreferences: [{ type: String }],

    /**
     * Free text the person wrote about their own eating, e.g. a severe peanut allergy.
     * Passed to the analyser verbatim: an allergy stated here must never be suggested as a
     * swap, and only the person's own words are reliable enough to hold that line.
     */
    notes: { type: String },

    /** Snapshot of `healthAssessment.allergies` at derivation time, food entries only. */
    allergies: [{ type: String }],

    /** Set when guidance was last rebuilt from the plan, so staleness is visible. */
    guidanceSyncedAt: { type: Date },
}, { timestamps: true });

module.exports = mongoose.model('NutritionPlan', NutritionPlanSchema);
