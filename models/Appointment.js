const mongoose = require('mongoose');

/**
 * A booked consultation between a user and a professional.
 *
 * Backs the "Book" action on urgent plan items, which until now had no handler and no
 * model behind it.
 */
const AppointmentSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    professionalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Professional', required: true, index: true },
    /** The plan item being fulfilled, when booked from the timeline. */
    planItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlanItem' },

    scheduledFor: { type: Date, required: true, index: true },
    durationMinutes: { type: Number, default: 30 },

    mode: { type: String, enum: ['video', 'phone', 'in_person'], default: 'video' },

    status: {
        type: String,
        enum: ['requested', 'confirmed', 'cancelled', 'completed', 'no_show'],
        default: 'requested',
        index: true,
    },

    /** Snapshot: the professional's rate may change after booking. */
    priceAtBooking: { type: Number },
    currency: { type: String, default: 'GBP' },

    reasonForVisit: { type: String },
    /** Written by the professional after the consultation. */
    outcomeNotes: { type: String },

    cancelledBy: { type: String, enum: ['user', 'professional', 'system'] },
    cancellationReason: { type: String },
}, { timestamps: true });

// A professional's diary, and the reminder sweep
AppointmentSchema.index({ professionalId: 1, scheduledFor: 1 });
AppointmentSchema.index({ userId: 1, scheduledFor: -1 });

module.exports = mongoose.model('Appointment', AppointmentSchema);
