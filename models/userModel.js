const mongoose = require('mongoose');

// Sub-schema for medications
const MedicationSchema = new mongoose.Schema({
    name: { type: String, required: true },
    dosage: { type: String },
    frequency: { type: String },
    startDate: { type: Date },
    endDate: { type: Date },
    isCurrentlyTaking: { type: Boolean, default: true },
    notes: { type: String }
}, { _id: true });

// Sub-schema for allergies
const AllergySchema = new mongoose.Schema({
    allergen: { type: String, required: true },
    reaction: { type: String },
    severity: { type: String, enum: ['Mild', 'Moderate', 'Severe'], default: 'Moderate' },
    diagnosedDate: { type: Date }
}, { _id: true });

// Sub-schema for medical conditions
const ConditionSchema = new mongoose.Schema({
    name: { type: String, required: true },
    diagnosedDate: { type: Date },
    status: { type: String, enum: ['Active', 'Managed', 'Resolved'], default: 'Active' },
    notes: { type: String }
}, { _id: true });

// Sub-schema for checkups
const CheckupSchema = new mongoose.Schema({
    type: { type: String, required: true },
    date: { type: Date, required: true },
    provider: { type: String },
    location: { type: String },
    findings: { type: String },
    nextScheduled: { type: Date }
}, { _id: true });

// Sub-schema for health notes
const HealthNoteSchema = new mongoose.Schema({
    title: { type: String },
    content: { type: String, required: true },
    category: { type: String, enum: ['General', 'Symptom', 'Question', 'Reminder', 'Other'], default: 'General' },
    createdAt: { type: Date, default: Date.now }
}, { _id: true });

// Sub-schema for voice recordings
const VoiceRecordingSchema = new mongoose.Schema({
    url: { type: String, required: true },
    duration: { type: Number }, // in seconds
    transcription: { type: String },
    category: { type: String },
    createdAt: { type: Date, default: Date.now }
}, { _id: true });

// Sub-schema for mood tracking
const MoodEntrySchema = new mongoose.Schema({
    mood: { type: String, enum: ['Excellent', 'Good', 'Okay', 'Poor', 'Bad'], required: true },
    energyLevel: { type: Number, min: 1, max: 10 },
    stressLevel: { type: Number, min: 1, max: 10 },
    sleepQuality: { type: String, enum: ['Excellent', 'Good', 'Fair', 'Poor'] },
    sleepHours: { type: Number },
    notes: { type: String },
    date: { type: Date, default: Date.now }
}, { _id: true });

// Sub-schema for habits
const HabitSchema = new mongoose.Schema({
    name: { type: String, required: true },
    category: { type: String, enum: ['Exercise', 'Diet', 'Sleep', 'Hydration', 'Mindfulness', 'Smoking', 'Alcohol', 'Other'] },
    frequency: { type: String }, // e.g., "Daily", "Weekly", "3x per week"
    isPositive: { type: Boolean, default: true }, // positive habit vs habit to quit
    trackingEnabled: { type: Boolean, default: true }
}, { _id: true });

// Sub-schema for calorie/nutrition tracking
const NutritionEntrySchema = new mongoose.Schema({
    date: { type: Date, default: Date.now },
    caloriesConsumed: { type: Number },
    calorieGoal: { type: Number },
    protein: { type: Number }, // grams
    carbs: { type: Number }, // grams
    fat: { type: Number }, // grams
    water: { type: Number }, // glasses or ml
    meals: [{
        name: { type: String },
        calories: { type: Number },
        time: { type: String }
    }]
}, { _id: true });

const UserSchema = new mongoose.Schema({
    firstName: { type: String, default: '' },
    lastName: { type: String, default: '' },
    username: { type: String, unique: true, required: true },
    email: { type: String, unique: true, required: true },
    phone: { type: String, default: '' },
    dob: { type: String, default: '' },
    gender: { type: String, enum: ['Male', 'Female', 'Other', null], default: null },
    height: { type: Number, default: null },
    weight: { type: Number, default: null },
    bloodType: { type: String, default: null }, // e.g., "A+", "O-", "AB+"
    password: { type: String, required: true },

    // Comprehensive Health Assessment Fields
    healthAssessment: {
        completedAt: { type: Date },
        isComplete: { type: Boolean, default: false },

        // Health goals selected during assessment
        healthGoals: [{ type: String }],

        // Mood tracking history
        moodHistory: [MoodEntrySchema],

        // Habits (exercise, smoking, alcohol, etc.)
        habits: [HabitSchema],

        // Daily calorie/nutrition goals and tracking
        nutritionGoals: {
            dailyCalorieGoal: { type: Number },
            dailyProteinGoal: { type: Number },
            dailyCarbsGoal: { type: Number },
            dailyFatGoal: { type: Number },
            dailyWaterGoal: { type: Number }
        },
        nutritionHistory: [NutritionEntrySchema],

        // Current medications
        medications: [MedicationSchema],

        // Known allergies
        allergies: [AllergySchema],

        // Medical conditions (current and past)
        conditions: [ConditionSchema],

        // Past checkups and scheduled appointments
        checkups: [CheckupSchema],

        // Health analysis preferences and results
        analysisPreferences: {
            receiveAIRecommendations: { type: Boolean, default: true },
            focusAreas: [{ type: String }], // e.g., ["Heart Health", "Weight Management", "Mental Health"]
            geneticFactorsConsidered: { type: Boolean, default: false }
        },

        // Personal health notes
        notes: [HealthNoteSchema],

        // Voice recordings for health journaling
        voiceRecordings: [VoiceRecordingSchema],

        // Family medical history
        familyHistory: [{
            condition: { type: String },
            relation: { type: String }, // e.g., "Mother", "Father", "Sibling"
            notes: { type: String }
        }],

        // Lifestyle factors
        lifestyle: {
            smokingStatus: { type: String, enum: ['Never', 'Former', 'Current', 'Occasional'] },
            alcoholConsumption: { type: String, enum: ['None', 'Occasional', 'Moderate', 'Heavy'] },
            exerciseFrequency: { type: String, enum: ['None', 'Light', 'Moderate', 'Active', 'Very Active'] },
            exerciseTypes: [{ type: String }], // e.g., ["Running", "Swimming", "Yoga"]
            dietType: { type: String }, // e.g., "Vegetarian", "Vegan", "Keto", "Standard"
            occupation: { type: String },
            stressLevel: { type: String, enum: ['Low', 'Moderate', 'High', 'Very High'] },
            fitnessLevel: { type: String }, // e.g., "Beginner", "Intermediate", "Advanced"
            sleepQuality: { type: Number, min: 1, max: 5 },
            sleepHoursPerNight: { type: Number },
            checkupFrequency: { type: String } // e.g., "weekly", "monthly", "yearly"
        }
    }
}, { timestamps: true });

const User = mongoose.model('User', UserSchema);

module.exports = User;
