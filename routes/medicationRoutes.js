const express = require('express');
const multer = require('multer');
const router = express.Router();
const c = require('../controllers/medicationController');
const { authenticateToken } = require('../middleware/authMiddleware');

// Disk storage, matching nutritionRoutes and reportRoutes: the engine reads the file rather
// than holding a multi-megabyte base64 string in memory for the life of the request.
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 10 * 1024 * 1024 },
});

/**
 * Every route here reads or writes one person's medication record.
 *
 * That includes the catalogue: it is not personal data, but leaving a drug-lookup endpoint
 * open is a free content-scraping surface, and `/api/professionals` and `/api/deepseek`
 * being unauthenticated is already a known defect in this codebase rather than a pattern to
 * copy.
 */
router.use(authenticateToken);

router.get('/status', c.getStatus);

// The catalogue — search, browse, and one drug's plain-language entry
router.get('/catalogue', c.searchCatalogue);
router.get('/catalogue/:name', c.getCatalogueEntry);

// Interaction checking. Mounted above `/:id` so "check" is never read as an id.
router.get('/check', c.getInteractionCheck);
router.post('/check', c.runInteractionCheck);
router.post('/check/preview', c.previewInteractions);

// The schedule
router.get('/schedule', c.getSchedule);
router.get('/calendar', c.getCalendar);
router.get('/insight', c.getInsight);
router.patch('/doses/:id', c.updateDose);

// Identification. Returns a draft and writes nothing — `POST /` is what saves.
router.post('/identify', upload.single('image'), c.identifyMedication);

// Bringing the health assessment's answers in as real medications
router.post('/import', c.importFromAssessment);

// The list itself
router.get('/', c.listMedications);
router.post('/', c.createMedication);
router.put('/:id', c.updateMedication);
router.delete('/:id', c.deleteMedication);

module.exports = router;
