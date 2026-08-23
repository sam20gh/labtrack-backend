const PlanItem = require('../models/PlanItem');

/** GET /api/plan-items — the caller's timeline, optionally filtered by status. */
exports.getPlanItems = async (req, res) => {
    try {
        const query = { userId: req.auth.userId };
        if (req.query.status) query.status = { $in: String(req.query.status).split(',') };
        if (req.query.type) query.type = { $in: String(req.query.type).split(',') };

        const items = await PlanItem.find(query).sort({ dueDate: 1 }).lean();

        // Grouped the way the timeline renders: overdue first, then by year
        const grouped = items.reduce((acc, item) => {
            const key = ['urgent', 'due'].includes(item.status)
                ? 'urgent'
                : String(new Date(item.dueDate).getFullYear());
            (acc[key] = acc[key] || []).push(item);
            return acc;
        }, {});

        res.json({ items, grouped });
    } catch (error) {
        console.error('❌ Error fetching plan items:', error);
        res.status(500).json({ message: 'Error fetching plan items', error: error.message });
    }
};

/** POST /api/plan-items — add an item manually. */
exports.createPlanItem = async (req, res) => {
    try {
        const item = await PlanItem.create({
            ...req.body,
            userId: req.auth.userId,
            source: req.body.source || 'user',
            status: PlanItem.deriveStatus(req.body.dueDate),
        });
        res.status(201).json({ message: 'Plan item created', item });
    } catch (error) {
        res.status(400).json({ message: 'Error creating plan item', error: error.message });
    }
};

/**
 * PATCH /api/plan-items/:id/status — move an item through its lifecycle.
 * Only the transitions a user can legitimately drive are accepted; `urgent`/`due` are
 * derived from the due date by the daily sweep and cannot be set by hand.
 */
const USER_SETTABLE = ['ordered', 'booked', 'completed', 'dismissed'];

exports.updateStatus = async (req, res) => {
    try {
        const { status, orderId, appointmentId, resultingTestResultId } = req.body;

        if (!USER_SETTABLE.includes(status)) {
            return res.status(400).json({
                message: `status must be one of: ${USER_SETTABLE.join(', ')}`,
            });
        }

        const updates = { status };
        if (orderId) updates.orderId = orderId;
        if (appointmentId) updates.appointmentId = appointmentId;
        if (resultingTestResultId) updates.resultingTestResultId = resultingTestResultId;
        if (status === 'completed') updates.completedAt = new Date();

        const item = await PlanItem.findOneAndUpdate(
            { _id: req.params.id, userId: req.auth.userId },
            { $set: updates },
            { new: true, runValidators: true }
        );
        if (!item) return res.status(404).json({ message: 'Plan item not found' });

        res.json({ message: 'Plan item updated', item });
    } catch (error) {
        res.status(400).json({ message: 'Error updating plan item', error: error.message });
    }
};

/** DELETE /api/plan-items/:id */
exports.deletePlanItem = async (req, res) => {
    try {
        const deleted = await PlanItem.findOneAndDelete({ _id: req.params.id, userId: req.auth.userId });
        if (!deleted) return res.status(404).json({ message: 'Plan item not found' });
        res.json({ message: 'Plan item deleted' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting plan item', error: error.message });
    }
};
