const mongoose = require('mongoose');

/**
 * A genetic test result and its interpretation.
 *
 * This is the entry point of the whole product: mutations found here drive the screening
 * schedule, adjust biomarker reference ranges, and determine which specialists a user is
 * pointed at.
 *
 * `status` encodes the review pipeline. AI output is never presented as clinical advice —
 * it sits at `ai_interpreted` until a professional signs it off, and the app is expected to
 * label the difference. `specialistReview.edits` preserves what the AI said alongside what
 * the professional changed it to, because "the AI got this wrong and a doctor corrected it"
 * is exactly the audit trail a medical product needs.
 */
const MutationSchema = new mongoose.Schema({
    gene: { type: String, required: true, uppercase: true, trim: true },
    /** e.g. 'c.5266dupC', or an rsID when that is all the lab reports. */
    variant: { type: String },
    rsid: { type: String },
    zygosity: { type: String, enum: ['heterozygous', 'homozygous', 'hemizygous', 'unknown'], default: 'unknown' },

    /** ACMG classification. `vus` = variant of uncertain significance. */
    significance: {
        type: String,
        enum: ['pathogenic', 'likely_pathogenic', 'vus', 'likely_benign', 'benign', 'unknown'],
        default: 'unknown',
    },

    /** Condition this variant is associated with, e.g. 'Hereditary Breast and Ovarian Cancer'. */
    condition: { type: String },
    /** Free-text detail from the lab report. */
    notes: { type: String },
}, { _id: true });

const DnaReportSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    labName: { type: String },
    reportDate: { type: Date },
    /** Uploaded PDF/image of the original report. */
    documentUrl: { type: String },
    /** Set when the report arrived via a LabTrack order. */
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },

    mutations: [MutationSchema],

    status: {
        type: String,
        enum: ['uploaded', 'parsing', 'ai_interpreted', 'specialist_reviewed', 'failed'],
        default: 'uploaded',
        index: true,
    },

    /**
     * @deprecated Superseded by the `Interpretation` collection (Phase 6, 2026-08-25).
     *
     * No longer written or read. It held a second copy of the interpretation, and because
     * clinician amendments landed here while the patient-facing read looked elsewhere, a
     * correction could never reach the person it was about. Historic values are left in
     * place as an archive; `Interpretation.amended` is the authoritative version.
     */
    aiInterpretation: {
        summary: { type: String },
        risks: [{
            condition: { type: String },
            level: { type: String, enum: ['low', 'moderate', 'high', 'unknown'], default: 'unknown' },
            rationale: { type: String },
        }],
        /** Raw structured output, kept for reprocessing without a new model call. */
        raw: { type: Object },
        model: { type: String },
        generatedAt: { type: Date },
    },

    specialistReview: {
        professionalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Professional' },
        reviewedAt: { type: Date },
        approved: { type: Boolean },
        notes: { type: String },
        /** Field-level record of what the professional changed and why. */
        edits: [{
            field: { type: String },
            previous: { type: mongoose.Schema.Types.Mixed },
            updated: { type: mongoose.Schema.Types.Mixed },
            reason: { type: String },
        }],
    },

    /** Set when parsing or interpretation failed, so the UI can explain the failure. */
    failureReason: { type: String },
}, { timestamps: true });

// Review queue: oldest pending interpretations first
DnaReportSchema.index({ status: 1, createdAt: 1 });
DnaReportSchema.index({ userId: 1, createdAt: -1 });

/** True once a professional has signed the interpretation off. */
DnaReportSchema.virtual('isClinicallyReviewed').get(function () {
    return this.status === 'specialist_reviewed' && this.specialistReview?.approved === true;
});

DnaReportSchema.set('toJSON', { virtuals: true });
DnaReportSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('DnaReport', DnaReportSchema);
