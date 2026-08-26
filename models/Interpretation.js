/**
 * An interpretation of a person, as of a date.
 *
 * Replaces `AIFeedback`, which keyed one interpretation to one document via `testID`. That
 * was never true: `gatherContext` has always built the prompt from every biomarker, every
 * DNA report and the health assessment, so the output describes the whole person. The
 * mismatch caused three defects — a clinician's amendments landing on `DnaReport` where the
 * patient-facing read never looked, blood-only patients being unreachable by the review
 * queue, and an ambiguous `testID` that had to be probed against two collections.
 *
 * **Append-only.** A regeneration inserts a new document and points `supersedes` at the one
 * before it. That is what makes `changes_since_last` a real diff rather than a prompt
 * instruction, and it means a signed-off interpretation is never mutated after the fact —
 * it is a record that a named clinician made a decision on a named date.
 */
const mongoose = require('mongoose');

/** Which documents this interpretation actually read. */
const SourceRefSchema = new mongoose.Schema({
    kind: { type: String, enum: ['test_result', 'dna_report', 'genotype_file'], required: true },
    // Deliberately not a `ref`: the target collection is named by `kind`, and the old
    // model's single polymorphic ref pointing at a non-existent 'Test' model is exactly
    // the ambiguity this replaces.
    id: { type: mongoose.Schema.Types.ObjectId, required: true },
    date: { type: Date },
}, { _id: false });

/** A field a clinician changed, and why. Mirrors DnaReport.specialistReview.edits. */
const EditSchema = new mongoose.Schema({
    field: { type: String },
    previous: { type: mongoose.Schema.Types.Mixed },
    updated: { type: mongoose.Schema.Types.Mixed },
    reason: { type: String },
}, { _id: false });

const InterpretationSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    generatedAt: { type: Date, default: Date.now, required: true },
    model: { type: String },

    /** Every document that fed the prompt. One interpretation can legitimately cover many. */
    covers: { type: [SourceRefSchema], default: [] },

    /**
     * The structured output, stored as an object rather than the JSON-in-a-String that
     * `AIFeedback.feedback` used — which meant every read had a parse that could throw, and
     * at least one row in the live data does.
     */
    content: { type: Object, required: true },

    /** The interpretation this one replaces, so history is a chain rather than a sort. */
    supersedes: { type: mongoose.Schema.Types.ObjectId, ref: 'Interpretation', default: null },

    review: {
        /**
         * `not_required` exists for the triage rule that policy will grow later; nothing
         * writes it today, because `requiresReview()` currently returns true for everything.
         */
        status: {
            type: String,
            enum: ['pending', 'approved', 'amended', 'not_required'],
            default: 'pending',
            index: true,
        },
        professionalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Professional' },
        reviewedAt: { type: Date },
        notes: { type: String },
        edits: { type: [EditSchema], default: [] },
    },

    /**
     * The clinician's corrected version. Kept beside the original rather than overwriting
     * it: the patient reads this when present, and the original stays available as the
     * record of what the model actually said.
     */
    amended: {
        content: { type: Object },
        at: { type: Date },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'Professional' },
    },

    /** Set by the Phase 3 backfill so migrated rows are distinguishable from native ones. */
    migratedFrom: { type: mongoose.Schema.Types.ObjectId, default: null },
}, { timestamps: true });

// The two queries this model exists to serve: a patient's newest, and the review queue.
InterpretationSchema.index({ userId: 1, generatedAt: -1 });
InterpretationSchema.index({ 'review.status': 1, generatedAt: 1 });
// The backfill is re-runnable because this refuses a second row for the same source.
InterpretationSchema.index(
    { migratedFrom: 1 },
    { unique: true, partialFilterExpression: { migratedFrom: { $type: 'objectId' } } },
);

/** Statuses a clinician has signed. */
InterpretationSchema.statics.SIGNED_STATUSES = ['approved', 'amended'];

module.exports = mongoose.model('Interpretation', InterpretationSchema);
