const express = require('express');
const { rateLimit } = require('express-rate-limit');
const c = require('../controllers/checkoutController');

/**
 * The public storefront. No token anywhere: the website sells to people who do not have an
 * account yet. See `controllers/checkoutController.js`.
 *
 * A sub-app rather than a Router so it can set `trust proxy` for itself, the way
 * `launchSignupRoutes` does — the rate limit keys on the client address, and behind Render's
 * proxy that is only correct with the proxy trusted.
 */
const router = express();
router.set('trust proxy', process.env.RENDER === 'true' ? 1 : false);

router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

router.get('/packages', c.listPackages);

// Each attempt writes an order and calls Stripe: worth limiting against a script.
router.post('/session', rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { message: 'Too many attempts. Please try again in 15 minutes.' },
}), c.createSession);

router.get('/session/:sessionId', rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { message: 'Too many requests. Please try again shortly.' },
}), c.getSession);

module.exports = router;
