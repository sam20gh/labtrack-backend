const express = require('express');
const router = express.Router();
const c = require('../controllers/planItemController');
const { authenticateToken } = require('../middleware/authMiddleware');

router.use(authenticateToken);

router.get('/', c.getPlanItems);
router.post('/', c.createPlanItem);
router.patch('/:id/status', c.updateStatus);
router.delete('/:id', c.deletePlanItem);

module.exports = router;
