const express = require('express');
const router = express.Router();
const c = require('../controllers/notificationController');
const { authenticateToken, requireRole } = require('../middleware/authMiddleware');

router.use(authenticateToken);

router.post('/register', c.registerToken);
router.delete('/register', c.unregisterToken);
router.get('/preferences', c.getPreferences);
router.put('/preferences', c.updatePreferences);
router.post('/test', c.sendTest);

// Operational trigger — the schedule runs it daily, this is for verification
router.post('/run-reminders', requireRole('admin'), c.triggerReminders);

module.exports = router;
