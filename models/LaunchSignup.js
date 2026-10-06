const mongoose = require('mongoose');

const LaunchSignupSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, maxlength: 254 },
    consentVersion: { type: String, required: true, default: 'launch-notification-v1' },
    consentAt: { type: Date, required: true, default: Date.now },
    source: { type: String, enum: ['homepage'], default: 'homepage' },
}, { timestamps: true });

module.exports = mongoose.model('LaunchSignup', LaunchSignupSchema);