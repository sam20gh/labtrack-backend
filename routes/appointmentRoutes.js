const express = require('express');
const router = express.Router();
const c = require('../controllers/appointmentController');
const { authenticateToken, requireRole } = require('../middleware/authMiddleware');

router.use(authenticateToken);

/**
 * The clinician's side of the diary.
 *
 * Declared above `/:id` so 'professional' is never read as an appointment id. Scoped inside
 * the controller to the signed-in clinician's own `Professional` record — a role alone does
 * not grant sight of another clinician's diary, which names patients.
 */
router.get('/professional', requireRole('professional', 'admin'), c.getProfessionalAppointments);
router.patch('/:id/professional-status', requireRole('professional', 'admin'), c.setAppointmentStatusAsProfessional);
router.post('/:id/propose', requireRole('professional', 'admin'), c.proposeNewTime);

// The patient's side.
router.post('/', c.createAppointment);
router.get('/', c.getAppointments);
router.post('/:id/reschedule', c.rescheduleAppointment);
router.post('/:id/cancel', c.cancelAppointment);

module.exports = router;
