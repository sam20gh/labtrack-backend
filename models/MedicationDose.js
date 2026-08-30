const mongoose = require('mongoose');

/**
 * One scheduled occurrence of one medication, and what happened to it.
 *
 * Materialised rather than derived. It would be cheaper to compute the timeline from the
 * medication's rule on every read and store only the exceptions, but a dose has state the
 * rule cannot express — taken at 9:14, skipped, moved to Thursday — and state needs a row.
 * More importantly, deriving it means changing a schedule silently rewrites what the person
 * is shown to have taken last month. A medication record is not allowed to edit history.
 *
 * `medicationController.materialise` writes the missing rows for a window when the timeline
 * is read, so the collection stays as small as the days actually looked at.
 */
const MedicationDoseSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    medicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Medication', required: true, index: true },

    /** Local calendar day, `YYYY-MM-DD`. The daily and monthly screens both group on this. */
    day: { type: String, required: true, index: true },
    /** Local clock time, `HH:mm`. */
    time: { type: String, required: true },

    /**
     * The instant this dose is due, resolved with the medication's `tzOffset` at the time it
     * was materialised. Stored so the reminder job can query by time without re-deriving an
     * offset that may since have changed.
     */
    scheduledFor: { type: Date, required: true, index: true },

    status: {
        type: String,
        enum: ['scheduled', 'taken', 'skipped'],
        default: 'scheduled',
        index: true,
    },

    /** When they actually took it. `medicationSchedule.punctuality` reads this against `scheduledFor`. */
    takenAt: { type: Date, default: null },
    /** Present when the person moved this dose. The original time stays in `scheduledFor`. */
    rescheduledTo: { type: Date, default: null },
    /** Their own words, from the log sheet. */
    note: { type: String, default: null },

    /** Denormalised so the timeline renders without a join. Refreshed when the med is edited. */
    medicationName: { type: String },

    /** Set once a reminder has gone out, so a restart cannot double-notify. */
    remindedAt: { type: Date, default: null },
}, { timestamps: true });

/**
 * One medication cannot have two doses at the same instant. This is what makes
 * `materialise` idempotent — it upserts on this key, so re-reading a week never duplicates
 * a row, and two devices opening the timeline at once cannot race.
 */
MedicationDoseSchema.index({ medicationId: 1, scheduledFor: 1 }, { unique: true });
// The daily timeline
MedicationDoseSchema.index({ userId: 1, day: 1 });
// Adherence over a range, and the insight screen
MedicationDoseSchema.index({ userId: 1, scheduledFor: -1 });
// The reminder job: what is due, not yet notified
MedicationDoseSchema.index({ status: 1, scheduledFor: 1, remindedAt: 1 });

module.exports = mongoose.model('MedicationDose', MedicationDoseSchema);
