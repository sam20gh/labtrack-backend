const express = require('express');
const router = express.Router();
const c = require('../controllers/sleepController');
const { authenticateToken } = require('../middleware/authMiddleware');

/**
 * The sleep tracker.
 *
 * Every route here reads or writes one person's sleep record, so the whole router is behind
 * a token. Nothing on it ingests from a device — that is `/api/wearables/sync`, which writes
 * the `SleepSession` rows these endpoints read.
 */
router.use(authenticateToken);

router.get('/plan', c.getPlan);
router.put('/plan', c.updatePlan);

router.get('/overview', c.getOverview);
router.get('/insight', c.getInsight);
router.get('/score', c.getScore);

router.get('/nights', c.listNights);
router.post('/nights', c.createNight);
router.get('/nights/:id', c.getNight);
router.patch('/nights/:id', c.updateNight);
router.delete('/nights/:id', c.deleteNight);

router.get('/schedules', c.listSchedules);
router.post('/schedules', c.createSchedule);
router.put('/schedules/:id', c.updateSchedule);
router.delete('/schedules/:id', c.deleteSchedule);

module.exports = router;
