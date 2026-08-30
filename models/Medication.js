const mongoose = require('mongoose');

/**
 * One medicine on a person's list.
 *
 * Its own collection, not an array on the user document. `User.healthAssessment.medications`
 * already models something like this and stays where it is — see the note at the bottom of
 * this file for why the two coexist and which one is authoritative.
 *
 * A medication carries the *rule* (what, how much, how often); `MedicationDose` carries the
 * occurrences. Keeping the two apart is what lets someone change an evening dose to 8pm
 * without rewriting whether they took last Tuesday's.
 */

/** What the scan produced, kept so the person can see why we thought this was the drug. */
const IdentificationSchema = new mongoose.Schema({
    /** 0-1. Below `medicationEngine.CONFIDENCE_THRESHOLD` the client made them confirm. */
    confidence: { type: Number },
    /** One sentence naming what the identification rested on. */
    basis: { type: String },
    surface: { type: String },
    /** Other drugs it could have been. Retained: a wrong identification is discoverable later. */
    alternatives: [{
        name: { type: String },
        why: { type: String },
        _id: false,
    }],
    warnings: [{ type: String }],
    model: { type: String },
}, { _id: false });

const MedicationSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /**
     * The active ingredient, lowercased, as the catalogue keys it. `medicationCatalogue
     * .lookup` resolves brand names onto this, so an interaction rule fires whether the
     * person typed "Lipitor" or "atorvastatin".
     */
    name: { type: String, required: true, trim: true },
    /** As printed on their box. Shown alongside the generic name, never instead of it. */
    brandName: { type: String, default: null, trim: true },
    /** Exactly as printed, with its unit: "20mg". A string, because "2.5mg/5ml" is real. */
    strength: { type: String, default: null, trim: true },

    form: {
        type: String,
        enum: ['tablet', 'capsule', 'liquid', 'injection', 'inhaler', 'patch', 'drops', 'cream', 'other'],
        default: 'tablet',
    },

    /**
     * Appearance. The design lets people pick a shape and colour so a row is recognisable at
     * a glance in a list of six white tablets — this is a visual aid, never an identifier.
     */
    shape: {
        type: String,
        enum: ['round', 'oval', 'oblong', 'capsule', 'square', 'triangle', 'diamond', 'pentagon',
            'hexagon', 'teardrop', 'shield', 'trapezoid', 'long', 'rectangle', 'circle', 'other', null],
        default: null,
    },
    /** Hex, from the design's swatch row. */
    colour: { type: String, default: null },
    /** Letters or numbers stamped on the tablet, transcribed from the scan or typed. */
    imprint: { type: String, default: null, trim: true },

    // ── Schedule ──────────────────────────────────────────────────────────────────────

    frequency: {
        type: String,
        enum: ['once', 'daily', 'twice_daily', 'three_times_daily', 'weekly', 'specific_days', 'as_needed'],
        default: 'daily',
    },
    /** Clock times, `HH:mm`, 24h. Empty falls back to `medicationSchedule.DEFAULT_TIMES`. */
    times: [{ type: String }],
    /** 0 = Sunday. Only read when `frequency` is `specific_days`. */
    daysOfWeek: [{ type: Number, min: 0, max: 6 }],
    /** Every N days. 1 or absent means every day the frequency otherwise allows. */
    intervalDays: { type: Number, min: 1, default: 1 },

    /**
     * Local calendar days, `YYYY-MM-DD`. Not Dates: a course that runs "to the 27th" runs to
     * the 27th wherever the person is, and a Date drags a timezone into a calendar question.
     */
    startDay: { type: String, required: true },
    endDay: { type: String, default: null },

    /** Minutes west of UTC when this was set up, so a dose lands at the right local hour. */
    tzOffset: { type: Number, default: 0 },

    /** How much is taken each time — "1 tablet", "10ml". Free text, because labels vary. */
    dose: { type: String, default: null, trim: true },
    /** The design's "Before Meal" / "After Meal" chip. */
    withFood: {
        type: String,
        enum: ['before_meal', 'with_meal', 'after_meal', 'any', null],
        default: null,
    },

    // ── Supply ────────────────────────────────────────────────────────────────────────

    /** Doses left in the packet. Counted down as doses are taken, when the person set it. */
    remainingDoses: { type: Number, default: null, min: 0 },
    refillReminder: { type: Boolean, default: false },
    /** Prompt a refill at this many doses left. The design's "Refill Threshold" stepper. */
    refillThreshold: { type: Number, default: 12, min: 0 },

    // ── Provenance and state ──────────────────────────────────────────────────────────

    /** How it got onto the list. `scan` went through the camera; `catalogue` was searched. */
    source: {
        type: String,
        enum: ['scan', 'search', 'catalogue', 'manual', 'assessment'],
        default: 'manual',
    },
    identification: { type: IdentificationSchema, default: undefined },
    /** Cloudflare URL of the scan, when there was one. Best-effort — see `imageStore`. */
    imageUrl: { type: String, default: null },

    notes: { type: String, default: null },

    /**
     * Archived rather than deleted when a course ends.
     *
     * Deleting would take the dose history with it, and "what was I on in March" is a
     * question both the person and their clinician ask. `DELETE /medications/:id` archives;
     * only an explicit purge removes the record.
     */
    active: { type: Boolean, default: true, index: true },
    archivedAt: { type: Date, default: null },

    /** Reminders can be silenced without stopping the medication or losing its schedule. */
    remindersEnabled: { type: Boolean, default: true },
}, { timestamps: true });

// The list screen, and the interaction check: one person's current medicines
MedicationSchema.index({ userId: 1, active: 1 });
// The reminder job, which walks medications with reminders on
MedicationSchema.index({ active: 1, remindersEnabled: 1 });

/**
 * ── Why this exists alongside `User.healthAssessment.medications` ─────────────────────
 *
 * The health assessment asks what you take, once, as free text, as part of a 23-screen
 * onboarding questionnaire. It is a snapshot of what someone said in a form.
 *
 * This collection is a living record with a schedule, a dose history, and an interaction
 * check hanging off it. It is authoritative for the medication checker.
 *
 * They are reconciled in one direction only: `medicationController.importFromAssessment`
 * offers to bring assessment entries in as real medications, and the assessment is left
 * untouched. Writing back would let a scan quietly rewrite an answer a clinician may have
 * reviewed, and two records that each edit the other agree about nothing within a month.
 */
module.exports = mongoose.model('Medication', MedicationSchema);
