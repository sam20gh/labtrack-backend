const express = require('express');
const { rateLimit } = require('express-rate-limit');
const LaunchSignup = require('../models/LaunchSignup');

const router = express();
router.set('trust proxy', process.env.RENDER === 'true' ? 1 : false);
const MESSAGE = 'You are on the launch list.';

router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

router.post('/', rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { message: 'Too many attempts. Please try again in 15 minutes.' },
}), async (req, res) => {
    const { email, consent, website } = req.body || {};
    if (typeof website === 'string' && website.trim()) {
        return res.status(200).json({ message: MESSAGE });
    }
    const normalised = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (consent !== true || normalised.length > 254 ||
        !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(normalised)) {
        return res.status(400).json({ message: 'Enter a valid email and agree to the launch notification.' });
    }
    try {
        await LaunchSignup.updateOne({ email: normalised }, {
            $setOnInsert: {
                email: normalised,
                consentVersion: 'launch-notification-v1',
                consentAt: new Date(),
                source: 'homepage',
            },
        }, { upsert: true, runValidators: true });
        return res.status(200).json({ message: MESSAGE });
    } catch (error) {
        if (error.code === 11000) return res.status(200).json({ message: MESSAGE });
        console.error('Launch signup could not be saved');
        return res.status(503).json({ message: 'We could not save your email. Please try again.' });
    }
});

module.exports = router;