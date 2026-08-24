const express = require('express');
const router = express.Router();
const c = require('../controllers/reviewController');
const { authenticateToken, requireRole } = require('../middleware/authMiddleware');

// Clinician-only throughout. A patient must never reach the review surface: approving your
// own interpretation would make "checked by a specialist" meaningless.
router.use(authenticateToken, requireRole('professional', 'admin'));

router.get('/queue', c.getQueue);
router.get('/mine', c.getMyReviews);
router.get('/profile', c.getProfile);
router.get('/:reportId', c.getReportForReview);
router.post('/:reportId', c.submitReview);
router.post('/:reportId/plan-items', c.addPlanItem);

module.exports = router;
