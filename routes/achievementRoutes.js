const express = require('express');
const router = express.Router();
const c = require('../controllers/achievementController');
const { authenticateToken } = require('../middleware/authMiddleware');

/**
 * Achievements.
 *
 * **The card route is mounted above the token check on purpose, and it is the only route in
 * this API that is.** A share link is opened by whoever the person sent it to — in a WhatsApp
 * thread, on somebody else's phone, by Facebook's unfurler — none of which hold a LabTrack
 * session. Requiring one would mean the card never renders for the audience it exists for.
 *
 * What makes that safe is not the route, it is `cardForToken`: the token is 32 unguessable
 * characters, the response carries the badge and a chosen display name and nothing else, and
 * the person can revoke it. See the handler.
 *
 * Everything below it reads or writes one person's own record and is behind the token.
 */
router.get('/card/:token', c.cardForToken);

router.use(authenticateToken);

router.get('/', c.getAchievements);
router.get('/stats', c.getStats);
router.get('/leaderboard', c.getLeaderboard);
router.put('/leaderboard', c.updateLeaderboardProfile);
router.post('/seen', c.markSeen);
router.post('/evaluate', c.recompute);

// Last: `/:key` would otherwise swallow `/stats` and `/leaderboard`.
router.get('/:key', c.getAchievement);
router.post('/:key/share', c.shareAchievement);
router.delete('/:key/share', c.revokeShare);

module.exports = router;
