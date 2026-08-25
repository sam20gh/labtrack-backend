const express = require('express');
const router = express.Router();
const c = require('../controllers/interpretationController');
const { authenticateToken } = require('../middleware/authMiddleware');

router.use(authenticateToken);

router.get('/status', c.getStatus);
// Must stay above '/:sourceId', which would otherwise match 'latest' as an id.
router.get('/latest', c.getLatest);
router.post('/generate', c.generateInterpretation);
router.get('/:sourceId', c.getInterpretation);

module.exports = router;
