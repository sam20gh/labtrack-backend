const express = require('express');
const router = express.Router();
const c = require('../controllers/reviewController');
const { authenticateToken, requireRole, requireMfa } = require('../middleware/authMiddleware');
const { requireReviewScope } = require('../middleware/reviewScope');

// Clinician-only throughout. A patient must never reach the review surface: approving your
// own interpretation would make "checked by a specialist" meaningless.
router.use(authenticateToken, requireRole('professional', 'admin'), requireMfa);

// `requireMfa` is inert until `STAFF_MFA_REQUIRED=true`; it is wired here now so turning it
// on is one environment variable rather than an edit to every staff router. See the
// middleware for the three-step rollout, and why the flag defaults to off on a live portal.

router.get('/queue', c.getQueue);
router.get('/mine', c.getMyReviews);
router.get('/profile', c.getProfile);

/**
 * Operational reporting. Declared above `/:reportId` so 'metrics' is never read as an
 * interpretation id — the same reason `/patient/...` is declared where it is.
 *
 * Open to clinicians as well as admins on purpose: turnaround and amendment rate are the
 * numbers the people doing the reviewing need in order to change them, and a dashboard only
 * management can see is a dashboard about people rather than about work.
 */
router.get('/metrics', c.getReviewMetrics);

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

// Claiming coordinates who is working on what. It grants nothing — see `claimReview`.
router.post('/:reportId/claim', c.claimReview);
router.post('/:reportId/release', c.releaseReview);

module.exports = router;
