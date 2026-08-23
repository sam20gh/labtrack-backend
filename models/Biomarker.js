const mongoose = require('mongoose');

/**
 * One measurement of one biomarker at one point in time.
 *
 * This is the time-series backbone: "is my iron going up or down, and is that OK for me?"
 * is answered by querying this collection, not by re-reading report documents. One document
 * per measurement (never an array on TestResult) so that trends, ranges, and flags can be
 * queried and indexed directly.
 *
 * `name` is the canonical key (lowercase, no spaces) — different labs print "Ferritin",
 * "FERRITIN", and "Serum ferritin" for the same analyte, and a trend line is only possible
 * if they normalise to one key. `displayName` keeps whatever the report actually said.
 */
const BiomarkerSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** Canonical key, e.g. 'ferritin', 'hba1c', 'ldl_cholesterol'. Always lowercase. */
    name: { type: String, required: true, lowercase: true, trim: true },
    /** Name exactly as printed on the report, for display and traceability. */
    displayName: { type: String },

    value: { type: Number, required: true },
    /**
     * Canonical unit for this analyte, e.g. 'ng/mL', 'mmol/L', '%'.
     *
     * NOT required: real reports contain analytes outside our catalogue, and calculated
     * rows (ratios, indices) often print no unit at all. Such a measurement is stored with
     * `flag: 'unknown'` and `needsReview: true` and is never range-evaluated, so an empty
     * unit is honest rather than dangerous — whereas rejecting it discarded the entire
     * report over one row.
     */
    unit: { type: String, default: '' },

    measuredAt: { type: Date, required: true },

    // Provenance — every value must be traceable to the document it came from
    testResultId: { type: mongoose.Schema.Types.ObjectId, ref: 'TestResult' },
    source: {
        type: String,
        enum: ['lab_report', 'manual_entry', 'device', 'imported'],
        default: 'lab_report',
    },

    /**
     * Evaluation against the user's personal range at the time of insert.
     * `unknown` means no ReferenceRange matched — the value is still stored and trended.
     */
    flag: {
        type: String,
        enum: ['critical_low', 'low', 'normal', 'high', 'critical_high', 'unknown'],
        default: 'unknown',
    },

    /**
     * Snapshot of the range used to produce `flag`. Reference ranges are revised over time
     * and can be gene-adjusted per user; without a snapshot an old flag becomes impossible
     * to explain or reproduce.
     */
    appliedRange: {
        min: { type: Number },
        max: { type: Number },
        unit: { type: String },
        referenceRangeId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReferenceRange' },
        geneAdjusted: { type: Boolean, default: false },
    },

    /** Range the lab itself printed, when available — useful when ours is missing. */
    reportedRange: {
        min: { type: Number },
        max: { type: Number },
        raw: { type: String },
    },

    /** Set when a value was extracted by a model and needs user confirmation. */
    needsReview: { type: Boolean, default: false },
    extractionConfidence: { type: Number, min: 0, max: 1 },

    notes: { type: String },
}, { timestamps: true });

// Trend queries: every chart is "this user, this biomarker, newest first"
BiomarkerSchema.index({ userId: 1, name: 1, measuredAt: -1 });
// Dashboards showing out-of-range values across all analytes
BiomarkerSchema.index({ userId: 1, flag: 1, measuredAt: -1 });
// Re-parsing or deleting everything that came from one report
BiomarkerSchema.index({ testResultId: 1 });

module.exports = mongoose.model('Biomarker', BiomarkerSchema);
