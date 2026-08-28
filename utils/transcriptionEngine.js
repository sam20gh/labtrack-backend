/**
 * Speech to text for the assistant's Voice Mode.
 *
 * Claude cannot take audio, so this is the one place in the AI pipeline that talks to a
 * different provider. It speaks the Whisper-compatible `/audio/transcriptions` shape —
 * OpenAI's own endpoint, Groq's OpenAI-compatible one, or a self-hosted `faster-whisper`
 * server — chosen by env rather than hardcoded, so swapping provider is a deployment
 * change and not a code change. Anything that does not implement that exact shape needs an
 * adapter here, not just a different `TRANSCRIBE_BASE_URL`.
 *
 * Deliberately its own key rather than reusing `OPENAI_API_KEY`. That variable holds a
 * DeepSeek key on this project (see the note in CLAUDE.md); pointing audio at it would
 * fail at request time with an authentication error nobody could explain.
 *
 * When no key is set this reports itself unconfigured and `/assistant/status` says so, so
 * the app can grey the microphone out with a reason. That is the same line
 * `nutrition/log.tsx` takes with photo analysis: a disabled control that explains itself
 * beats a control that silently does nothing.
 */
const fs = require('fs');
const OpenAI = require('openai');

const BASE_URL = process.env.TRANSCRIBE_BASE_URL || 'https://api.openai.com/v1';
const MODEL = process.env.TRANSCRIBE_MODEL || 'whisper-1';

/** Containers the recorder can produce on either platform, plus what a provider will take. */
const ACCEPTED_MEDIA = [
    'audio/m4a', 'audio/x-m4a', 'audio/mp4', 'audio/aac',
    'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav',
    'audio/webm', 'audio/ogg',
];

/** 25MB — the ceiling Whisper-compatible endpoints converge on. Far above a spoken question. */
const MAX_BYTES = 25 * 1024 * 1024;

const isConfigured = () => Boolean(process.env.TRANSCRIBE_API_KEY);

let client = null;
const getClient = () => {
    if (!client) {
        client = new OpenAI({ apiKey: process.env.TRANSCRIBE_API_KEY, baseURL: BASE_URL });
    }
    return client;
};

/**
 * Transcribe one recording.
 *
 * Streamed from disk rather than read into a Buffer: multer has already written the file,
 * and holding a 25MB base64 string for the life of the request is the mistake
 * `nutritionRoutes` documents avoiding.
 *
 * @param {string} path      temp file multer wrote
 * @param {string} [language] ISO-639-1 hint; omitted means the provider detects it
 * @returns {Promise<{ok:boolean, text?:string, error?:string, model?:string}>}
 */
const transcribe = async (path, language) => {
    if (!isConfigured()) {
        return { ok: false, error: 'Voice input is not configured on this server.' };
    }

    try {
        const result = await getClient().audio.transcriptions.create({
            file: fs.createReadStream(path),
            model: MODEL,
            ...(language ? { language } : {}),
            // A health assistant hears drug and analyte names. Naming the domain measurably
            // reduces the classic Whisper failure of rendering them as ordinary words.
            prompt: 'A person speaking to a health assistant about their blood test results, '
                + 'medications, symptoms, appointments and health plan.',
        });

        const text = String(result?.text ?? '').trim();
        if (!text) {
            return { ok: false, error: "We couldn't make out any words. Try again somewhere quieter." };
        }
        return { ok: true, text, model: MODEL };
    } catch (error) {
        console.error('❌ Transcription failed:', error);
        if (error?.status === 401 || error?.status === 403) {
            return { ok: false, error: 'Voice input is not configured correctly on this server.' };
        }
        if (error?.status === 429) {
            return { ok: false, error: 'Voice input is busy right now. Try again in a moment.' };
        }
        return { ok: false, error: 'That recording could not be transcribed.' };
    }
};

module.exports = { transcribe, isConfigured, ACCEPTED_MEDIA, MAX_BYTES, MODEL, BASE_URL };
