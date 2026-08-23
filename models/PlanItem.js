const mongoose = require('mongoose');

/**
 * One actionable item on a user's health plan: a test to take, a scan to book, a
 * specialist to see.
 *
 * Replaces the embedded `Plan.plan[]` array. Items need to be queried by due date across
 * all users (the reminder job), transitioned individually (ordered → completed), and linked
 * to the order or appointment that fulfilled them. None of that is practical inside a
 * subdocument array.
 *
 * `dueDate` is a real date, not the old `age`/`year` pair, so "overdue" is a date
 * comparison rather than arithmetic against a birth year.
 */
const PlanItemSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', index: true },

    type: {
        type: String,
        enum: ['test', 'scan', 'consultation', 'assessment', 'lifestyle'],
        required: true,
    },

    /** Human-readable label, e.g. 'PSA Test' or 'Consult an Oncologist'. */
    title: { type: String, required: true },
    description: { type: String },

    /** Clinical driver, e.g. 'Prostate Cancer' or a gene from the DNA report. */
    condition: { type: String },
    /** e.g. 'Annually', 'Once'. Drives generation of the next occurrence on completion. */
    frequency: { type: String },

    dueDate: { type: Date, required: true, index: true },

    /**
     * `due` and `urgent` are derived from dueDate by the daily status job, not set by hand.
     * Keeping them stored (rather than computed per request) lets the reminder job and the
     * timeline query use the same index.
     */
    status: {
        type: String,
        enum: ['upcoming', 'due', 'urgent', 'ordered', 'booked', 'completed', 'dismissed'],
        default: 'upcoming',
        index: true,
    },

    urgency: { type: String, enum: ['low', 'moderate', 'high'], default: 'moderate' },

    /** Who ordered this — an AI interpretation or a human professional. */
    source: {
        type: String,
        enum: ['ai', 'specialist', 'user', 'system'],
        default: 'ai',
    },
    sourceDnaReportId: { type: mongoose.Schema.Types.ObjectId, ref: 'DnaReport' },
    sourceTestResultId: { type: mongoose.Schema.Types.ObjectId, ref: 'TestResult' },
    /** Set when a professional added or amended the item. */
    orderedByProfessionalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Professional' },

    // Fulfilment links — how the user acts on this item
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    productName: { type: String },
    professionalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Professional' },
    professionalName: { type: String },
    speciality: { type: String },
    image: { type: String, default: null },

    /** Populated when the item is acted on, closing the loop back to results. */
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
    resultingTestResultId: { type: mongoose.Schema.Types.ObjectId, ref: 'TestResult' },
    completedAt: { type: Date },

    reminder: {
        enabled: { type: Boolean, default: true },
        /** Days before dueDate to notify. */
        offsetDays: { type: [Number], default: [7, 0] },
        /** Offsets already sent, so the job never double-notifies. */
        sentOffsets: { type: [Number], default: [] },
        lastSentAt: { type: Date },
    },
}, { timestamps: true });

// Reminder + status sweep: "everything due on or before today that is still open"
PlanItemSchema.index({ status: 1, dueDate: 1 });
// The user's timeline
PlanItemSchema.index({ userId: 1, dueDate: 1 });

/** Status implied by the due date alone, for the daily sweep. */
PlanItemSchema.statics.deriveStatus = function (dueDate, now = new Date()) {
    const due = new Date(dueDate);
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (due < startOfToday) return 'urgent';
    if (due.getTime() === startOfToday.getTime()) return 'due';
    return 'upcoming';
};

/** Terminal or user-driven states the daily sweep must not overwrite. */
PlanItemSchema.statics.MUTABLE_STATUSES = ['upcoming', 'due', 'urgent'];

module.exports = mongoose.model('PlanItem', PlanItemSchema);
