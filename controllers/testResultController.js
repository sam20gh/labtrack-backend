const TestResult = require('../models/testResultModel');

exports.addTestResult = async (req, res) => {
    try {
        const { patient, results, interpretation } = req.body;

        if (!patient?.user_id || !patient.date_of_test || !patient.lab_name || !patient.test_type || !results) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        const newTestResult = new TestResult({ patient, results, interpretation });
        await newTestResult.save();

        res.status(201).json({ message: 'Test result added successfully', testResult: newTestResult });
    } catch (error) {
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};
exports.getTestResults = async (req, res) => {
    try {
        const { user_id } = req.query;
        if (!user_id) return res.status(400).json({ message: 'User ID is required' });

        const testResults = await TestResult.find({ 'patient.user_id': user_id });
        if (!testResults.length) return res.status(404).json({ message: 'No test results found' });

        res.json(testResults);
    } catch (error) {
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};
