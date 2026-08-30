const express = require('express');
const router = express.Router();
const c = require('../controllers/metricsController');
const { authenticateToken } = require('../middleware/authMiddleware');

/**
 * Health metrics — weight, hydration, blood pressure.
 *
 * Every route reads or writes one person's health record, so the whole router sits behind a
 * token rather than repeating the middleware per route.
 */
router.use(authenticateToken);

router.get('/overview', c.getOverview);
router.get('/reference', c.getReference);
router.get('/hydration/today', c.getHydrationToday);
router.get('/:kind/history', c.getHistory);

router.post('/weight', c.logWeight);
router.post('/water', c.logWater);
router.post('/blood-pressure', c.logBloodPressure);

router.delete('/logs/:id', c.deleteLog);

module.exports = router;
