const mongoose = require('mongoose');

const PlanSchema = new mongoose.Schema({
    userID: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    testID: { type: mongoose.Schema.Types.ObjectId, ref: 'Test', required: true },
    structured_plan: { type: Object, required: true },
    plan: [{
        type: { type: String, required: true },
        test: { type: String },
        speciality: { type: String },
        age: { type: Number },
        year: { type: Number },
        productID: { type: mongoose.Schema.Types.ObjectId },
        productName: { type: String },
        professionalID: { type: mongoose.Schema.Types.ObjectId },
        professionalName: { type: String },
        image: { type: String, default: null } // ✅ Explicitly add the image field here!
    }],
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Plan', PlanSchema);
