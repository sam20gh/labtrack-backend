const express = require('express');
const router = express.Router();
const c = require('../controllers/staffController');
const { authenticateToken, requireRole, requireMfa } = require('../middleware/authMiddleware');

/**
 * Staff administration.
 *
 * Admin-only for the whole router, without exception: every route here either reveals who
 * holds portal access or changes it, and a role is what grants sight of other people's
 * medical records.
 */
router.use(authenticateToken, requireRole('admin'), requireMfa);

router.get('/status', c.getStaffStatus);

/**
 * The access log. Declared before `/:supabaseId/...` for the usual reason, and admin-only
 * like everything else here: it names every patient every clinician has opened.
 */
router.get('/access-log', c.getAccessLog);
router.get('/access-log/export', c.exportAccessLog);

router.get('/', c.listStaff);
router.post('/invite', c.inviteStaff);
router.patch('/:supabaseId/role', c.setStaffRole);

module.exports = router;
