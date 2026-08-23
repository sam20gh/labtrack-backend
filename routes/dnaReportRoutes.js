const express = require('express');
const router = express.Router();
const c = require('../controllers/dnaReportController');
const { authenticateToken, requireRole } = require('../middleware/authMiddleware');

router.use(authenticateToken);

// Before /:id so 'review-queue' is not read as an id
router.get('/review-queue', requireRole('professional', 'admin'), c.getReviewQueue);

router.post('/', c.createDnaReport);
router.get('/', c.getDnaReports);
router.get('/:id', c.getDnaReport);
router.put('/:id', c.updateDnaReport);
router.delete('/:id', c.deleteDnaReport);

module.exports = router;
