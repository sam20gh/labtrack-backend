const express = require('express');
const router = express.Router();
const AIFeedback = require('../models/AIFeedback');
const { authenticateToken } = require('../middleware/authMiddleware');

// Fetch AI feedback for a given testID
router.get('/get/:testID', authenticateToken, async (req, res) => {
    try {
        const { testID } = req.params;

        console.log("🔍 Searching for AI feedback for testID:", testID);

        const feedback = await AIFeedback.findOne({ testID });

        if (!feedback) {
            console.log("❌ No AI feedback found for testID:", testID);
            return res.status(404).json({ message: "No feedback found" });
        }

        console.log("🟢 Found AI feedback:", feedback.feedback);
        res.json({ feedback: feedback.feedback });

    } catch (error) {
        console.error("❌ Error fetching AI feedback:", error);
        res.status(500).json({ message: "Error retrieving feedback", error });
    }
});
router.post('/save', authenticateToken, async (req, res) => {
    try {
        console.log("📢 Incoming feedback request:", req.body);

        const { userID, testID, feedback } = req.body;

        if (!userID || !testID || !feedback) {
            console.log("❌ Missing fields in request:", req.body);
            return res.status(400).json({ message: 'Missing required fields' });
        }

        const newFeedback = new AIFeedback({ userID, testID, feedback });
        await newFeedback.save();

        console.log("🟢 Feedback saved successfully:", newFeedback);
        return res.status(201).json({ message: 'Feedback saved successfully', feedback: newFeedback });

    } catch (error) {
        console.error("❌ Error saving feedback:", error);
        return res.status(500).json({ message: 'Error saving feedback', error: error.message });
    }
});

module.exports = router;
