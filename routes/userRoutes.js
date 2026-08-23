const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { authenticateToken, requireRole } = require('../middleware/authMiddleware');
const { requireSelf } = require('../middleware/ownership');


// Public Routes
router.post('/signup', userController.signup);
router.post('/login', userController.login);

// Protected Routes
// Listing every user is an admin capability, not a signed-in-user one
router.get('/', authenticateToken, requireRole('admin'), userController.getAllUsers);
router.get('/:id', authenticateToken, requireSelf(), userController.getUserById);
router.put('/:id', authenticateToken, requireSelf(), userController.updateUser);
router.delete('/:id', authenticateToken, requireSelf(), userController.deleteUser);

// ============================================
// HEALTH ASSESSMENT ROUTES
// ============================================

// Get/Update entire health assessment
router.get('/:id/health-assessment', authenticateToken, requireSelf(), userController.getHealthAssessment);
router.put('/:id/health-assessment', authenticateToken, requireSelf(), userController.updateHealthAssessment);

// Mood tracking
router.post('/:id/health-assessment/mood', authenticateToken, requireSelf(), userController.addMoodEntry);

// Habits
router.put('/:id/health-assessment/habits', authenticateToken, requireSelf(), userController.updateHabits);

// Nutrition/Calories
router.post('/:id/health-assessment/nutrition', authenticateToken, requireSelf(), userController.addNutritionEntry);
router.put('/:id/health-assessment/nutrition-goals', authenticateToken, requireSelf(), userController.updateNutritionGoals);

// Medications
router.put('/:id/health-assessment/medications', authenticateToken, requireSelf(), userController.updateMedications);
router.post('/:id/health-assessment/medications', authenticateToken, requireSelf(), userController.addMedication);

// Allergies
router.put('/:id/health-assessment/allergies', authenticateToken, requireSelf(), userController.updateAllergies);
router.post('/:id/health-assessment/allergies', authenticateToken, requireSelf(), userController.addAllergy);

// Medical Conditions
router.put('/:id/health-assessment/conditions', authenticateToken, requireSelf(), userController.updateConditions);
router.post('/:id/health-assessment/conditions', authenticateToken, requireSelf(), userController.addCondition);

// Checkups
router.put('/:id/health-assessment/checkups', authenticateToken, requireSelf(), userController.updateCheckups);
router.post('/:id/health-assessment/checkups', authenticateToken, requireSelf(), userController.addCheckup);

// Analysis preferences
router.put('/:id/health-assessment/analysis-preferences', authenticateToken, requireSelf(), userController.updateAnalysisPreferences);

// Health Notes
router.put('/:id/health-assessment/notes', authenticateToken, requireSelf(), userController.updateHealthNotes);
router.post('/:id/health-assessment/notes', authenticateToken, requireSelf(), userController.addHealthNote);

// Voice Recordings
router.post('/:id/health-assessment/voice-recordings', authenticateToken, requireSelf(), userController.addVoiceRecording);

// Lifestyle
router.put('/:id/health-assessment/lifestyle', authenticateToken, requireSelf(), userController.updateLifestyle);

// Family History
router.put('/:id/health-assessment/family-history', authenticateToken, requireSelf(), userController.updateFamilyHistory);

// Delete specific item from health assessment arrays
router.delete('/:id/health-assessment/:field/:itemId', authenticateToken, requireSelf(), userController.deleteHealthItem);

module.exports = router;
