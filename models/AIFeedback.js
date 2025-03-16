const mongoose = require('mongoose');

const AIFeedbackSchema = new mongoose.Schema({
    userID: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    testID: { type: mongoose.Schema.Types.ObjectId, ref: 'Test', required: true },
    feedback: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('AIFeedback', AIFeedbackSchema);
