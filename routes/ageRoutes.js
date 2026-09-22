const express = require('express');
const router = express.Router();
const c = require('../controllers/ageController');
const { authenticateToken } = require('../middleware/authMiddleware');

/**
 * Miovix Age.
 *
 * Every route reads one person's blood results and six months of their movement, sleep and
 * vitals, so the router is behind a token in one place rather than per route — the shape
 * `/api/score`, `/api/sleep` and `/api/predictions` already use.
 */
router.use(authenticateToken);

router.get('/', c.getAge);
router.get('/trend', c.getTrend);
router.get('/levers', c.getLevers);
router.post('/recompute', c.recomputeAge);

module.exports = router;
