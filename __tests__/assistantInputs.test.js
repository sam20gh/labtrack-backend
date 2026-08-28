/**
 * The assistant's non-text inputs.
 *
 * A photograph and a spoken question both reach the model as an ordinary turn, but the
 * paths that get them there have failure modes text does not. These lock in the ones that
 * would be silent: a picture that is stored and then lost, a temp file left behind, a
 * capability advertised that the server cannot actually back, and — the one that matters
 * most — a person's message going missing because something upstream of the model failed.
 *
 * `assistantEngine` and `imageStore` are mocked. Neither the Anthropic API nor Cloudflare
 * belongs in a test run, and what is being checked here is the controller's ordering and
 * bookkeeping around them, not their behaviour.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');

jest.mock('../utils/assistantEngine', () => ({
    isConfigured: jest.fn(() => true),
    ask: jest.fn(async () => ({
        ok: true,
        data: { reply: 'Here is what I can see.', widget: null, suggestions: [], escalate: false },
        usage: {},
    })),
}));

jest.mock('../utils/imageStore', () => ({
    isConfigured: jest.fn(() => true),
    uploadImageOrNull: jest.fn(async () => 'https://imagedelivery.net/acct/img/public'),
}));

const engine = require('../utils/assistantEngine');
const imageStore = require('../utils/imageStore');
const transcription = require('../utils/transcriptionEngine');
const controller = require('../controllers/assistantController');
const Conversation = require('../models/Conversation');

/** A minimal Express response that records what the handler did with it. */
const mockRes = () => {
    const res = { statusCode: 200, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    return res;
};

/** A file on disk in the shape multer hands over. */
const fakeUpload = (mimetype = 'image/jpeg', bytes = Buffer.from('not-really-a-jpeg')) => {
    const p = path.join(os.tmpdir(), `assistant-test-${Date.now()}-${Math.random()}.bin`);
    fs.writeFileSync(p, bytes);
    return { path: p, mimetype, size: bytes.length, originalname: 'photo.jpg' };
};

const userId = () => new mongoose.Types.ObjectId();

/** Handlers resolve before their response is sent; awaiting the call is enough. */
const chat = async ({ body = {}, file = null, auth }) => {
    const res = mockRes();
    await controller.chat({ body, file, auth: { userId: auth } }, res);
    return res;
};

beforeEach(() => {
    jest.clearAllMocks();
    engine.isConfigured.mockReturnValue(true);
    imageStore.uploadImageOrNull.mockResolvedValue('https://imagedelivery.net/acct/img/public');
});

describe('a photograph sent with a question', () => {
    it('reaches the model as image bytes and is stored on the message', async () => {
        const id = userId();
        const file = fakeUpload();

        const res = await chat({ body: { message: 'What is this?' }, file, auth: id });

        expect(res.statusCode).toBe(200);
        expect(engine.ask).toHaveBeenCalledTimes(1);

        const { image } = engine.ask.mock.calls[0][0];
        expect(image.mediaType).toBe('image/jpeg');
        expect(Buffer.isBuffer(image.data)).toBe(true);

        const conversation = await Conversation.findOne({ userId: id });
        const question = conversation.messages[0];
        expect(question.role).toBe('user');
        expect(question.attachment.kind).toBe('image');
        expect(question.attachment.url).toMatch(/imagedelivery/);
    });

    it('stands in a question when only a picture was sent', async () => {
        const id = userId();

        await chat({ body: {}, file: fakeUpload(), auth: id });

        // Both the model and the transcript need words. A blank bubble is not a record of
        // what was asked, and an empty prompt is not a question.
        expect(engine.ask.mock.calls[0][0].message).toMatch(/\w/);
        const conversation = await Conversation.findOne({ userId: id });
        expect(conversation.messages[0].text).toMatch(/\w/);
    });

    it('still answers when the picture could not be stored', async () => {
        const id = userId();
        imageStore.uploadImageOrNull.mockResolvedValue(null);

        const res = await chat({ body: { message: 'Look at this' }, file: fakeUpload(), auth: id });

        // Losing the thumbnail must not cost the answer — the model saw the picture either way.
        expect(res.statusCode).toBe(200);
        expect(engine.ask).toHaveBeenCalledTimes(1);

        const conversation = await Conversation.findOne({ userId: id });
        expect(conversation.messages[0].attachment.kind).toBe('image');
        expect(conversation.messages[0].attachment.url).toBeNull();
    });

    it('refuses a format the model cannot read, before spending anything on it', async () => {
        const res = await chat({
            body: { message: 'Look at this' },
            file: fakeUpload('image/heic'),
            auth: userId(),
        });

        expect(res.statusCode).toBe(400);
        expect(engine.ask).not.toHaveBeenCalled();
        expect(imageStore.uploadImageOrNull).not.toHaveBeenCalled();
    });

    it('deletes the temp file on every path, including the rejections', async () => {
        const accepted = fakeUpload();
        await chat({ body: { message: 'Hello' }, file: accepted, auth: userId() });

        const rejected = fakeUpload('image/heic');
        await chat({ body: { message: 'Hello' }, file: rejected, auth: userId() });

        // `uploads/` is not gitignored, so a leaked temp file is a file that gets committed.
        await new Promise((resolve) => setImmediate(resolve));
        expect(fs.existsSync(accepted.path)).toBe(false);
        expect(fs.existsSync(rejected.path)).toBe(false);
    });

    it('keeps the question when the model fails', async () => {
        const id = userId();
        engine.ask.mockResolvedValueOnce({ ok: false, error: 'nope' });

        const res = await chat({ body: { message: 'What is this?' }, file: fakeUpload(), auth: id });

        expect(res.statusCode).toBe(502);
        const conversation = await Conversation.findOne({ userId: id });
        expect(conversation.messages).toHaveLength(1);
        expect(conversation.messages[0].role).toBe('user');
    });
});

describe('a spoken question', () => {
    it('is marked as spoken so a mis-transcription is legible later', async () => {
        const id = userId();

        await chat({ body: { message: 'How is my cholesterol', spoken: 'true' }, auth: id });

        const conversation = await Conversation.findOne({ userId: id });
        expect(conversation.messages[0].attachment.kind).toBe('voice');
        // The recording itself is deliberately not retained.
        expect(conversation.messages[0].attachment.url).toBeNull();
    });

    it('is answered no differently from a typed one', async () => {
        await chat({ body: { message: 'How is my cholesterol', spoken: 'true' }, auth: userId() });
        expect(engine.ask.mock.calls[0][0].image).toBeNull();
    });

    it('leaves a typed question unmarked', async () => {
        const id = userId();
        await chat({ body: { message: 'How is my cholesterol' }, auth: id });

        const conversation = await Conversation.findOne({ userId: id });
        expect(conversation.messages[0].attachment).toBeNull();
    });
});

describe('what the composer is told it may offer', () => {
    const status = async () => {
        const res = mockRes();
        await controller.getStatus({}, res);
        return res.body;
    };

    afterEach(() => { delete process.env.TRANSCRIBE_API_KEY; });

    it('withholds voice when no transcription key is set', async () => {
        delete process.env.TRANSCRIBE_API_KEY;
        expect(transcription.isConfigured()).toBe(false);

        const capabilities = await status();
        expect(capabilities.voice).toBe(false);
        // Everything else keeps working without it — this is a partial outage, not an outage.
        expect(capabilities.text).toBe(true);
        expect(capabilities.vision).toBe(true);
    });

    it('offers voice once one is', async () => {
        process.env.TRANSCRIBE_API_KEY = 'test-key';
        expect((await status()).voice).toBe(true);
    });

    it('withholds everything when the assistant itself is unconfigured', async () => {
        process.env.TRANSCRIBE_API_KEY = 'test-key';
        engine.isConfigured.mockReturnValue(false);

        // A microphone that transcribes into a conversation nothing can answer is a
        // microphone that wastes the person's time and the server's transcription budget.
        expect(await status()).toEqual({ text: false, vision: false, voice: false });
    });
});

describe('transcription', () => {
    afterEach(() => { delete process.env.TRANSCRIBE_API_KEY; });

    it('says so plainly, and points at typing, when it is not configured', async () => {
        delete process.env.TRANSCRIBE_API_KEY;
        const res = mockRes();

        await controller.transcribe({ body: {}, file: null, auth: { userId: userId() } }, res);

        expect(res.statusCode).toBe(503);
        expect(res.body.typingAvailable).toBe(true);
    });

    it('refuses a container the provider will not take', async () => {
        process.env.TRANSCRIBE_API_KEY = 'test-key';
        const file = fakeUpload('audio/amr');
        const res = mockRes();

        await controller.transcribe({ body: {}, file, auth: { userId: userId() } }, res);

        expect(res.statusCode).toBe(400);
        await new Promise((resolve) => setImmediate(resolve));
        expect(fs.existsSync(file.path)).toBe(false);
    });

    it('accepts what the recorder actually produces', () => {
        // `lib/voice.ts` records m4a on both platforms precisely because the obvious
        // low-quality preset produces 3gp/AMR, which is not on this list.
        expect(transcription.ACCEPTED_MEDIA).toContain('audio/m4a');
    });

    it('writes nothing to the conversation', async () => {
        process.env.TRANSCRIBE_API_KEY = 'test-key';
        const id = userId();
        const res = mockRes();

        await controller.transcribe({ body: {}, file: fakeUpload('audio/amr'), auth: { userId: id } }, res);

        // The confirm/discard pair in Voice Mode is only an honest choice if transcribing
        // has committed nothing the person would have to undo.
        expect(await Conversation.findOne({ userId: id })).toBeNull();
    });
});
