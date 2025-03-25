const mongoose = require('mongoose');

const PlanSchema = new mongoose.Schema({
    userID: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    testID: { type: mongoose.Schema.Types.ObjectId, ref: 'Test', required: true },
    structured_plan: { type: Object, required: true },
    plan: { type: Array, default: [] }, // ✅ Add this line
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Plan', PlanSchema);
