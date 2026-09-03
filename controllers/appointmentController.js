const Appointment = require('../models/Appointment');
const Professional = require('../models/Professional');
const PlanItem = require('../models/PlanItem');
const { notifyUser } = require('../jobs/reminderJob');
const { resolveProfessional } = require('../utils/resolveProfessional');
const { recordAccess } = require('../utils/accessLog');

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

/* ─────────────────────────────────────────────────────────────────────────────
 * The professional's side.
 *
 * Until now booking was one-directional: the app created a row as `requested` and nothing
 * could ever answer it. Every appointment in the product sat unconfirmed, and the UI said
 * so throughout — accurately, because there was no endpoint a clinician could use to say
 * yes. These four close that loop.
 *
 * Availability is still not modelled. A clinician confirms or declines a time the patient
 * proposed, or proposes another; nothing here claims to know their working hours, and the
 * kit's "Available / Unavailable" day labels remain deliberately unbuilt.
 * ───────────────────────────────────────────────────────────────────────────── */

/** Transitions a clinician may make, from where. Mirrors the patient-side guard. */
const CLINICIAN_TRANSITIONS = {
    requested: ['confirmed', 'cancelled'],
    confirmed: ['completed', 'no_show', 'cancelled'],
    // Terminal: a consultation that happened, or one that did not.
    completed: [],
    no_show: [],
    cancelled: [],
};

/**
 * The appointments belonging to the signed-in clinician.
 *
 * GET /api/appointments/professional?status=&from=&to=
 */
exports.getProfessionalAppointments = async (req, res) => {
    try {
        const professional = await resolveProfessional(req.auth, '_id');
        if (!professional) {
            /**
             * 200 with an empty diary, not 404.
             *
             * An administrator has no directory record and never will, and a newly invited
             * clinician has one only once somebody links it. Neither is an error, and
             * failing here would make the diary look broken rather than empty.
             */
            return res.json({
                appointments: [],
                linked: false,
                message: 'No clinician directory record is linked to this account.',
            });
        }

        const filter = { professionalId: professional._id };

        const status = (req.query.status || '').trim();
        if (status && status !== 'all') {
            const allowed = Appointment.schema.path('status').enumValues;
            if (!allowed.includes(status)) {
                return res.status(400).json({
                    message: `Unknown status "${status}". Expected one of: ${allowed.join(', ')}`,
                });
            }
            filter.status = status;
        }

        if (req.query.from || req.query.to) {
            filter.scheduledFor = {};
            if (req.query.from) filter.scheduledFor.$gte = new Date(req.query.from);
            if (req.query.to) filter.scheduledFor.$lte = new Date(req.query.to);
        }

        const appointments = await Appointment.find(filter)
            .sort({ scheduledFor: 1 })
            .populate('userId', 'firstName lastName dob gender')
            .limit(200)
            .lean();

        // The diary names patients, so opening it is a read of patient data — its own
        // resource label, not 'queue', so an audit of "what did this clinician view" can
        // tell a review-queue browse apart from a diary check rather than merging the two.
        await recordAccess({
            actor: req.auth,
            resource: 'appointments',
            count: appointments.length,
        });

        res.json({ appointments, linked: true });
    } catch (error) {
        console.error('❌ Could not load clinician diary:', error);
        res.status(500).json({ message: 'Could not load your appointments', error: error.message });
    }
};

/**
 * PATCH /api/appointments/:id/professional-status
 * Body: { status, note? }
 *
 * Confirm, decline, or record what happened. Scoped to the clinician's own diary: an
 * appointment that is not theirs is a 404, never a 403, so this cannot be used to discover
 * which ids exist.
 */
exports.setAppointmentStatusAsProfessional = async (req, res) => {
    try {
        const professional = await resolveProfessional(req.auth, '_id');
        if (!professional) {
            return res.status(403).json({
                message: 'No clinician directory record is linked to this account.',
            });
        }

        const status = String(req.body.status || '').trim();
        const allowed = Appointment.schema.path('status').enumValues;
        if (!allowed.includes(status)) {
            return res.status(400).json({
                message: `Unknown status "${status}". Expected one of: ${allowed.join(', ')}`,
            });
        }

        const appointment = await Appointment.findOne({
            _id: req.params.id,
            professionalId: professional._id,
        });
        if (!appointment) return res.status(404).json({ message: 'Appointment not found' });

        const legal = CLINICIAN_TRANSITIONS[appointment.status] || [];
        if (!legal.includes(status)) {
            return res.status(409).json({
                message: legal.length
                    ? `An appointment that is ${appointment.status} can only move to: ${legal.join(', ')}`
                    : `An appointment that is ${appointment.status} is final`,
            });
        }

        appointment.status = status;
        if (status === 'cancelled') {
            appointment.cancelledBy = 'professional';
            appointment.cancellationReason = req.body.note;
        }
        if (req.body.note && status !== 'cancelled') {
            appointment.outcomeNotes = req.body.note;
        }
        await appointment.save();

        console.log(`🗓️ Appointment ${appointment._id} → ${status} by professional ${professional._id}`);

        // Tell the patient. Fire-and-forget: a push failure must not fail the transition.
        const ANNOUNCE = {
            confirmed: {
                title: 'Your consultation is confirmed',
                body: 'Your requested time has been accepted.',
            },
            cancelled: {
                title: 'Your consultation was cancelled',
                body: 'Open the app to request another time.',
            },
        };
        const announcement = ANNOUNCE[status];
        if (announcement) {
            notifyUser(appointment.userId, {
                title: announcement.title,
                body: announcement.body,
                data: {
                    type: 'appointment',
                    appointmentId: String(appointment._id),
                    route: '/appointments',
                },
            }).catch((e) => console.warn('⚠️ Appointment notification failed:', e.message));
        }

        res.json({ message: `Appointment ${status}`, appointment });
    } catch (error) {
        console.error('❌ Could not update appointment:', error);
        res.status(400).json({ message: 'Could not update the appointment', error: error.message });
    }
};

/**
 * POST /api/appointments/:id/propose
 * Body: { scheduledFor, note? }
 *
 * The clinician cannot make the time, but wants the consultation. The row moves rather than
 * being cancelled and rebooked — that would lose the plan item link, the price snapshot and
 * the reason for the visit — and drops back to `requested`, because a time the *clinician*
 * chose is not a time the *patient* has agreed to. Symmetrical with the patient's own
 * reschedule, which does the same thing in the other direction.
 */
exports.proposeNewTime = async (req, res) => {
    try {
        const professional = await resolveProfessional(req.auth, '_id');
        if (!professional) {
            return res.status(403).json({
                message: 'No clinician directory record is linked to this account.',
            });
        }

        const { scheduledFor, note } = req.body;
        if (!scheduledFor || new Date(scheduledFor) < new Date()) {
            return res.status(400).json({ message: 'scheduledFor must be a future date' });
        }

        const appointment = await Appointment.findOne({
            _id: req.params.id,
            professionalId: professional._id,
        });
        if (!appointment) return res.status(404).json({ message: 'Appointment not found' });

        if (['cancelled', 'completed', 'no_show'].includes(appointment.status)) {
            return res.status(409).json({
                message: `An appointment that is ${appointment.status} cannot be rescheduled`,
            });
        }

        appointment.scheduledFor = scheduledFor;
        appointment.status = 'requested';
        if (note) appointment.outcomeNotes = note;
        await appointment.save();

        notifyUser(appointment.userId, {
            title: 'A new time was proposed',
            body: 'Your clinician suggested a different time. Open the app to accept it.',
            data: {
                type: 'appointment',
                appointmentId: String(appointment._id),
                route: '/appointments',
            },
        }).catch((e) => console.warn('⚠️ Appointment notification failed:', e.message));

        res.json({ message: 'New time proposed', appointment });
    } catch (error) {
        res.status(400).json({ message: 'Could not propose a new time', error: error.message });
    }
};
