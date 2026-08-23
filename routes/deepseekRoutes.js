const express = require('express');
const router = express.Router();
const deepseekController = require('../controllers/deepseekController');
const { authenticateToken } = require('../middleware/authMiddleware');

// Authenticated: this endpoint spends paid model credits
router.post('/', authenticateToken, deepseekController.handleDeepSeekRequest);

module.exports = router;
