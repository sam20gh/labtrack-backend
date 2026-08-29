const mongoose = require('mongoose');

/**
 * One person's sleep goal and the plan advice behind it.
 *
 * Created in phase 11.1 rather than 11.3 because every night's score is computed against
 * `goalMinutes` at ingest time, so the goal has to exist before the first sync writes a
 * score. The screens that let someone set it arrive with the rest of the sleep feature.
 *
 * `guidance[]` mirrors `NutritionPlan.guidance[]` and is derived, on read, from the
 * person's `PlanItem`s where `type: 'lifestyle'` and `condition: 'sleep'` — the sleep
 * directives an interpretation already emits today. It is never written directly by
 * `PUT /plan`: the health plan is the source of truth, and a tracker that lets someone
 * overwrite their own clinical advice is not a tracker of that advice.
 */

/** One sleep directive taken from the plan, worded exactly as the interpretation wrote it. */
const GuidanceSchema = new mongoose.Schema({
    planItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlanItem' },
    /** Matched key from `sleepTargets.SLEEP_SHIFTS`, or 'other' when unrecognised. */
    key: { type: String, required: true },
    label: { type: String },
    directive: { type: String, required: true },
    rationale: { type: String },
}, { _id: false });

const SleepPlanSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true,
        index: true,
    },

    /** The nightly target, in minutes. The design's dial writes it as "8h 30m". */
    goalMinutes: { type: Number, default: 480, min: 180, max: 840 },

    /**
     * The windows from onboarding frames 3 and 4 — "10:00PM – 12:30AM" and
     * "6:30AM – 8:35AM" — stored as minutes from local midnight.
     *
     * A range rather than a time because that is what the screen asks for: people do not go
     * to bed at a fixed instant, and a schedule built on one produces a reminder that is
     * wrong six nights out of seven.
     */
    bedtimeWindow: {
        fromMin: { type: Number, default: null },
        toMin: { type: Number, default: null },
    },
    wakeWindow: {
        fromMin: { type: Number, default: null },
        toMin: { type: Number, default: null },
    },

    /**
     * The onboarding slider: how easily their sleep is disturbed. 1 (light) to 5 (deep).
     * Self-reported, and used only as context for the insight prompt — never to adjust the
     * score, which would let someone improve their number by re-answering a question.
     */
    selfRatedDepth: { type: Number, min: 1, max: 5, default: null },

    /** Typical hours the person reported before any data existed. Onboarding frame 2. */
    reportedAverageHours: { type: Number, default: null },

    guidance: [GuidanceSchema],
    guidanceSyncedAt: { type: Date },

    /** Set when the person picked the goal themselves rather than accepting the suggestion. */
    goalSetByUser: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model('SleepPlan', SleepPlanSchema);
