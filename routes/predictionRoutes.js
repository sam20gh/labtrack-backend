const express = require('express');
const router = express.Router();
const c = require('../controllers/predictionController');
const { authenticateToken } = require('../middleware/authMiddleware');

/**
 * Predictive health analysis.
 *
 * Every route reads or writes one person's own measurements, and every one of them resolves
 * the subject from `req.auth.userId` rather than from a path parameter — there is no route
 * here that can be pointed at somebody else, which is why `requireSelf` does not appear.
 * The router sits behind a token in one place rather than per route, matching `/api/score`
 * and `/api/metrics`.
 */
router.use(authenticateToken);

router.get('/status', c.getStatus);
router.get('/metrics', c.getPredictableMetrics);
router.get('/overview', c.getOverview);
router.get('/accuracy', c.getAccuracy);
router.get('/insight/:metric', c.getInsight);

router.get('/', c.listPredictions);
router.post('/', c.createPrediction);
// Last: '/:id' would otherwise swallow every literal path above it.
router.get('/:id', c.getPrediction);

module.exports = router;
