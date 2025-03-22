const express = require('express');
const router = express.Router();
const Plan = require('../models/Plan');
const AIFeedback = require('../models/AIFeedback');
const { authenticateToken } = require('../middleware/authMiddleware');
const { extractHealthPlan } = require('../utils/feedbackParser');

// Create a structured plan from AI feedback
router.post('/plans/create', authenticateToken, async (req, res) => {
    try {
        const { userID, testID } = req.body;

        console.log("🔍 Fetching AI feedback for testID:", testID);

        const feedbackData = await AIFeedback.findOne({ userID, testID });

        if (!feedbackData) {
            console.log("❌ No AI feedback found for testID:", testID);
            return res.status(404).json({ message: "No feedback found" });
        }

        // Convert feedback to a structured plan
        const structuredPlan = extractHealthPlan(feedbackData.feedback);

        // Save the structured plan in the database
        const newPlan = new Plan({ userID, testID, structured_plan: structuredPlan });
        await newPlan.save();

        console.log("🟢 Health plan saved successfully:", newPlan);

        return res.status(201).json({
            message: "Health plan created successfully",
            plan: newPlan
        });

    } catch (error) {
        console.error("❌ Error creating health plan:", error);
        res.status(500).json({ message: "Error creating health plan", error });
    }
});

// Fetch user's saved plans
router.get('/plans/:userID', authenticateToken, async (req, res) => {
    try {
        const { userID } = req.params;

        console.log("🔍 Fetching health plans for userID:", userID);

        const plans = await Plan.find({ userID }).sort({ createdAt: -1 });

        if (plans.length === 0) {
            console.log("❌ No health plans found for userID:", userID);
            return res.status(404).json({ message: "No health plans found" });
        }

        console.log("🟢 Health plans retrieved:", plans);
        return res.json({ plans });

    } catch (error) {
        console.error("❌ Error fetching health plans:", error);
        res.status(500).json({ message: "Error retrieving health plans", error });
    }
});
router.delete('/plans/delete/:planID', authenticateToken, async (req, res) => {
    try {
        const { planID } = req.params;

        console.log("🔍 Attempting to delete plan with ID:", planID);

        const deletedPlan = await Plan.findByIdAndDelete(planID);

        if (!deletedPlan) {
            console.log("❌ No plan found with ID:", planID);
            return res.status(404).json({ message: "Plan not found" });
        }

        console.log("🟢 Plan deleted successfully:", deletedPlan);

        return res.json({
            message: "Plan deleted successfully",
            plan: deletedPlan
        });

    } catch (error) {
        console.error("❌ Error deleting plan:", error);
        res.status(500).json({ message: "Error deleting plan", error });
    }
});
module.exports = router;
