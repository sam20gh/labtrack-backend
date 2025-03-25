const Plan = require('../models/Plan');
const { generateUserPlan } = require('../utils/planGenerator');
const { extractHealthPlan } = require('../utils/feedbackParser');

// POST /plans/create
const createPlan = async (req, res) => {
    try {
        const { user, feedbackText, products, professionals, testID } = req.body;

        if (!user || !feedbackText || !products || !professionals || !testID) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        const structured_plan = extractHealthPlan(feedbackText);
        const plan = generateUserPlan(feedbackText, user, products, professionals);

        const newPlan = new Plan({
            userID: user._id,
            testID,
            structured_plan,
            plan
        });

        await newPlan.save();

        res.status(201).json({ message: 'Plan created successfully', plan: newPlan });
    } catch (err) {
        console.error('❌ Error creating plan:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// GET /plans/:userId
const getPlansByUser = async (req, res) => {
    try {
        const userId = req.params.userId;
        const plans = await Plan.find({ userID: userId }).sort({ createdAt: -1 });

        const formatted = plans.map(p => ({
            _id: p._id,
            createdAt: p.createdAt,
            structured_plan: p.structured_plan || null,
            plan: p.plan || []
        }));

        res.status(200).json({ plans: formatted });
    } catch (err) {
        console.error('❌ Error fetching plans:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// DELETE /plans/delete/:planId
const deletePlan = async (req, res) => {
    try {
        const planId = req.params.planId;
        const deleted = await Plan.findByIdAndDelete(planId);

        if (!deleted) {
            return res.status(404).json({ message: 'Plan not found' });
        }

        res.status(200).json({ message: 'Plan deleted successfully' });
    } catch (err) {
        console.error('❌ Error deleting plan:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
};

module.exports = {
    createPlan,
    getPlansByUser,
    deletePlan
};
