const mongoose = require('mongoose');

const TestResultSchema = new mongoose.Schema({
    patient: {
        user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        date_of_test: { type: String, required: true },
        lab_name: { type: String, required: true },
        test_type: { type: String, required: true }
    },
    results: { type: Object, required: true },
    interpretation: { type: String, required: true }
});

module.exports = mongoose.model('TestResult', TestResultSchema);
