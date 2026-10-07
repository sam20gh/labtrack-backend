const express = require('express');
const { rateLimit } = require('express-rate-limit');
const c = require('../controllers/onboardingController');
const { authenticateToken } = require('../middleware/authMiddleware');

const router = express.Router();

// Every route is about the signed-in person's own journey; nothing here reads anyone else.
router.use(authenticateToken);

router.get('/', c.getJourney);
router.post('/welcomed', c.markWelcomed);
router.post('/skip', c.skipStep);
router.post('/resume', c.resumeStep);
router.post('/dismiss', c.dismiss);
router.get('/analysis-update', c.getAnalysisUpdate);

/**
 * Kit codes are eight characters from a 31-letter alphabet — far too many to guess — but a
 * claim endpoint is the one thing here worth scripting against, so it is limited per account
 * rather than per address: one person on a shared network must not lock out the next.
 */
router.post('/claim', rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => String(req.auth?.userId || 'anon'),
    message: { message: 'Too many attempts. Please try again in 15 minutes.' },
}), c.claimKit);

module.exports = router;
