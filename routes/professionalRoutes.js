const express = require('express');
const router = express.Router();
const professionalController = require('../controllers/professionalController');

// Routes for Professionals
router.post('/', professionalController.createProfessional); // Create a professional
router.get('/', professionalController.getAllProfessionals); // Get all professionals
router.get('/:id', professionalController.getProfessionalById); // Get a professional by ID
router.put('/:id', professionalController.updateProfessional); // Update a professional by ID
router.delete('/:id', professionalController.deleteProfessional); // Delete a professional by ID

module.exports = router;
