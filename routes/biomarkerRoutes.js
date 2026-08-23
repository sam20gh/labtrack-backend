const express = require('express');
const router = express.Router();
const c = require('../controllers/biomarkerController');
const { authenticateToken } = require('../middleware/authMiddleware');

// Every route is scoped to req.auth.userId inside the controller — no :userId in the path,
// so there is no id to tamper with.
router.use(authenticateToken);

router.get('/reference-ranges', c.getReferenceRanges);
router.get('/latest', c.getLatest);
router.get('/:name/trend', c.getTrend);
router.post('/', c.addBiomarkers);
router.delete('/:id', c.deleteBiomarker);

module.exports = router;
