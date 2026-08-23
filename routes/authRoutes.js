const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { requireSupabaseIdentity } = require('../middleware/authMiddleware');

// Professional login (legacy credential flow)
router.post('/login', authController.loginProfessional);

// Create or link the LabTrack account behind a Supabase identity.
// Called by the client right after Supabase sign-in/sign-up.
router.post('/supabase/sync', requireSupabaseIdentity, authController.syncSupabaseUser);

module.exports = router;
