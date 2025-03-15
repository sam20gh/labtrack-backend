const express = require('express');
const router = express.Router();
const deepseekController = require('../controllers/deepseekController');

router.post('/', deepseekController.handleDeepSeekRequest);

module.exports = router;
