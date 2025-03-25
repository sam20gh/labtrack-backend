const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');
const { authenticateToken } = require('../middleware/authMiddleware');

router.post('/', authenticateToken, productController.addProduct);
router.get('/', authenticateToken, productController.getProducts); // ✅ Fixed
router.get('/:id', authenticateToken, productController.getProduct);
router.put('/:id', authenticateToken, productController.updateProduct);
router.delete('/:id', authenticateToken, productController.deleteProduct);

module.exports = router;
