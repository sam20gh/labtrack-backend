// routes/planRoutes.js
const express = require('express');
const router = express.Router();
const {
    createPlan,
    getPlansByUser,
    deletePlan
} = require('../controllers/planController');

const verifyToken = require('../middleware/auth'); // Auth middleware

router.post('/create', verifyToken, createPlan);
router.get('/:userId', verifyToken, getPlansByUser);
router.delete('/delete/:planId', verifyToken, deletePlan);

module.exports = router;
