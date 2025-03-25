// routes/planRoutes.js
const express = require('express');
const router = express.Router();
const {
    createPlan,
    getPlansByUser,
    deletePlan
} = require('../controllers/planController');

const { authenticateToken } = require('../middleware/authMiddleware'); // ✅ Correct
router.post('/create', authenticateToken, createPlan); // ✅
router.get('/:userId', authenticateToken, getPlansByUser);
router.delete('/delete/:planId', authenticateToken, deletePlan);

module.exports = router;
