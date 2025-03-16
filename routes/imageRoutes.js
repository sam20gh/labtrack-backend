const express = require('express');
const multer = require('multer');
const imageController = require('../controllers/imageController');

const router = express.Router();
const upload = multer({ dest: 'uploads/' }); // Store temporarily before uploading

router.post('/upload', upload.single('image'), imageController.uploadImage);
router.get('/test', (req, res) => {
    res.status(200).json({ message: 'Image upload route is working' });
});

module.exports = router;
