const mongoose = require('mongoose');

/**
 * A lab report belonging to a user.
 *
 * `results` remains a free-form object holding whatever the report contained; the
 * structured, queryable view of the same data lives in the Biomarker collection, which is
 * what trends and range-flagging read. Keeping both means a parse can be re-run from the
 * original without another upload.
 */
const TestResultSchema = new mongoose.Schema({
    patient: {
        user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        /**
         * Stored as a Date so sorting and date arithmetic are correct. Previously a String,
         * which sorted lexicographically — '9/1/2025' sorted after '10/1/2025'.
         * Mongoose casts ISO strings on write, so existing clients keep working.
         */
        date_of_test: { type: Date, required: true },
        lab_name: { type: String, required: true },
        test_type: { type: String, required: true },
    },

    /** Raw values as reported. Shape varies by lab and panel. */
    results: { type: Object, required: true },
    interpretation: { type: String },

    /** Uploaded PDF or photo this result was parsed from. */
    documentUrl: { type: String },

    /** How the data got here — drives whether values need user confirmation. */
    source: {
        type: String,
        enum: ['manual_entry', 'document_upload', 'lab_integration', 'imported'],
        default: 'manual_entry',
    },

    parseStatus: {
        type: String,
        enum: ['not_parsed', 'parsing', 'parsed', 'needs_review', 'failed'],
        default: 'not_parsed',
    },
    /** How many Biomarker documents this result produced. */
    biomarkerCount: { type: Number, default: 0 },

    /** Set when this result fulfils a home-collection order. */
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    planItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlanItem' },
}, { timestamps: true });

// Every list view is "this user's results, newest first"
TestResultSchema.index({ 'patient.user_id': 1, 'patient.date_of_test': -1 });

module.exports = mongoose.model('TestResult', TestResultSchema);
