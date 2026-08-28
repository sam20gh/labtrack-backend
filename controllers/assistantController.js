/**
 * The AI health assistant's HTTP surface.
 *
 * Every handler is scoped to `req.auth.userId`. There is no `:userId` in any path here, on
 * purpose: a conversation contains the person's symptoms in their own words, which is the
 * most sensitive thing this product stores, and an id in a URL is an id that can be edited.
 */
const fs = require('fs');
const Conversation = require('../models/Conversation');
const { ask, isConfigured } = require('../utils/assistantEngine');
const transcription = require('../utils/transcriptionEngine');
const imageStore = require('../utils/imageStore');

/**
 * Image types Claude accepts. **HEIC is not among them**, whatever the phone's gallery
 * says — `expo-image-picker` transcodes to JPEG on the way out, and a HEIC that slips
 * through is rejected here with a readable message rather than deep inside the model call.
 */
const ACCEPTED_IMAGE_MEDIA = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** 5MB, the per-image ceiling on the Anthropic API. The client downscales well below it. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * What the app is allowed to offer.
 *
 * Sent with the conversation so the composer can render the microphone and the camera in
 * their true state on first paint. A control that appears live and fails on tap is worse
 * than one that arrives disabled with a reason attached.
 */
const capabilities = () => ({
    text: isConfigured(),
    // Vision rides on the same key as the conversation; there is no separate switch.
    vision: isConfigured(),
    voice: isConfigured() && transcription.isConfigured(),
});

/** The person's conversation document, created on first contact. */
const forUser = async (userId) => {
    const existing = await Conversation.findOne({ userId });
    if (existing) return existing;
    return Conversation.create({ userId, messages: [] });
};

/** Shape sent to the app. Mongoose internals stay on the server. */
const serialise = (conversation) => ({
    mode: conversation.mode,
    acceptedPrecautions: Boolean(conversation.acceptedPrecautionsAt),
    lifetimeMessages: conversation.lifetimeMessages,
    clearedAt: conversation.clearedAt,
    messages: conversation.messages.map((m) => ({
        role: m.role,
        text: m.text,
        attachment: m.attachment || null,
        widget: m.widget || null,
        suggestions: m.suggestions || [],
        escalate: Boolean(m.escalate),
        createdAt: m.createdAt,
    })),
});

/** GET /api/assistant/conversation — the transcript and the person's assistant settings. */
exports.getConversation = async (req, res) => {
    try {
        const conversation = await forUser(req.auth.userId);
        res.json({ ...serialise(conversation), available: isConfigured(), capabilities: capabilities() });
    } catch (error) {
        console.error('❌ Failed to load conversation:', error);
        res.status(500).json({ message: 'Could not load your conversation' });
    }
};

/**
 * What the transcript records when a picture arrived with no words.
 *
 * Sent to the model as the question and stored as the message text, so the bubble is not
 * blank and a replayed turn still says what was being asked. The person did ask something
 * by sending it; this is that question written down.
 */
const IMAGE_ONLY_PROMPT = 'What can you tell me about this?';

/**
 * POST /api/assistant/chat — send a message, get a reply.
 *
 * Accepts JSON, or multipart when a photograph comes with the message. Multer only
 * populates `req.file` for the latter, so the two share one handler rather than diverging
 * into a second endpoint that would have to repeat the persistence ordering below.
 *
 * The person's message is persisted **before** the model is called, and the reply only
 * after it succeeds. A failed or slow generation therefore loses the answer, never the
 * question — reopening the screen after a crash shows what they asked, still unanswered,
 * which is recoverable. The reverse ordering silently eats their words.
 */
exports.chat = async (req, res) => {
    // Multer has already written any upload to disk; it goes whatever happens below.
    const tempPath = req.file?.path || null;

    try {
        const typed = String(req.body?.message ?? '').trim();
        // A photograph is itself a question, so it lifts the requirement to type one.
        const message = typed || (req.file ? IMAGE_ONLY_PROMPT : '');

        if (!message) return res.status(400).json({ message: 'Message is required' });
        if (message.length > 2000) {
            return res.status(400).json({ message: 'That message is too long. Try asking one thing at a time.' });
        }

        if (!isConfigured()) {
            return res.status(503).json({ message: 'The assistant is unavailable right now.' });
        }

        if (req.file) {
            if (!ACCEPTED_IMAGE_MEDIA.includes(req.file.mimetype)) {
                return res.status(400).json({
                    message: `That image format isn't supported: ${req.file.mimetype}. Try a JPEG or PNG.`,
                });
            }
            if (req.file.size > MAX_IMAGE_BYTES) {
                return res.status(400).json({ message: 'That image is too large. The limit is 5MB.' });
            }
        }

        // `voice` is the app telling us these words were spoken rather than typed. It
        // changes nothing about how the message is answered — the transcript is text by
        // the time it arrives — but it is recorded so the bubble can show it, which is
        // what makes a mis-transcription legible rather than baffling.
        const spoken = req.body?.spoken === 'true' || req.body?.spoken === true;

        const conversation = await forUser(req.auth.userId);

        // The window the model sees, captured before the new message is appended so the
        // question is not duplicated as both history and prompt.
        const history = conversation.messages.map((m) => ({ role: m.role, text: m.text }));

        // Stored before the model call, in parallel with nothing — the upload is the only
        // thing between the person pressing send and their message being safe. Failure
        // here costs the thumbnail, never the message: see `imageStore.uploadImageOrNull`.
        let attachment = null;
        if (req.file) {
            attachment = {
                kind: 'image',
                mimeType: req.file.mimetype,
                url: await imageStore.uploadImageOrNull(tempPath),
            };
        } else if (spoken) {
            attachment = { kind: 'voice', url: null, mimeType: null };
        }

        conversation.append({ role: 'user', text: message, attachment });
        await conversation.save();

        const result = await ask({
            userId: req.auth.userId,
            message,
            history,
            image: req.file
                ? { data: fs.readFileSync(tempPath), mediaType: req.file.mimetype }
                : null,
        });

        if (!result.ok) {
            return res.status(502).json({ message: result.error });
        }

        const { reply, widget, suggestions, escalate } = result.data;
        const assistantMessage = {
            role: 'assistant',
            text: reply,
            widget: widget || null,
            suggestions: suggestions || [],
            escalate: Boolean(escalate),
            createdAt: new Date(),
        };

        conversation.append(assistantMessage);
        await conversation.save();

        console.log(`💬 Assistant replied to ${req.auth.userId} (${result.usage?.input_tokens ?? '?'} in, ${result.usage?.output_tokens ?? '?'} out, cache read ${result.usage?.cache_read_input_tokens ?? 0})`);

        res.json({ message: assistantMessage, lifetimeMessages: conversation.lifetimeMessages });
    } catch (error) {
        console.error('❌ Assistant chat failed:', error);
        res.status(500).json({ message: 'The assistant could not reply' });
    } finally {
        // Match nutritionController and reportIngestionController: the temp file goes
        // whatever happened above, including the early returns.
        if (tempPath) fs.unlink(tempPath, () => { });
    }
};

/**
 * POST /api/assistant/transcribe — turn a recording into text.
 *
 * Deliberately **not** part of `/chat`. Voice Mode shows the person their transcript and
 * lets them cancel before anything is sent, and the design's confirm/discard pair is only
 * honest if the transcription step commits nothing. Sending here writes nothing to the
 * conversation; the app then posts the text to `/chat` like any other message.
 *
 * The recording is not kept. It exists as a temp file for the length of one provider call
 * and is unlinked in `finally` — see the note on `Conversation.AttachmentSchema`.
 */
exports.transcribe = async (req, res) => {
    const tempPath = req.file?.path || null;

    try {
        if (!transcription.isConfigured()) {
            return res.status(503).json({
                message: 'Voice input is unavailable. You can type your question instead.',
                typingAvailable: true,
            });
        }
        if (!req.file) return res.status(400).json({ message: 'No recording uploaded' });

        if (!transcription.ACCEPTED_MEDIA.includes(req.file.mimetype)) {
            return res.status(400).json({ message: `Unsupported audio type: ${req.file.mimetype}` });
        }
        if (req.file.size > transcription.MAX_BYTES) {
            return res.status(400).json({ message: 'That recording is too long.' });
        }

        const language = typeof req.body?.language === 'string' ? req.body.language.slice(0, 5) : undefined;
        const result = await transcription.transcribe(tempPath, language);

        if (!result.ok) {
            // 422 rather than 502 when words simply were not heard: nothing is broken, and
            // the app's response is to invite another attempt rather than to show an error.
            const status = /make out any words/.test(result.error) ? 422 : 502;
            return res.status(status).json({ message: result.error, typingAvailable: true });
        }

        console.log(`🎙️  Transcribed ${req.file.size} bytes for ${req.auth.userId} (${result.model})`);
        res.json({ text: result.text });
    } catch (error) {
        console.error('❌ Transcription request failed:', error);
        res.status(500).json({ message: 'That recording could not be transcribed', typingAvailable: true });
    } finally {
        if (tempPath) fs.unlink(tempPath, () => { });
    }
};

/**
 * GET /api/assistant/status — which inputs the composer may offer.
 *
 * `/conversation` carries the same object, and the screens that open on it use that. This
 * exists for the composer alone, which is mounted in places that have no reason to load a
 * transcript, and mirrors `/nutrition/status`.
 */
exports.getStatus = async (_req, res) => {
    res.json(capabilities());
};

/**
 * DELETE /api/assistant/conversation — clear history and reset memory.
 *
 * Empties the transcript and stamps `clearedAt`. `lifetimeMessages` is deliberately kept:
 * the person asked to delete their conversations, not to have the app claim they never
 * used it. Nothing else in the product reads the transcript, so this genuinely is the
 * assistant forgetting — its knowledge of them comes from their records, which this does
 * not touch and which the settings screen says so.
 */
exports.clearConversation = async (req, res) => {
    try {
        const conversation = await forUser(req.auth.userId);
        conversation.messages = [];
        conversation.clearedAt = new Date();
        await conversation.save();

        console.log(`🧹 Assistant memory cleared for ${req.auth.userId}`);
        res.json(serialise(conversation));
    } catch (error) {
        console.error('❌ Failed to clear conversation:', error);
        res.status(500).json({ message: 'Could not clear your conversation' });
    }
};

/**
 * PUT /api/assistant/preferences — interaction mode and precautions acceptance.
 *
 * Server-side rather than in AsyncStorage because both are answers the person gave once:
 * reinstalling the app should not re-ask them to accept the precautions, and should not
 * drop them back into a mode they moved away from.
 */
exports.updatePreferences = async (req, res) => {
    try {
        const conversation = await forUser(req.auth.userId);

        const { mode, acceptedPrecautions } = req.body || {};
        if (mode !== undefined) {
            if (!['chat', 'immersive'].includes(mode)) {
                return res.status(400).json({ message: 'mode must be "chat" or "immersive"' });
            }
            conversation.mode = mode;
        }
        // One-way: acceptance can be given but not withdrawn through this endpoint, so a
        // malformed client cannot quietly un-accept a safety screen the person has read.
        if (acceptedPrecautions === true && !conversation.acceptedPrecautionsAt) {
            conversation.acceptedPrecautionsAt = new Date();
        }

        await conversation.save();
        res.json(serialise(conversation));
    } catch (error) {
        console.error('❌ Failed to update assistant preferences:', error);
        res.status(500).json({ message: 'Could not save your preferences' });
    }
};
