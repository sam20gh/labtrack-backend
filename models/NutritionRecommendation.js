const mongoose = require('mongoose');

/**
 * A set of meal suggestions, as it was shown to one person.
 *
 * Append-only and cached by `signature`, like `Interpretation` and `MedicationCheck`. Two
 * reasons, and the second is the one that matters:
 *
 *   - A model call per dashboard load is a cost nobody agreed to.
 *   - Six different meals every time the screen opens reads as an app with no opinion.
 *     `nutritionRecommender.signatureFor` buckets the volatile inputs precisely so the set
 *     holds still until something about the person's day actually changed.
 *
 * Rows are never rewritten. What someone was shown on Tuesday stays what they were shown on
 * Tuesday, the same rule `MealLog.analysis` follows.
 */
const SuggestionSchema = new mongoose.Schema({
    name: { type: String, required: true },
    mealType: { type: String, enum: ['breakfast', 'lunch', 'dinner', 'snack'], default: 'lunch' },
    /** Addressed to the person, naming the guidance it serves. Shown verbatim. */
    why: { type: String },
    /**
     * Every significant ingredient. Not decoration: `nutritionSafety.screen()` reads this
     * to decide whether the suggestion may be shown, and the detail screen lists it so the
     * person can check for themselves.
     */
    ingredients: [{ type: String }],
    tags: [{ type: String }],
    prepMinutes: { type: Number },

    calories: { type: Number, required: true, min: 0 },
    protein: { type: Number, default: 0, min: 0 },
    carbs: { type: Number, default: 0, min: 0 },
    fat: { type: Number, default: 0, min: 0 },
    fibre: { type: Number, min: 0 },

    /** Which `NutritionPlan.guidance[].key` values this serves. Empty when ungrounded. */
    guidanceKeys: [{ type: String }],
}, { _id: false });

const NutritionRecommendationSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** Local `YYYY-MM-DD` the set was generated for, matching `MealLog.day`. */
    day: { type: String, required: true },

    /** `nutritionRecommender.signatureFor()` — what this set was generated against. */
    signature: { type: String, required: true },

    headline: { type: String },
    suggestions: [SuggestionSchema],

    /**
     * Whether the person's health plan actually had dietary advice behind this.
     *
     * False means the set is ordinary balanced-eating advice, and the client says so. A
     * tracker whose claim is that it enforces the health plan must not let generic
     * suggestions borrow the plan's authority — the distinction
     * `alignment: 'unassessed'` makes, one screen along.
     */
    grounded: { type: Boolean, default: false },

    /** How many suggestions the safety screen removed. Kept so a prompt regression is visible. */
    droppedCount: { type: Number, default: 0 },

    model: { type: String },
}, { timestamps: true });

// The cache lookup, and the newest-first read behind it
NutritionRecommendationSchema.index({ userId: 1, signature: 1, createdAt: -1 });

module.exports = mongoose.model('NutritionRecommendation', NutritionRecommendationSchema);
