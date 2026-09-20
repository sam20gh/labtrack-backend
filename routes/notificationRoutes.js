const express = require('express');
const router = express.Router();
const c = require('../controllers/notificationController');
const { authenticateToken, requireRole } = require('../middleware/authMiddleware');

router.use(authenticateToken);

/* ── The notification centre ─────────────────────────────────────────────── *
 * Every route here is scoped to `req.auth.userId` inside the controller rather than by a
 * `requireSelf` on a path parameter, because there is no id in the path to check: an
 * inbox is only ever your own. A notification id that is not yours answers 404, not 403 —
 * the call `middleware/ownership.js` makes, so the endpoint cannot be used to ask whether
 * an id exists.
 */
router.get('/', c.list);
router.get('/unread-count', c.unreadCount);
router.post('/read-all', c.markAllRead);

/* ── Device registration and preferences ─────────────────────────────────── *
 * These are declared BEFORE `/:id` and they have to be. Express matches in declaration
 * order, so a `DELETE /register` reaching a `DELETE /:id` declared above it is read as a
 * dismissal of a notification whose id is the literal string "register" — which answers
 * 404 and leaves the device registered. Nothing errors, and the symptom is a person who
 * turned notifications off still receiving them.
 */
router.post('/register', c.registerToken);
router.delete('/register', c.unregisterToken);
router.get('/preferences', c.getPreferences);
router.put('/preferences', c.updatePreferences);

/* ── The two id routes, last ─────────────────────────────────────────────── */
router.patch('/:id/read', c.markRead);
router.delete('/:id', c.dismiss);

/**
 * Two tests, because there are two deliveries and they fail separately. `/test` proves a
 * push reaches this device; `/self-test` proves a card reaches the centre, which works
 * with no device registered at all.
 */
router.post('/test', c.sendTest);
router.post('/self-test', c.sendSelfTest);

// Operational trigger — the schedule runs it daily, this is for verification
router.post('/run-reminders', requireRole('admin'), c.triggerReminders);

module.exports = router;
