const express = require('express');
const multer = require('multer');
const router = express.Router();
const c = require('../controllers/reportIngestionController');
const { authenticateToken } = require('../middleware/authMiddleware');

// Disk storage: report scans are large, and the parser streams from a file rather than
// holding a multi-megabyte base64 string in memory per request.
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 20 * 1024 * 1024 },
});

router.use(authenticateToken);

router.get('/status', c.getIngestionStatus);
router.post('/parse', upload.single('document'), c.parseUploadedReport);
router.post('/confirm', c.confirmReport);

module.exports = router;
