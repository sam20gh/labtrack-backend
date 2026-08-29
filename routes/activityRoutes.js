const express = require('express');
const router = express.Router();
const c = require('../controllers/activityController');
const { authenticateToken } = require('../middleware/authMiddleware');

// Every route here reads or writes one person's activity record.
router.use(authenticateToken);

router.get('/plan', c.getPlan);
router.put('/plan', c.updatePlan);

router.get('/summary', c.getSummary);
router.get('/day', c.getDay);

router.get('/sessions', c.listSessions);
router.get('/sessions/:id', c.getSession);
router.post('/sessions', c.createSession);
router.patch('/sessions/:id', c.updateSession);
router.delete('/sessions/:id', c.deleteSession);

module.exports = router;
