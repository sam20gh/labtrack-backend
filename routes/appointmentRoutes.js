const express = require('express');
const router = express.Router();
const c = require('../controllers/appointmentController');
const { authenticateToken } = require('../middleware/authMiddleware');

router.use(authenticateToken);

router.post('/', c.createAppointment);
router.get('/', c.getAppointments);
router.post('/:id/reschedule', c.rescheduleAppointment);
router.post('/:id/cancel', c.cancelAppointment);

module.exports = router;
