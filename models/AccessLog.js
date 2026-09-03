const mongoose = require('mongoose');

/**
 * Who looked at whose medical record, and when.
 *
 * Every other protection in this API assumes `requireSelf` — that a caller only ever
 * reaches their own data. The clinician workspace deliberately breaks that assumption, and
 * "who viewed this record" is the first question an information-governance review asks.
 * Until this collection existed, the honest answer was that nobody knew: reads left no
 * trace at all, only writes did.
 *
 * **This collection holds identifiers, never content.** It records that a clinician opened
 * an interpretation, not what the interpretation said. An audit trail that copies the
 * record it is auditing doubles the amount of special-category data to protect, and becomes
 * the easier of the two to steal.
 */
const AccessLogSchema = new mongoose.Schema({
    /** The clinician or administrator who performed the read. */
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /**
     * Denormalised so the log stays readable after an account is renamed or removed. An
     * audit entry pointing at a deleted user is not an audit entry.
     */
    actorEmail: { type: String },
    actorRole: { type: String, enum: ['professional', 'admin'], required: true },

    /** Whose record was read. Null only for a listing that names no single patient. */
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },

    /** What kind of thing was read. */
    resource: {
        type: String,
        required: true,
        enum: [
            'queue', 'interpretation', 'patient_context', 'biomarkers', 'plan',
            'review_history', 'appointments',
            /**
             * Reading the audit trail is itself audited. An administrator who can see every
             * clinician's reads is the one account with no other check on it, so the export
             * and the viewer write entries of their own — with a count, never the rows.
             */
            'access_log',
        ],
        index: true,
    },
    /** The specific document, where the read addressed one. */
    resourceId: { type: mongoose.Schema.Types.ObjectId },

    /**
     * Reads only, for now. `submitReview` already writes an entry to
     * `Interpretation.review.edits[]`, which is a better record of a change than this could
     * be — it holds the before and after. The gap this fills is reads.
     */
    action: { type: String, enum: ['read'], default: 'read' },

    /** How many records a listing returned, so a bulk read is distinguishable from one. */
    count: { type: Number },

    at: { type: Date, default: Date.now, index: true },
}, {
    // `at` is the timestamp; `updatedAt` on an append-only log would be misleading, since
    // nothing here is ever updated.
    timestamps: false,
});

// "Everything this clinician looked at", and "everyone who looked at this patient" — the
// two questions the log exists to answer.
AccessLogSchema.index({ actorId: 1, at: -1 });
AccessLogSchema.index({ patientId: 1, at: -1 });

module.exports = mongoose.model('AccessLog', AccessLogSchema);
