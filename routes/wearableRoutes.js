const express = require('express');
const router = express.Router();
const c = require('../controllers/wearableController');
const { authenticateToken } = require('../middleware/authMiddleware');

/**
 * Device health-data sync.
 *
 * Mounted at `/api/wearables`, not `/api/health` — the liveness endpoint at `/health` is
 * what an operator or a load balancer hits, and two things called "health" in one API is a
 * page of someone's sleep record served to a status checker waiting to happen.
 *
 * Every route reads or writes one person's health record, so the whole router is behind a
 * token.
 */
router.use(authenticateToken);

router.get('/status', c.getStatus);
router.post('/sync', c.sync);

router.get('/sources', c.listSources);
router.delete('/sources/:id', c.disconnectSource);

module.exports = router;
