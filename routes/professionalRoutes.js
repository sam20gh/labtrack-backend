const express = require('express');
const router = express.Router();
const professionalController = require('../controllers/professionalController');
const { authenticateToken, requireRole } = require('../middleware/authMiddleware');

// The directory is readable by any signed-in user; mutations are administrative.
// Previously this entire router was unauthenticated CRUD on credentialed records.
router.get('/', authenticateToken, professionalController.getAllProfessionals);
router.get('/:id', authenticateToken, professionalController.getProfessionalById);

router.post('/', authenticateToken, requireRole('admin'), professionalController.createProfessional);
router.put('/:id', authenticateToken, requireRole('admin', 'professional'), professionalController.updateProfessional);
router.delete('/:id', authenticateToken, requireRole('admin'), professionalController.deleteProfessional);

module.exports = router;
