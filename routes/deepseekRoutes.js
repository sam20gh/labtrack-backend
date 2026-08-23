const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');

/**
 * Retired in Phase 4.
 *
 * DeepSeek produced free prose that `utils/feedbackParser.js` scanned for exact phrases;
 * anything worded differently was silently dropped, and the specialities it emitted matched
 * no `Professional.speciality` value, so consultations never reached a plan.
 * `POST /api/interpretation/generate` replaces it with schema-enforced structured output.
 *
 * A 410 (rather than deleting the route) tells older app builds exactly what happened.
 */
router.post('/', authenticateToken, (req, res) => {
    res.status(410).json({
        message: 'This endpoint has been replaced by POST /api/interpretation/generate',
        replacement: '/api/interpretation/generate',
    });
});

module.exports = router;
