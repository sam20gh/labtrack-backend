const express = require('express');
const router = express.Router();
const c = require('../controllers/scoreController');
const { authenticateToken } = require('../middleware/authMiddleware');

/**
 * The LabTrack score.
 *
 * Every route reads one person's whole health record — labs, activity, sleep, meals, doses —
 * so the router is behind a token in one place rather than per route.
 */
router.use(authenticateToken);

router.get('/', c.getScore);
router.get('/trend', c.getTrend);
router.post('/recompute', c.recomputeScore);

module.exports = router;
