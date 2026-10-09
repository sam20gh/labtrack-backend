const express = require('express');
const c = require('../controllers/collectionController');
const { authenticateToken, requireRole } = require('../middleware/authMiddleware');

/** Market settings — how each market is served. Administrators only; edited in the portal. */
const router = express.Router();
router.use(authenticateToken, requireRole('admin'));
router.get('/', c.listMarkets);
router.put('/:code', c.updateMarket);
module.exports = router;
