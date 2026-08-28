const express = require('express');
const multer = require('multer');
const router = express.Router();
const c = require('../controllers/assistantController');
const { authenticateToken } = require('../middleware/authMiddleware');

// Disk storage, matching nutritionRoutes and reportRoutes: the handler streams or reads
// the file, rather than holding megabytes of base64 in memory for the life of the request.
// The two limits differ because the payloads do — an image goes to Claude, which caps at
// 5MB; a recording goes to a Whisper-compatible endpoint, which caps at 25MB.
const uploadImage = multer({ dest: 'uploads/', limits: { fileSize: 5 * 1024 * 1024 } });
const uploadAudio = multer({ dest: 'uploads/', limits: { fileSize: 25 * 1024 * 1024 } });

// Conversations contain the person's symptoms in their own words. Every route is scoped to
// req.auth.userId inside the controller — there is no id in a path to tamper with.
router.use(authenticateToken);

router.get('/status', c.getStatus);
router.get('/conversation', c.getConversation);

// `upload.single` is a no-op on a JSON request, so the same handler serves a typed
// question and a photographed one. Splitting them would duplicate the ordering that keeps
// a person's message safe when a reply fails.
router.post('/chat', uploadImage.single('image'), c.chat);

// Transcription writes nothing to the conversation; the app posts the text to /chat after
// the person has read it back. See the handler.
router.post('/transcribe', uploadAudio.single('audio'), c.transcribe);

router.delete('/conversation', c.clearConversation);
router.put('/preferences', c.updatePreferences);

module.exports = router;
