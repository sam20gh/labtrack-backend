const express = require('express');
const router = express.Router();
const testResultController = require('../controllers/testResultController');
const { authenticateToken } = require('../middleware/authMiddleware');
const { requireSelfQuery, requireSelfBody } = require('../middleware/ownership');

// Medical records — authenticated and scoped to the caller
router.post('/', authenticateToken, requireSelfBody('patient.user_id'), testResultController.addTestResult);
router.get('/', authenticateToken, requireSelfQuery('user_id'), testResultController.getTestResults);

module.exports = router;
