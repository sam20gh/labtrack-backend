const express = require('express');
const router = express.Router();
const c = require('../controllers/assistantController');
const { authenticateToken } = require('../middleware/authMiddleware');

// Conversations contain the person's symptoms in their own words. Every route is scoped to
// req.auth.userId inside the controller — there is no id in a path to tamper with.
router.use(authenticateToken);

router.get('/conversation', c.getConversation);
router.post('/chat', c.chat);
router.delete('/conversation', c.clearConversation);
router.put('/preferences', c.updatePreferences);

module.exports = router;
