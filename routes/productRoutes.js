const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');
const { authenticateToken, requireRole } = require('../middleware/authMiddleware');

// The catalogue is readable by any signed-in user — the app browses it to place orders.
// Mutations are administrative: a product's `name` is what planGenerator substring-matches
// screenings against, so an edit here silently changes which plan items can ever resolve
// to something orderable.
router.get('/', authenticateToken, productController.getProducts);
router.get('/:id', authenticateToken, productController.getProduct);

router.post('/', authenticateToken, requireRole('admin'), productController.addProduct);
router.put('/:id', authenticateToken, requireRole('admin'), productController.updateProduct);
router.delete('/:id', authenticateToken, requireRole('admin'), productController.deleteProduct);

module.exports = router;
