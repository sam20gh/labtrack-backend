const express = require('express');
const router = express.Router();
const c = require('../controllers/interpretationController');
const { authenticateToken } = require('../middleware/authMiddleware');

router.use(authenticateToken);

router.get('/status', c.getStatus);
router.post('/generate', c.generateInterpretation);
router.get('/:sourceId', c.getInterpretation);

module.exports = router;
