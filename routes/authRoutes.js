const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

// Login Route
router.post('/login', authController.loginProfessional);

module.exports = router;
