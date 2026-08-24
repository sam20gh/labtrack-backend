const express = require('express');
const router = express.Router();
const c = require('../controllers/paymentController');
const { authenticateToken } = require('../middleware/authMiddleware');

// NOTE: the webhook is mounted separately in index.js, before express.json(), because
// signature verification needs the raw request body.

router.get('/status', authenticateToken, c.getPaymentStatus);
router.post('/orders/:orderId/intent', authenticateToken, c.createPaymentIntent);
router.post('/orders/:orderId/confirm', authenticateToken, c.confirmPayment);

module.exports = router;
