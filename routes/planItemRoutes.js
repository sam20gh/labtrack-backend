const express = require('express');
const router = express.Router();
const c = require('../controllers/planItemController');
const { authenticateToken, requireRole, requireMfa } = require('../middleware/authMiddleware');

router.use(authenticateToken);

/**
 * Administrative oversight, declared before `/:id` for the reason `orderRoutes.js` gives:
 * `/admin/all` is two segments and `/:id` matches one, so nothing collides today — the
 * ordering is what keeps that true if a single-segment `/admin` is ever added.
 *
 * `requireMfa` matches `/api/reviews` and `/api/staff`: these routes read clinical
 * instructions across every patient, which is the same class of data the review queue
 * carries, and the flag it reads is off until the rollout in `authMiddleware.js` is done.
 * The patient routes below are deliberately untouched — mobile has no enrolment flow.
 */
router.get('/admin/all', requireRole('admin'), requireMfa, c.listAllPlanItems);
// Before any future '/admin/:id', or 'stats' is read as an id and answers 404.
router.get('/admin/stats', requireRole('admin'), requireMfa, c.getPlanItemStats);

router.get('/', c.getPlanItems);
router.post('/', c.createPlanItem);
router.patch('/:id/status', c.updateStatus);
router.delete('/:id', c.deletePlanItem);

module.exports = router;
