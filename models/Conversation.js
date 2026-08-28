/**
 * The person's ongoing conversation with the AI health assistant.
 *
 * **One document per user, not one per thread.** The design has a single continuing
 * relationship with "Dr. LabTrack" rather than a list of chats, and a single document keeps
 * the read path to one query on a screen that opens on every tab switch.
 *
 * Two counters rather than one, because they answer different questions:
 *   - `messages` is the live transcript, and clearing memory empties it.
 *   - `lifetimeMessages` survives a clear, so the settings screen can still say how much
 *     the assistant has been used. Deleting the history is a privacy action; it is not a
 *     claim that the conversations never happened.
 *
 * Transcripts are capped at `HISTORY_LIMIT` on write. Without a cap this document grows
 * without bound and eventually exceeds the 16 MB BSON limit — silently, at the worst
 * possible moment, on a `save()` inside a user's message.
 */
const mongoose = require('mongoose');

/**
 * How many messages are retained. The model is sent a shorter window than this (see
 * `assistantEngine.HISTORY_WINDOW`); the surplus exists so the person can scroll back
 * further than the assistant can remember, which is the honest arrangement — the
 * alternative is a transcript that visibly loses messages.
 */
const HISTORY_LIMIT = 200;

/**
 * A rendered card attached to an assistant reply.
 *
 * Deliberately one flexible shape rather than a discriminated union per widget type. The
 * kit ships 23 card variants that differ in accent and icon far more than in structure —
 * nearly all of them are a title plus some combination of stat tiles, list rows, and a
 * progress bar. Encoding that as one schema means adding a card type is a `kind` value and
 * a frontend icon, not a schema migration plus a new renderer.
 */
const WidgetSchema = new mongoose.Schema({
    kind: { type: String },
    title: { type: String },
    subtitle: { type: String, default: null },
    stats: [{
        label: { type: String },
        value: { type: String },
        unit: { type: String, default: null },
        flag: { type: String, default: null },
        _id: false,
    }],
    rows: [{
        title: { type: String },
        subtitle: { type: String, default: null },
        meta: { type: String, default: null },
        flag: { type: String, default: null },
        _id: false,
    }],
    progress: {
        type: new mongoose.Schema({
            label: { type: String },
            value: { type: Number },
            max: { type: Number },
        }, { _id: false }),
        default: null,
    },
}, { _id: false });

/**
 * How a message arrived, when it arrived as more than typed text.
 *
 * Two kinds, and they store different amounts on purpose:
 *
 *   - `image` keeps the delivery URL. The picture is half of what was asked — "what is
 *     this rash" is unreadable without it — so the transcript has to be able to draw it
 *     again on reopen. `url` is null when image storage is unconfigured or refused the
 *     upload; the model still saw the picture, the transcript just cannot redraw it.
 *   - `voice` keeps **nothing but the marker**. `text` is the transcript, which is the
 *     part that has meaning; the audio itself is a recording of someone describing their
 *     symptoms out loud, and retaining that is a data-protection decision this feature is
 *     not the place to make quietly. The flag exists so the bubble can say the words were
 *     spoken rather than typed, which matters when a transcription has misheard something.
 */
const AttachmentSchema = new mongoose.Schema({
    kind: { type: String, enum: ['image', 'voice'], required: true },
    url: { type: String, default: null },
    mimeType: { type: String, default: null },
}, { _id: false });

const MessageSchema = new mongoose.Schema({
    role: { type: String, enum: ['user', 'assistant'], required: true },
    text: { type: String, required: true },
    attachment: { type: AttachmentSchema, default: null },
    widget: { type: WidgetSchema, default: null },
    /** Follow-up chips offered with an assistant reply. */
    suggestions: [{ type: String }],
    /**
     * The assistant judged that this person should speak to a clinician now. Stored rather
     * than recomputed so the banner stays on the message when the transcript is reloaded —
     * a safety signal that disappears on refresh is worse than one that was never shown.
     */
    escalate: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
}, { _id: false });

const ConversationSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    messages: [MessageSchema],
    lifetimeMessages: { type: Number, default: 0 },
    /** When the person last cleared their history, for the settings screen. */
    clearedAt: { type: Date, default: null },
    /** Which mode they chose at the interaction picker, so the app opens where they left off. */
    mode: { type: String, enum: ['chat', 'immersive'], default: 'chat' },
    /** Set when they accept the precautions screen. Absent means they have not seen it. */
    acceptedPrecautionsAt: { type: Date, default: null },
}, { timestamps: true });

/** Append a message, enforcing the retention cap in the same operation. */
ConversationSchema.methods.append = function append(message) {
    this.messages.push(message);
    if (this.messages.length > HISTORY_LIMIT) {
        this.messages.splice(0, this.messages.length - HISTORY_LIMIT);
    }
    this.lifetimeMessages += 1;
    return this;
};

module.exports = mongoose.model('Conversation', ConversationSchema);
module.exports.HISTORY_LIMIT = HISTORY_LIMIT;
