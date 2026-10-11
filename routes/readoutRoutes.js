const express = require('express');
const router = express.Router();
const c = require('../controllers/readoutController');
const { authenticateToken } = require('../middleware/authMiddleware');

/**
 * The home screen's daily readout — Sleep, Recovery, Effort. Only ever the caller's own.
 */
router.use(authenticateToken);

router.get('/', c.getReadout);
router.get('/recovery', c.getRecovery);

module.exports = router;
