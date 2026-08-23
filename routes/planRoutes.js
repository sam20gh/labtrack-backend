// routes/planRoutes.js
const express = require('express');
const router = express.Router();
const {
    createPlan,
    getPlansByUser,
    deletePlan
} = require('../controllers/planController');

const { authenticateToken } = require('../middleware/authMiddleware');
const { requireSelf, requirePlanOwner } = require('../middleware/ownership');

router.post('/create', authenticateToken, createPlan);
router.get('/:userId', authenticateToken, requireSelf('userId'), getPlansByUser);
router.delete('/delete/:planId', authenticateToken, requirePlanOwner(), deletePlan);

module.exports = router;
