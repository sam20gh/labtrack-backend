const express = require('express');
const router = express.Router();
const c = require('../controllers/cycleController');
const { authenticateToken } = require('../middleware/authMiddleware');

/**
 * The cycle tracker.
 *
 * One person's own reproductive-health record, so the whole router is behind a token and
 * every query is scoped to `req.user.id` — there is no path id to another person anywhere
 * on it. No clinician route reads these collections; see the header of the controller.
 */
router.use(authenticateToken);

router.get('/plan', c.getPlan);
router.put('/plan', c.updatePlan);
router.post('/offer/dismiss', c.dismissOffer);

router.get('/overview', c.getOverview);
router.get('/calendar', c.getCalendar);
router.get('/history', c.getHistory);
router.get('/insight', c.getInsight);

router.put('/period-days', c.putPeriodDays);
router.get('/days/:day', c.getDay);
router.put('/days/:day', c.putDay);
router.delete('/days/:day', c.deleteDay);

router.delete('/imported', c.deleteImported);
router.delete('/data', c.deleteAll);

module.exports = router;
