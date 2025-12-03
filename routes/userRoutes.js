const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { authenticateToken } = require('../middleware/authMiddleware');


// Public Routes
router.post('/signup', userController.signup);
router.post('/login', userController.login);

// Protected Routes (Ensure they are correctly formatted)
router.get('/', authenticateToken, userController.getAllUsers);
router.get('/:id', authenticateToken, userController.getUserById);
router.put('/:id', authenticateToken, userController.updateUser);
router.delete('/:id', authenticateToken, userController.deleteUser);

// ============================================
// HEALTH ASSESSMENT ROUTES
// ============================================

// Get/Update entire health assessment
router.get('/:id/health-assessment', authenticateToken, userController.getHealthAssessment);
router.put('/:id/health-assessment', authenticateToken, userController.updateHealthAssessment);

// Mood tracking
router.post('/:id/health-assessment/mood', authenticateToken, userController.addMoodEntry);

// Habits
router.put('/:id/health-assessment/habits', authenticateToken, userController.updateHabits);

// Nutrition/Calories
router.post('/:id/health-assessment/nutrition', authenticateToken, userController.addNutritionEntry);
router.put('/:id/health-assessment/nutrition-goals', authenticateToken, userController.updateNutritionGoals);

// Medications
router.put('/:id/health-assessment/medications', authenticateToken, userController.updateMedications);
router.post('/:id/health-assessment/medications', authenticateToken, userController.addMedication);

// Allergies
router.put('/:id/health-assessment/allergies', authenticateToken, userController.updateAllergies);
router.post('/:id/health-assessment/allergies', authenticateToken, userController.addAllergy);

// Medical Conditions
router.put('/:id/health-assessment/conditions', authenticateToken, userController.updateConditions);
router.post('/:id/health-assessment/conditions', authenticateToken, userController.addCondition);

// Checkups
router.put('/:id/health-assessment/checkups', authenticateToken, userController.updateCheckups);
router.post('/:id/health-assessment/checkups', authenticateToken, userController.addCheckup);

// Analysis preferences
router.put('/:id/health-assessment/analysis-preferences', authenticateToken, userController.updateAnalysisPreferences);

// Health Notes
router.put('/:id/health-assessment/notes', authenticateToken, userController.updateHealthNotes);
router.post('/:id/health-assessment/notes', authenticateToken, userController.addHealthNote);

// Voice Recordings
router.post('/:id/health-assessment/voice-recordings', authenticateToken, userController.addVoiceRecording);

// Lifestyle
router.put('/:id/health-assessment/lifestyle', authenticateToken, userController.updateLifestyle);

// Family History
router.put('/:id/health-assessment/family-history', authenticateToken, userController.updateFamilyHistory);

// Delete specific item from health assessment arrays
router.delete('/:id/health-assessment/:field/:itemId', authenticateToken, userController.deleteHealthItem);

module.exports = router;
