const express = require('express');
const router = express.Router();
const c = require('../controllers/orderController');
const { authenticateToken, requireRole } = require('../middleware/authMiddleware');

router.use(authenticateToken);

/**
 * Admin routes first.
 *
 * `/admin/...` is two segments and `/:id` matches one, so Express would not confuse them
 * today — but the ordering is what keeps that true if a future `/admin` list is ever added
 * at a single segment. Cheap insurance against a route that silently starts resolving to
 * `getOrder` with `id === 'admin'`.
 */
router.get('/admin/all', requireRole('admin'), c.listAllOrders);
// Before '/admin/:id', or 'stats' is read as an order id and answers 404.
router.get('/admin/stats', requireRole('admin'), c.getOrderStats);
router.get('/admin/:id', requireRole('admin'), c.getOrderForAdmin);

router.post('/', c.createOrder);
router.get('/', c.getOrders);
router.get('/:id', c.getOrder);
router.post('/:id/cancel', c.cancelOrder);

// Fulfilment. Transition legality is enforced in the controller, not here.
router.patch('/:id/status', requireRole('admin'), c.updateOrderStatus);

module.exports = router;
