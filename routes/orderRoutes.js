const express = require('express');
const router = express.Router();
const c = require('../controllers/orderController');
const { authenticateToken, requireRole } = require('../middleware/authMiddleware');

router.use(authenticateToken);

router.post('/', c.createOrder);
router.get('/', c.getOrders);
router.get('/:id', c.getOrder);
router.post('/:id/cancel', c.cancelOrder);

// Fulfilment is operator-driven, not user-driven
router.patch('/:id/status', requireRole('admin'), c.updateOrderStatus);

module.exports = router;
