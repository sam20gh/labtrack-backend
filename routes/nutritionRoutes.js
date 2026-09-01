const express = require('express');
const multer = require('multer');
const router = express.Router();
const c = require('../controllers/nutritionController');
const { authenticateToken } = require('../middleware/authMiddleware');

// Disk storage, matching reportRoutes: the analyser reads the file rather than holding a
// multi-megabyte base64 string in memory for the life of the request.
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 10 * 1024 * 1024 },
});

// Every route here reads or writes one person's dietary record.
router.use(authenticateToken);

router.get('/status', c.getStatus);

router.get('/plan', c.getNutritionPlan);
router.put('/plan', c.upsertNutritionPlan);

router.get('/day', c.getDay);
router.get('/history', c.getHistory);
router.get('/gallery', c.getGallery);
router.get('/insight', c.getInsight);
router.get('/calendar', c.getCalendar);

// Suggestions are cached on a signature of the plan and the day's gap, so this is a read
// even though it can end in a model call. `?refresh=1` forces a new set.
router.get('/recommendations', c.getRecommendations);

// Analysis returns a draft for review; neither route writes to the record.
router.post('/analyse', upload.single('image'), c.analyseMealPhoto);
router.post('/estimate', c.estimateFromDescription);

router.get('/meals/:id', c.getMeal);
router.post('/meals', c.createMeal);
router.patch('/meals/:id', c.updateMeal);
router.delete('/meals/:id', c.deleteMeal);

module.exports = router;
