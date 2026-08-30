const mongoose = require('mongoose');

/**
 * A stored interaction check.
 *
 * Append-only, like `Interpretation`, and for the same reason: this is clinical output a
 * person read and may have acted on. If they raised a finding with their pharmacist and it
 * later disappears because the catalogue was corrected, neither of them can reconstruct what
 * was actually on the screen that day.
 *
 * A check is written when the medication list changes, not on every view. `getLatestCheck`
 * serves the stored one and reports `stale: true` when the list has moved on since, so the
 * client can offer to re-run rather than silently showing an answer about a different set of
 * medicines.
 */

const FindingSchema = new mongoose.Schema({
    /** The rule id, or `model-<pair>` for one the model added. */
    id: { type: String },
    kind: { type: String, enum: ['drug', 'food', 'condition', 'timing', 'duplicate'], default: 'drug' },
    severity: { type: String, enum: ['severe', 'moderate', 'mild'], required: true },
    /**
     * Which half of the system produced this.
     *
     * `rule` came from the deterministic table in `medicationCatalogue` and is reproducible.
     * `model` was added by Claude and could not be reproduced exactly. The client labels them
     * differently — a person deciding whether to ring their pharmacy is entitled to know
     * which kind of statement they are reading.
     */
    source: { type: String, enum: ['rule', 'model'], default: 'rule' },
    /** The two things this is between, named as the person named them. */
    between: [{ type: String }],
    effect: { type: String },
    action: { type: String },
}, { _id: false });

const MedicationCheckSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /**
     * The medication names this check covered, sorted. Comparing this against the current
     * list is how `stale` is determined — cheaper and more honest than a timestamp, which
     * would call a check stale after an unrelated dose was logged.
     */
    medicationNames: [{ type: String }],

    summary: { type: String },
    findings: [FindingSchema],

    /**
     * Medicines the catalogue could not classify, by name.
     *
     * Rendered, never hidden. These were not tested against anything, and a check that shows
     * findings without saying what it could not look at implies a completeness it does not
     * have. This is the field that keeps "nothing found" from reading as "nothing there".
     */
    uncheckable: [{ type: String }],
    /** How many medicines the rules could actually be run against. */
    checkedCount: { type: Number, default: 0 },

    timingAdvice: [{
        medication: { type: String },
        advice: { type: String },
        _id: false,
    }],
    questionsForClinician: [{ type: String }],

    /** Worst severity present, or null. Never means "safe" — see `SAFETY_FOOTER`. */
    worstSeverity: { type: String, enum: ['severe', 'moderate', 'mild', null], default: null },

    /**
     * True when the check ran on rules alone because no model was available. The rule table
     * is the part that catches the dangerous pairs and needs no API key, so a degraded check
     * is still worth running and worth storing — it is just labelled as one.
     */
    degraded: { type: Boolean, default: false },
    model: { type: String, default: null },

    generatedAt: { type: Date, default: Date.now, index: true },
}, { timestamps: true });

// The latest check for one person
MedicationCheckSchema.index({ userId: 1, generatedAt: -1 });

module.exports = mongoose.model('MedicationCheck', MedicationCheckSchema);
