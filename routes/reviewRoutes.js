const express = require('express');
const router = express.Router();
const c = require('../controllers/reviewController');
const { authenticateToken, requireRole } = require('../middleware/authMiddleware');
const { requireReviewScope } = require('../middleware/reviewScope');

// Clinician-only throughout. A patient must never reach the review surface: approving your
// own interpretation would make "checked by a specialist" meaningless.
router.use(authenticateToken, requireRole('professional', 'admin'));

router.get('/queue', c.getQueue);
router.get('/mine', c.getMyReviews);
router.get('/profile', c.getProfile);

/**
 * A patient's record, for a clinician reviewing their case.
 *
 * Declared above `/:reportId` so 'patient' is never read as an interpretation id, and
 * scoped as well as role-gated: holding a professional token is not by itself a reason to
 * read a given person's medical history.
 */
router.get('/patient/:userId/context', requireReviewScope, c.getPatientContext);

router.get('/:reportId', c.getReportForReview);
router.post('/:reportId', c.submitReview);
router.post('/:reportId/plan-items', c.addPlanItem);

module.exports = router;
