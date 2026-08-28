const mongoose = require('mongoose');

/**
 * One meal a person logged.
 *
 * Its own collection, not an array on the user document. `User.healthAssessment
 * .nutritionHistory` already models something like this and is the same mistake
 * `Plan.plan[]` was: three meals a day is roughly a thousand subdocuments a year inside a
 * document that every authenticated request loads. Meals also need to be queried by date
 * range across users and deleted individually, neither of which a subdocument array does
 * well.
 */

/** A component of the meal, as identified. Kept so a user can correct one item, not the lot. */
const MealItemSchema = new mongoose.Schema({
    name: { type: String, required: true },
    quantity: { type: String },
    calories: { type: Number },
    protein: { type: Number },
    carbs: { type: Number },
    fat: { type: Number },
}, { _id: false });

/**
 * The analyser's read on this meal against the person's plan.
 *
 * Stored rather than recomputed because it is what the person was actually shown. If the
 * plan's dietary advice changes next month, the coaching they saw on a meal last week
 * should not silently rewrite itself.
 */
const AnalysisSchema = new mongoose.Schema({
    /** 0-1. Below the analyser's threshold the user is asked to confirm before saving. */
    confidence: { type: Number },
    /**
     * How this meal sits against the plan's dietary guidance.
     * `unassessed` is used when the person has no diet guidance to be measured against —
     * which is different from being off plan, and must not be shown as a failure.
     */
    alignment: {
        type: String,
        enum: ['aligned', 'partial', 'off_plan', 'unassessed'],
        default: 'unassessed',
    },
    /** One or two sentences, addressed to the person, naming the guidance it relates to. */
    rationale: { type: String },
    /** Which guidance keys this meal was judged against. */
    guidanceKeys: [{ type: String }],
    /** The design's swap card: a plan-aligned alternative for a similar occasion. */
    swap: {
        name: { type: String },
        why: { type: String },
        calories: { type: Number },
        protein: { type: Number },
        carbs: { type: Number },
        fat: { type: Number },
    },
    model: { type: String },
}, { _id: false });

const MealLogSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /**
     * When the meal was eaten, not when it was logged. A meal logged at midnight for the
     * previous evening belongs to that day's totals.
     */
    eatenAt: { type: Date, required: true, index: true },

    /**
     * Local calendar day as `YYYY-MM-DD`, written by the controller from the client's
     * offset. Daily totals are a calendar question, and grouping by UTC date puts an 8pm
     * meal in Los Angeles on the following day.
     */
    day: { type: String, required: true, index: true },

    mealType: {
        type: String,
        enum: ['breakfast', 'lunch', 'dinner', 'snack'],
        default: 'snack',
    },

    name: { type: String, required: true },
    servings: { type: Number, default: 1, min: 0.1 },

    calories: { type: Number, required: true, min: 0 },
    protein: { type: Number, default: 0, min: 0 },
    carbs: { type: Number, default: 0, min: 0 },
    fat: { type: Number, default: 0, min: 0 },
    fibre: { type: Number, min: 0 },
    /** Milligrams. Present only when the analyser could estimate it. */
    sodium: { type: Number, min: 0 },

    items: [MealItemSchema],

    /** How it got here. `photo` and `description` were AI-estimated; `manual` was typed. */
    source: {
        type: String,
        enum: ['photo', 'description', 'manual', 'swap'],
        default: 'manual',
    },
    imageUrl: { type: String, default: null },

    analysis: { type: AnalysisSchema, default: undefined },

    /**
     * True once the person has seen the estimate and saved it. Everything reaching this
     * collection is confirmed — the analyser's output is returned to the client for review
     * and never written directly, the same checkpoint report ingestion uses.
     */
    confirmed: { type: Boolean, default: true },
}, { timestamps: true });

// The dashboard: one person's meals for one day
MealLogSchema.index({ userId: 1, day: 1 });
// The history/insights screen: a date range for one person
MealLogSchema.index({ userId: 1, eatenAt: -1 });

module.exports = mongoose.model('MealLog', MealLogSchema);
