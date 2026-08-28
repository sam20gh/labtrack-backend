const Appointment = require('../models/Appointment');
const Professional = require('../models/Professional');
const PlanItem = require('../models/PlanItem');

/** POST /api/appointments — request a consultation. */
exports.createAppointment = async (req, res) => {
    try {
        const { professionalId, planItemId, scheduledFor, mode, reasonForVisit, durationMinutes } = req.body;

        const professional = await Professional.findById(professionalId).select('hourly_rate');
        if (!professional) return res.status(404).json({ message: 'Professional not found' });

        if (!scheduledFor || new Date(scheduledFor) < new Date()) {
            return res.status(400).json({ message: 'scheduledFor must be a future date' });
        }

        const appointment = await Appointment.create({
            userId: req.auth.userId,
            professionalId,
            planItemId,
            scheduledFor,
            durationMinutes,
            mode,
            reasonForVisit,
            // Snapshot: the professional's rate may change before the consultation
            priceAtBooking: professional.hourly_rate,
            status: 'requested',
        });

        if (planItemId) {
            await PlanItem.findOneAndUpdate(
                { _id: planItemId, userId: req.auth.userId },
                { $set: { status: 'booked', appointmentId: appointment._id } },
                { runValidators: true }
            );
        }

        res.status(201).json({ message: 'Appointment requested', appointment });
    } catch (error) {
        console.error('❌ Error creating appointment:', error);
        res.status(400).json({ message: 'Error creating appointment', error: error.message });
    }
};

/** GET /api/appointments */
exports.getAppointments = async (req, res) => {
    try {
        const appointments = await Appointment.find({ userId: req.auth.userId })
            .sort({ scheduledFor: -1 })
            .populate('professionalId', 'firstname lastname speciality profile_image')
            .lean();
        res.json({ appointments });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching appointments', error: error.message });
    }
};

/**
 * POST /api/appointments/:id/reschedule
 *
 * Moving a booking is not cancel-then-rebook: that loses the plan item link, the price
 * snapshot and the reason for the visit, and it tells the professional the patient walked
 * away. The row is moved instead, and dropped back to `requested` because a time the
 * professional confirmed is not a time they have confirmed any more.
 */
exports.rescheduleAppointment = async (req, res) => {
    try {
        const { scheduledFor, mode } = req.body;

        if (!scheduledFor || new Date(scheduledFor) < new Date()) {
            return res.status(400).json({ message: 'scheduledFor must be a future date' });
        }

        const update = { scheduledFor, status: 'requested' };
        if (mode) update.mode = mode;

        const appointment = await Appointment.findOneAndUpdate(
            { _id: req.params.id, userId: req.auth.userId, status: { $in: ['requested', 'confirmed'] } },
            { $set: update },
            { new: true, runValidators: true }
        );
        if (!appointment) {
            return res.status(404).json({ message: 'No reschedulable appointment found' });
        }

        console.log(`\u{1F504} Appointment ${appointment._id} moved to ${appointment.scheduledFor.toISOString()}`);
        res.json({ message: 'Appointment rescheduled', appointment });
    } catch (error) {
        console.error('\u274C Error rescheduling appointment:', error);
        res.status(400).json({ message: 'Error rescheduling appointment', error: error.message });
    }
};

/** POST /api/appointments/:id/cancel */
exports.cancelAppointment = async (req, res) => {
    try {
        const appointment = await Appointment.findOneAndUpdate(
            { _id: req.params.id, userId: req.auth.userId, status: { $in: ['requested', 'confirmed'] } },
            { $set: { status: 'cancelled', cancelledBy: 'user', cancellationReason: req.body.reason } },
            { new: true, runValidators: true }
        );
        if (!appointment) {
            return res.status(404).json({ message: 'No cancellable appointment found' });
        }

        // Release the plan item so it reappears on the timeline
        if (appointment.planItemId) {
            await PlanItem.findByIdAndUpdate(
                appointment.planItemId,
                { $set: { status: PlanItem.deriveStatus(new Date()), appointmentId: null } },
                { runValidators: true }
            );
        }

        res.json({ message: 'Appointment cancelled', appointment });
    } catch (error) {
        res.status(500).json({ message: 'Error cancelling appointment', error: error.message });
    }
};
