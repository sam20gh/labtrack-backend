const express = require('express');
const router = express.Router();
const path = require('path');
const productController = require('../controllers/productController');
console.log("✅ productController loaded from:", require.resolve('../controllers/productController'));
console.log("✅ keys:", Object.keys(productController));
const { authenticateToken } = require('../middleware/authMiddleware');

router.post('/', authenticateToken, productController.addProduct);
router.get('/', authenticateToken, productController.getProducts); // 
router.get('/:id', authenticateToken, productController.getProduct);
router.put('/:id', authenticateToken, productController.updateProduct);
router.delete('/:id', authenticateToken, productController.deleteProduct);

module.exports = router;