const express = require('express');
const router = express.Router();
const c = require('../controllers/genotypeController');
const { authenticateToken } = require('../middleware/authMiddleware');

router.use(authenticateToken);

router.get('/', c.listGenotypeFiles);
// Before /:id so neither segment is read as an id
router.get('/:id/coverage', c.getCoverage);
router.post('/:id/consent', c.setRiskConsent);
router.get('/:id', c.getGenotypeFile);

module.exports = router;
