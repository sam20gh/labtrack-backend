const User = require('../models/userModel');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const SECRET_KEY = process.env.SECRET_KEY;

// Register a new user
exports.signup = async (req, res) => {
    try {
        const { firstName, lastName, username, email, phone, dob, password, gender } = req.body;

        // Only email and password are required for initial signup
        // Other fields can be added later via health questionnaire
        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password are required' });
        }

        // Use email as username if not provided
        const effectiveUsername = username || email;

        const existingUser = await User.findOne({ $or: [{ email }, { username: effectiveUsername }] });
        if (existingUser) return res.status(400).json({ message: 'User already exists. Please log in.' });

        const hashedPassword = await bcrypt.hash(password, 10);

        const newUser = new User({
            firstName: firstName || '',
            lastName: lastName || '',
            username: effectiveUsername,
            email,
            phone: phone || '',
            dob: dob || '',
            gender: gender || undefined,
            password: hashedPassword
        });

        await newUser.save();
        res.status(201).json({ message: 'User registered successfully', user: newUser });
    } catch (error) {
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Login user
exports.login = async (req, res) => {
    try {
        const { username, password } = req.body;

        const user = await User.findOne({ username });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(400).json({ message: 'Invalid username or password' });
        }

        const token = jwt.sign({ id: user._id }, SECRET_KEY, { expiresIn: '24h' });

        res.json({ message: 'Login successful', token, user });
    } catch (error) {
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Get all users (Protected)
exports.getAllUsers = async (req, res) => {
    try {
        const users = await User.find().select('-password'); // Exclude passwords
        res.json(users);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching users', error: error.message });
    }
};

// Get user by ID (Protected)
exports.getUserById = async (req, res) => {
    try {
        const user = await User.findById(req.params.id).select('-password');
        if (!user) return res.status(404).json({ message: "User not found" });

        res.json(user);
    } catch (error) {
        res.status(500).json({ message: "Error fetching user", error: error.message });
    }
};

// Update user details (Protected)
exports.updateUser = async (req, res) => {
    try {
        const updates = req.body;

        if (updates.password) {
            updates.password = await bcrypt.hash(updates.password, 10);
        }

        const updatedUser = await User.findByIdAndUpdate(req.params.id, updates, { new: true }).select('-password');
        if (!updatedUser) return res.status(404).json({ message: 'User not found' });

        res.json({ message: 'User updated successfully', user: updatedUser });
    } catch (error) {
        res.status(500).json({ message: 'Error updating user', error: error.message });
    }
};

// Delete user (Protected)
exports.deleteUser = async (req, res) => {
    try {
        const deletedUser = await User.findByIdAndDelete(req.params.id);
        if (!deletedUser) return res.status(404).json({ message: 'User not found' });

        res.json({ message: 'User deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting user', error: error.message });
    }
};

// ============================================
// HEALTH ASSESSMENT ENDPOINTS
// ============================================

// Get user's health assessment data
exports.getHealthAssessment = async (req, res) => {
    try {
        const user = await User.findById(req.params.id).select('healthAssessment');
        if (!user) return res.status(404).json({ message: 'User not found' });

        res.json({ healthAssessment: user.healthAssessment || {} });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching health assessment', error: error.message });
    }
};

// Update entire health assessment (for completing the assessment flow)
exports.updateHealthAssessment = async (req, res) => {
    try {
        const { healthAssessment } = req.body;

        const updatedUser = await User.findByIdAndUpdate(
            req.params.id,
            {
                healthAssessment: {
                    ...healthAssessment,
                    completedAt: new Date(),
                    isComplete: true
                }
            },
            { new: true }
        ).select('healthAssessment');

        if (!updatedUser) return res.status(404).json({ message: 'User not found' });

        res.json({ message: 'Health assessment saved successfully', healthAssessment: updatedUser.healthAssessment });
    } catch (error) {
        res.status(500).json({ message: 'Error updating health assessment', error: error.message });
    }
};

// Add a mood entry
exports.addMoodEntry = async (req, res) => {
    try {
        const moodEntry = req.body;

        const updatedUser = await User.findByIdAndUpdate(
            req.params.id,
            { $push: { 'healthAssessment.moodHistory': moodEntry } },
            { new: true }
        ).select('healthAssessment.moodHistory');

        if (!updatedUser) return res.status(404).json({ message: 'User not found' });

        res.json({ message: 'Mood entry added', moodHistory: updatedUser.healthAssessment?.moodHistory });
    } catch (error) {
        res.status(500).json({ message: 'Error adding mood entry', error: error.message });
    }
};

// Update habits
exports.updateHabits = async (req, res) => {
    try {
        const { habits } = req.body;

        const updatedUser = await User.findByIdAndUpdate(
            req.params.id,
            { 'healthAssessment.habits': habits },
            { new: true }
        ).select('healthAssessment.habits');

        if (!updatedUser) return res.status(404).json({ message: 'User not found' });

        res.json({ message: 'Habits updated', habits: updatedUser.healthAssessment?.habits });
    } catch (error) {
        res.status(500).json({ message: 'Error updating habits', error: error.message });
    }
};

// Add nutrition entry
exports.addNutritionEntry = async (req, res) => {
    try {
        const nutritionEntry = req.body;

        const updatedUser = await User.findByIdAndUpdate(
            req.params.id,
            { $push: { 'healthAssessment.nutritionHistory': nutritionEntry } },
            { new: true }
        ).select('healthAssessment.nutritionHistory');

        if (!updatedUser) return res.status(404).json({ message: 'User not found' });

        res.json({ message: 'Nutrition entry added', nutritionHistory: updatedUser.healthAssessment?.nutritionHistory });
    } catch (error) {
        res.status(500).json({ message: 'Error adding nutrition entry', error: error.message });
    }
};

// Update nutrition goals
exports.updateNutritionGoals = async (req, res) => {
    try {
        const nutritionGoals = req.body;

        const updatedUser = await User.findByIdAndUpdate(
            req.params.id,
            { 'healthAssessment.nutritionGoals': nutritionGoals },
            { new: true }
        ).select('healthAssessment.nutritionGoals');

        if (!updatedUser) return res.status(404).json({ message: 'User not found' });

        res.json({ message: 'Nutrition goals updated', nutritionGoals: updatedUser.healthAssessment?.nutritionGoals });
    } catch (error) {
        res.status(500).json({ message: 'Error updating nutrition goals', error: error.message });
    }
};

// Add/Update medications
exports.updateMedications = async (req, res) => {
    try {
        const { medications } = req.body;

        const updatedUser = await User.findByIdAndUpdate(
            req.params.id,
            { 'healthAssessment.medications': medications },
            { new: true }
        ).select('healthAssessment.medications');

        if (!updatedUser) return res.status(404).json({ message: 'User not found' });

        res.json({ message: 'Medications updated', medications: updatedUser.healthAssessment?.medications });
    } catch (error) {
        res.status(500).json({ message: 'Error updating medications', error: error.message });
    }
};

// Add a single medication
exports.addMedication = async (req, res) => {
    try {
        const medication = req.body;

        const updatedUser = await User.findByIdAndUpdate(
            req.params.id,
            { $push: { 'healthAssessment.medications': medication } },
            { new: true }
        ).select('healthAssessment.medications');

        if (!updatedUser) return res.status(404).json({ message: 'User not found' });

        res.json({ message: 'Medication added', medications: updatedUser.healthAssessment?.medications });
    } catch (error) {
        res.status(500).json({ message: 'Error adding medication', error: error.message });
    }
};

// Update allergies
exports.updateAllergies = async (req, res) => {
    try {
        const { allergies } = req.body;

        const updatedUser = await User.findByIdAndUpdate(
            req.params.id,
            { 'healthAssessment.allergies': allergies },
            { new: true }
        ).select('healthAssessment.allergies');

        if (!updatedUser) return res.status(404).json({ message: 'User not found' });

        res.json({ message: 'Allergies updated', allergies: updatedUser.healthAssessment?.allergies });
    } catch (error) {
        res.status(500).json({ message: 'Error updating allergies', error: error.message });
    }
};

// Add a single allergy
exports.addAllergy = async (req, res) => {
    try {
        const allergy = req.body;

        const updatedUser = await User.findByIdAndUpdate(
            req.params.id,
            { $push: { 'healthAssessment.allergies': allergy } },
            { new: true }
        ).select('healthAssessment.allergies');

        if (!updatedUser) return res.status(404).json({ message: 'User not found' });

        res.json({ message: 'Allergy added', allergies: updatedUser.healthAssessment?.allergies });
    } catch (error) {
        res.status(500).json({ message: 'Error adding allergy', error: error.message });
    }
};

// Update medical conditions
exports.updateConditions = async (req, res) => {
    try {
        const { conditions } = req.body;

        const updatedUser = await User.findByIdAndUpdate(
            req.params.id,
            { 'healthAssessment.conditions': conditions },
            { new: true }
        ).select('healthAssessment.conditions');

        if (!updatedUser) return res.status(404).json({ message: 'User not found' });

        res.json({ message: 'Conditions updated', conditions: updatedUser.healthAssessment?.conditions });
    } catch (error) {
        res.status(500).json({ message: 'Error updating conditions', error: error.message });
    }
};

// Add a single condition
exports.addCondition = async (req, res) => {
    try {
        const condition = req.body;

        const updatedUser = await User.findByIdAndUpdate(
            req.params.id,
            { $push: { 'healthAssessment.conditions': condition } },
            { new: true }
        ).select('healthAssessment.conditions');

        if (!updatedUser) return res.status(404).json({ message: 'User not found' });

        res.json({ message: 'Condition added', conditions: updatedUser.healthAssessment?.conditions });
    } catch (error) {
        res.status(500).json({ message: 'Error adding condition', error: error.message });
    }
};

// Add a checkup
exports.addCheckup = async (req, res) => {
    try {
        const checkup = req.body;

        const updatedUser = await User.findByIdAndUpdate(
            req.params.id,
            { $push: { 'healthAssessment.checkups': checkup } },
            { new: true }
        ).select('healthAssessment.checkups');

        if (!updatedUser) return res.status(404).json({ message: 'User not found' });

        res.json({ message: 'Checkup added', checkups: updatedUser.healthAssessment?.checkups });
    } catch (error) {
        res.status(500).json({ message: 'Error adding checkup', error: error.message });
    }
};

// Update checkups
exports.updateCheckups = async (req, res) => {
    try {
        const { checkups } = req.body;

        const updatedUser = await User.findByIdAndUpdate(
            req.params.id,
            { 'healthAssessment.checkups': checkups },
            { new: true }
        ).select('healthAssessment.checkups');

        if (!updatedUser) return res.status(404).json({ message: 'User not found' });

        res.json({ message: 'Checkups updated', checkups: updatedUser.healthAssessment?.checkups });
    } catch (error) {
        res.status(500).json({ message: 'Error updating checkups', error: error.message });
    }
};

// Update analysis preferences
exports.updateAnalysisPreferences = async (req, res) => {
    try {
        const analysisPreferences = req.body;

        const updatedUser = await User.findByIdAndUpdate(
            req.params.id,
            { 'healthAssessment.analysisPreferences': analysisPreferences },
            { new: true }
        ).select('healthAssessment.analysisPreferences');

        if (!updatedUser) return res.status(404).json({ message: 'User not found' });

        res.json({ message: 'Analysis preferences updated', analysisPreferences: updatedUser.healthAssessment?.analysisPreferences });
    } catch (error) {
        res.status(500).json({ message: 'Error updating analysis preferences', error: error.message });
    }
};

// Add a health note
exports.addHealthNote = async (req, res) => {
    try {
        const note = req.body;

        const updatedUser = await User.findByIdAndUpdate(
            req.params.id,
            { $push: { 'healthAssessment.notes': note } },
            { new: true }
        ).select('healthAssessment.notes');

        if (!updatedUser) return res.status(404).json({ message: 'User not found' });

        res.json({ message: 'Note added', notes: updatedUser.healthAssessment?.notes });
    } catch (error) {
        res.status(500).json({ message: 'Error adding note', error: error.message });
    }
};

// Update health notes
exports.updateHealthNotes = async (req, res) => {
    try {
        const { notes } = req.body;

        const updatedUser = await User.findByIdAndUpdate(
            req.params.id,
            { 'healthAssessment.notes': notes },
            { new: true }
        ).select('healthAssessment.notes');

        if (!updatedUser) return res.status(404).json({ message: 'User not found' });

        res.json({ message: 'Notes updated', notes: updatedUser.healthAssessment?.notes });
    } catch (error) {
        res.status(500).json({ message: 'Error updating notes', error: error.message });
    }
};

// Add a voice recording
exports.addVoiceRecording = async (req, res) => {
    try {
        const voiceRecording = req.body;

        const updatedUser = await User.findByIdAndUpdate(
            req.params.id,
            { $push: { 'healthAssessment.voiceRecordings': voiceRecording } },
            { new: true }
        ).select('healthAssessment.voiceRecordings');

        if (!updatedUser) return res.status(404).json({ message: 'User not found' });

        res.json({ message: 'Voice recording added', voiceRecordings: updatedUser.healthAssessment?.voiceRecordings });
    } catch (error) {
        res.status(500).json({ message: 'Error adding voice recording', error: error.message });
    }
};

// Update lifestyle factors
exports.updateLifestyle = async (req, res) => {
    try {
        const lifestyle = req.body;

        const updatedUser = await User.findByIdAndUpdate(
            req.params.id,
            { 'healthAssessment.lifestyle': lifestyle },
            { new: true }
        ).select('healthAssessment.lifestyle');

        if (!updatedUser) return res.status(404).json({ message: 'User not found' });

        res.json({ message: 'Lifestyle updated', lifestyle: updatedUser.healthAssessment?.lifestyle });
    } catch (error) {
        res.status(500).json({ message: 'Error updating lifestyle', error: error.message });
    }
};

// Update family history
exports.updateFamilyHistory = async (req, res) => {
    try {
        const { familyHistory } = req.body;

        const updatedUser = await User.findByIdAndUpdate(
            req.params.id,
            { 'healthAssessment.familyHistory': familyHistory },
            { new: true }
        ).select('healthAssessment.familyHistory');

        if (!updatedUser) return res.status(404).json({ message: 'User not found' });

        res.json({ message: 'Family history updated', familyHistory: updatedUser.healthAssessment?.familyHistory });
    } catch (error) {
        res.status(500).json({ message: 'Error updating family history', error: error.message });
    }
};

// Delete a specific item from an array field (medications, allergies, conditions, etc.)
exports.deleteHealthItem = async (req, res) => {
    try {
        const { field, itemId } = req.params;
        const validFields = ['medications', 'allergies', 'conditions', 'checkups', 'notes', 'voiceRecordings', 'moodHistory', 'nutritionHistory', 'habits', 'familyHistory'];

        if (!validFields.includes(field)) {
            return res.status(400).json({ message: 'Invalid field specified' });
        }

        const updatedUser = await User.findByIdAndUpdate(
            req.params.id,
            { $pull: { [`healthAssessment.${field}`]: { _id: itemId } } },
            { new: true }
        ).select(`healthAssessment.${field}`);

        if (!updatedUser) return res.status(404).json({ message: 'User not found' });

        res.json({ message: `${field} item deleted`, [field]: updatedUser.healthAssessment?.[field] });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting item', error: error.message });
    }
};
