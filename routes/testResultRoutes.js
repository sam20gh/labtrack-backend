const express = require('express');
const router = express.Router();
const testResultController = require('../controllers/testResultController');

router.post('/', testResultController.addTestResult);
router.get('/', testResultController.getTestResults);

module.exports = router;
