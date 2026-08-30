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
    // Supabase auth user id (claims.sub). Sparse: legacy accounts have none until they
    // first sign in through Supabase, at which point authMiddleware links by email.
    supabaseId: { type: String, unique: true, sparse: true, default: undefined },
    /** Stripe customer, so saved cards and receipts stay with the person across orders. */
    stripeCustomerId: { type: String, default: undefined },

    /**
     * Expo push tokens, one per device. An array rather than a single field: people use a
     * phone and a tablet, and reinstalling issues a fresh token while the old one lingers.
     * Tokens Expo reports as unregistered are pruned automatically.
     */
    pushTokens: [{
        token: { type: String, required: true },
        platform: { type: String, enum: ['ios', 'android'], default: undefined },
        deviceName: { type: String },
        registeredAt: { type: Date, default: Date.now },
    }],

    notificationPreferences: {
        enabled: { type: Boolean, default: true },
        /** Days before a due date to notify. 0 means on the day itself. */
        offsetDays: { type: [Number], default: [7, 0] },
        overdueReminders: { type: Boolean, default: true },
        orderUpdates: { type: Boolean, default: true },
        resultsReady: { type: Boolean, default: true },
        /** Local hours during which a notification may be sent. */
        quietHours: {
            start: { type: Number, min: 0, max: 23, default: 22 },
            end: { type: Number, min: 0, max: 23, default: 8 },
        },
    },
    firstName: { type: String, default: '' },
    lastName: { type: String, default: '' },
    username: { type: String, unique: true, required: true },
    // Lowercased on write: Supabase normalises emails, and a case mismatch here would
    // create a duplicate account instead of linking (see KNOWN-ISSUES #25).
    email: { type: String, unique: true, required: true, lowercase: true, trim: true },
    phone: { type: String, default: '' },
    dob: { type: String, default: '' },
    gender: { type: String, enum: ['Male', 'Female', 'Other', null], default: null },
    height: { type: Number, default: null },
    weight: { type: Number, default: null },
    bloodType: { type: String, default: null }, // e.g., "A+", "O-", "AB+"
    // Required only for legacy email/password accounts. Supabase-backed accounts hold no
    // password here — Supabase owns the credential.
    password: {
        type: String,
        required: function () { return !this.supabaseId; }
    },

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
    },

    /**
     * The measured profile.
     *
     * `healthAssessment` is what the person said about themselves once, during onboarding.
     * This is what the trackers have since observed, and where the two disagree this is the
     * one that describes them now: someone who answered "Beginner" in March and has since
     * synced four months of running is not a beginner, and every surface that reads the
     * assessment to personalise itself was getting that wrong.
     *
     * **Kept alongside the assessment, never written over it.** The same rule the medication
     * checker follows for `healthAssessment.medications`: the onboarding answers are a
     * snapshot a clinician may have reviewed, and letting a device sync silently rewrite them
     * destroys the record of what the person actually reported. Consumers read `observed`
     * first and fall back to the assessment, which is exactly what `labtrackScore` does with
     * its `observed` / `reported` provenance.
     *
     * Every field is derived, rebuilt by `profileObserver.refresh()` from the rows behind it,
     * and carries the window it was derived over. Nothing here is ever edited by hand — an
     * editable field would drift from the data it claims to summarise, which is the mistake
     * `DailyMetrics` documents at length.
     */
    observed: {
        /** Most recent weight from a scale, a health store, or a manual weight log. */
        weightKg: { type: Number, default: null },
        weightAt: { type: Date, default: null },
        weightSource: { type: String, default: null },

        /** Median resting heart rate over the window. */
        restingBpm: { type: Number, default: null },
        /** Median HRV in ms, where the device reports it. */
        hrvMs: { type: Number, default: null },

        /** Mean minutes asleep a night, and the mean nightly sleep score. */
        sleepMinutes: { type: Number, default: null },
        sleepScore: { type: Number, default: null },
        nightsRecorded: { type: Number, default: 0 },

        /** Weekly means, so the plan can be written against what someone actually does. */
        weeklyExerciseMin: { type: Number, default: null },
        weeklySessions: { type: Number, default: null },
        dailySteps: { type: Number, default: null },

        /**
         * The assessment's `fitnessLevel` vocabulary, derived from the above rather than
         * claimed — so the two are directly comparable and a consumer can swap one for the
         * other without translating.
         */
        fitnessLevel: { type: String, enum: ['Beginner', 'Intermediate', 'Advanced', null], default: null },
        /** The assessment's `exerciseFrequency` vocabulary, derived the same way. */
        exerciseFrequency: {
            type: String,
            enum: ['None', 'Light', 'Moderate', 'Active', 'Very Active', null],
            default: null,
        },
        /** Activity types actually recorded, commonest first. Not the ones they said they like. */
        exerciseTypes: { type: [String], default: undefined },

        /** Mean daily calories from logged meals, and how many days carried a log. */
        dailyCalories: { type: Number, default: null },
        daysLogged: { type: Number, default: 0 },

        /** Dose adherence over the window, 0-100. Null when nothing came due. */
        medicationAdherence: { type: Number, default: null },

        /**
         * Mean blood pressure over the window, and whether any single reading in it was in
         * the crisis range. The flag is kept because a mean is exactly the operation that
         * would hide one.
         */
        bloodPressure: {
            systolic: { type: Number, default: null },
            diastolic: { type: Number, default: null },
            category: { type: String, default: null },
            readings: { type: Number, default: 0 },
            hadCrisis: { type: Boolean, default: false },
        },

        /** Mean water logged on the days anything was logged, and how many days those were. */
        dailyWaterMl: { type: Number, default: null },
        waterDaysLogged: { type: Number, default: 0 },

        /** The window everything above was derived over, and when that happened. */
        windowDays: { type: Number, default: 30 },
        refreshedAt: { type: Date, default: null },
    },
}, { timestamps: true });

const User = mongoose.model('User', UserSchema);

module.exports = User;
