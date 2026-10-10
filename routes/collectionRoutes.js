const express = require('express');
const { rateLimit } = require('express-rate-limit');
const c = require('../controllers/collectionController');
const { authenticateToken, requireRole } = require('../middleware/authMiddleware');

/**
 * Home sample collection. Three tiers, in this order on purpose:
 *
 *   public    what a market offers, and free slots — the website shows both to people with
 *             no account, so these carry no token and no personal data
 *   customer  the signed-in person's own visits, always matched on `req.auth.userId`
 *   admin     the timetable and everything done at the door, until technicians have their
 *             own role and app (phase 3b / 4) — these are the endpoints that app will call
 *
 * A sub-app rather than a Router so the public rate limit can trust Render's proxy, the way
 * `checkoutRoutes` does.
 */
const router = express();
router.set('trust proxy', process.env.RENDER === 'true' ? 1 : false);

const publicLimit = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { message: 'Too many requests. Please try again shortly.' },
});

router.get('/market', publicLimit, c.getMarket);
router.get('/slots', publicLimit, c.getSlots);

const admin = [authenticateToken, requireRole('admin')];
// Admin before `/visits/:id`, so `admin` is never read as a visit id.
router.get('/admin/visits', admin, c.adminDay);
router.get('/admin/visits/:id', admin, c.adminGet);
router.patch('/admin/visits/:id', admin, c.adminAssign);
router.post('/admin/assign-day', admin, c.adminAutoAssign);
router.post('/admin/visits/:id/complete', admin, c.adminComplete);
router.post('/admin/visits/:id/missed', admin, c.adminMissed);
router.post('/admin/visits/:id/reschedule', admin, c.adminReschedule);
router.post('/admin/visits/:id/cancel', admin, c.adminCancel);
router.post('/admin/specimens/receive', admin, c.adminReceive);
router.get('/admin/manifests/:code', admin, c.adminManifest);
router.post('/admin/manifests/:code/receive', admin, c.adminReceiveManifest);
router.get('/admin/specimens/:barcode', admin, c.adminSpecimen);

router.get('/visits', authenticateToken, c.listMine);
router.post('/visits', authenticateToken, c.bookMine);
router.get('/visits/:id', authenticateToken, c.getMine);
router.get('/visits/:id/pass', authenticateToken, c.getPass);
router.post('/visits/:id/reschedule', authenticateToken, c.rescheduleMine);
router.post('/visits/:id/cancel', authenticateToken, c.cancelMine);

module.exports = router;
