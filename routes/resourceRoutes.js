const express = require('express');
const router = express.Router();
const c = require('../controllers/resourceController');
const { authenticateToken, requireRole } = require('../middleware/authMiddleware');

/**
 * Health resources.
 *
 * The whole router sits behind a token. Reads are not personal in the way a biomarker is,
 * but every list attaches the reader's own like/save state and every Pro decision is made
 * from their account — so there is no anonymous shape of these responses worth serving, and
 * an open read surface is one more thing to remember when the library grows.
 *
 * Static segments are declared before `/:idOrSlug` throughout. A route ordered the other way
 * resolves `/filters` as a slug and answers 404 for a screen that exists.
 */
router.use(authenticateToken);

// ── browse ──────────────────────────────────────────────────────────────────
router.get('/home', c.getHub);
router.get('/categories', c.getCategories);
router.get('/filters', c.getFilters);
router.get('/authors', c.listAuthors);
router.get('/library/saved', c.getSaved);
router.get('/library/continue', c.getContinue);
router.get('/', c.listResources);

// ── authors ─────────────────────────────────────────────────────────────────
router.get('/authors/:slug', c.getAuthor);
router.post('/authors/:slug/follow', c.toggleFollow);

// ── authoring ───────────────────────────────────────────────────────────────
// Declared above `/:idOrSlug` so `POST /import` is never read as an id.
// The editorial list, which unlike `GET /` shows drafts and archived items — a draft is
// otherwise invisible to the only person who can publish it.
router.get('/admin/all', requireRole('admin'), c.listResourcesForAdmin);
router.get('/admin/stats', requireRole('admin'), c.getResourceStats);
// The editor's read. Declared after the two static /admin paths above so neither is
// swallowed as an id, and before `/:idOrSlug`, which only ever resolves published rows.
router.get('/admin/:id', requireRole('admin'), c.getResourceForEdit);
router.post('/import', requireRole('admin'), c.importResources);
router.post('/admin/categories', requireRole('admin'), c.upsertCategory);
router.post('/admin/authors', requireRole('admin'), c.upsertAuthor);
router.post('/', requireRole('admin'), c.createResource);
router.put('/:id', requireRole('admin'), c.updateResource);
router.delete('/:id', requireRole('admin'), c.deleteResource);

// ── one resource, and this reader's relationship with it ────────────────────
router.get('/:idOrSlug', c.getResource);
router.post('/:idOrSlug/view', c.recordView);
router.post('/:idOrSlug/like', c.toggleLike);
router.post('/:idOrSlug/save', c.toggleSave);
router.post('/:idOrSlug/rate', c.rateResource);
router.post('/:idOrSlug/progress', c.saveProgress);
router.post('/:idOrSlug/join', c.joinWorkshop);

module.exports = router;
