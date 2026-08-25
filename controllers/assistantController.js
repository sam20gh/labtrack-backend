/**
 * The AI health assistant's HTTP surface.
 *
 * Every handler is scoped to `req.auth.userId`. There is no `:userId` in any path here, on
 * purpose: a conversation contains the person's symptoms in their own words, which is the
 * most sensitive thing this product stores, and an id in a URL is an id that can be edited.
 */
const Conversation = require('../models/Conversation');
const { ask, isConfigured } = require('../utils/assistantEngine');

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
        res.json({ ...serialise(conversation), available: isConfigured() });
    } catch (error) {
        console.error('❌ Failed to load conversation:', error);
        res.status(500).json({ message: 'Could not load your conversation' });
    }
};

/**
 * POST /api/assistant/chat — send a message, get a reply.
 *
 * The person's message is persisted **before** the model is called, and the reply only
 * after it succeeds. A failed or slow generation therefore loses the answer, never the
 * question — reopening the screen after a crash shows what they asked, still unanswered,
 * which is recoverable. The reverse ordering silently eats their words.
 */
exports.chat = async (req, res) => {
    try {
        const message = String(req.body?.message ?? '').trim();
        if (!message) return res.status(400).json({ message: 'Message is required' });
        if (message.length > 2000) {
            return res.status(400).json({ message: 'That message is too long. Try asking one thing at a time.' });
        }

        if (!isConfigured()) {
            return res.status(503).json({ message: 'The assistant is unavailable right now.' });
        }

        const conversation = await forUser(req.auth.userId);

        // The window the model sees, captured before the new message is appended so the
        // question is not duplicated as both history and prompt.
        const history = conversation.messages.map((m) => ({ role: m.role, text: m.text }));

        conversation.append({ role: 'user', text: message });
        await conversation.save();

        const result = await ask({ userId: req.auth.userId, message, history });

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
    }
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
