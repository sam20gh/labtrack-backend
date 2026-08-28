/**
 * The conversational half of the AI pipeline.
 *
 * `interpretationEngine` answers one question thoroughly and rarely — "what does all of
 * this mean for this person" — and its output is a durable, reviewable record. This engine
 * answers many small questions quickly, and its output is a chat message. Different
 * shapes, different cost profiles, one shared source of truth: both build their view of the
 * person from `interpretationController._gatherContext`, so the assistant cannot describe a
 * biomarker differently from the way the results screen does.
 *
 * What this adds on top of the interpretation context is the things a conversation reaches
 * for that a one-shot interpretation does not: what is on their plan, which clinicians they
 * could actually book, and which tests they could actually order. Recommending a cardiologist
 * who is not in the database produces a card the person cannot act on, which is worse than
 * declining to recommend one.
 */
const Anthropic = require('@anthropic-ai/sdk');
const PlanItem = require('../models/PlanItem');
const Product = require('../models/Product');
const Professional = require('../models/Professional');
const Interpretation = require('../models/Interpretation');
const { presentToPatient } = require('../config/clinicalPolicy');
const { buildContext } = require('./interpretationEngine');
const { _gatherContext } = require('../controllers/interpretationController');
const { ASSISTANT_SCHEMA, SYSTEM_PROMPT } = require('./assistantSchema');

const MODEL = 'claude-opus-5';

/**
 * How many past turns are replayed to the model.
 *
 * The transcript is retained far longer than this (`Conversation.HISTORY_LIMIT`). Sending
 * all of it would grow the request without bound and, worse, would keep re-sending a
 * prefix that changes every turn — defeating the cache on the part of the request that is
 * actually expensive, the person's health context.
 */
const HISTORY_WINDOW = 20;

/** Catalogue rows sent to the model. Enough to choose from, not enough to dominate the prompt. */
const CATALOGUE_LIMIT = 40;

const isConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

let client = null;
const getClient = () => {
    if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return client;
};

const isoDay = (d) => {
    const t = new Date(d).getTime();
    return Number.isNaN(t) ? 'undated' : new Date(t).toISOString().slice(0, 10);
};

/**
 * The parts of the context a conversation needs and an interpretation does not.
 *
 * Kept as its own function so the expensive half (`_gatherContext`) and the cheap half can
 * be cached separately — see `buildPrompt`.
 */
const gatherActionable = async (userId) => {
    const [planItems, professionals, products, interpretation] = await Promise.all([
        PlanItem.find({ userId, status: { $nin: ['completed', 'dismissed'] } })
            .sort({ dueDate: 1 }).limit(CATALOGUE_LIMIT).lean(),
        Professional.find().select('firstname lastname speciality hourly_rate country description').limit(CATALOGUE_LIMIT).lean(),
        Product.find().select('name type price description').limit(CATALOGUE_LIMIT).lean(),
        Interpretation.findOne({ userId }).sort({ generatedAt: -1 }).lean(),
    ]);

    return { planItems, professionals, products, interpretation };
};

/**
 * Render the actionable half as prompt text.
 *
 * Plain labelled lines rather than JSON, matching `interpretationEngine.buildContext` — a
 * nested object gives the model more ways to misread a field than a sentence does.
 */
const renderActionable = ({ planItems, professionals, products, interpretation }) => {
    const lines = [];

    lines.push('## Their surveillance plan');
    if (!planItems.length) {
        lines.push('Nothing scheduled. They have no plan items yet.');
    } else {
        for (const item of planItems) {
            const due = item.dueDate ? isoDay(item.dueDate) : 'no date set';
            const who = item.professionalName ? ` with ${item.professionalName}` : '';
            lines.push(`  [${item.type}] ${item.title}${who} — due ${due}, status ${item.status}, urgency ${item.urgency}`);
        }
    }

    lines.push('');
    lines.push('## Their health interpretation');
    // Routed through the same policy function the read API uses, so the assistant cannot
    // quote content the app itself would withhold.
    const shown = presentToPatient(interpretation);
    if (!shown.content) {
        lines.push(shown.withheld
            ? 'An interpretation exists but is awaiting clinician review and must not be quoted.'
            : 'No interpretation has been generated yet.');
    } else {
        lines.push(`Verification state: ${shown.status}${shown.status === 'unverified' ? ' (not yet reviewed by a clinician)' : ''}`);
        if (shown.content.summary) lines.push(`Summary: ${shown.content.summary}`);
        for (const r of shown.content.risks || []) {
            lines.push(`  Risk — ${r.condition}: ${r.level}`);
        }
    }

    lines.push('');
    lines.push('## Tests they can order');
    if (!products.length) {
        lines.push('The catalogue is empty.');
    } else {
        for (const p of products) {
            lines.push(`  ${p.name}${p.type ? ` (${p.type})` : ''} — £${p.price}${p.description ? ` — ${p.description}` : ''}`);
        }
    }

    lines.push('');
    lines.push('## Clinicians they can book');
    if (!professionals.length) {
        lines.push('No clinicians are listed.');
    } else {
        for (const pro of professionals) {
            lines.push(`  ${pro.firstname} ${pro.lastname} — ${(pro.speciality || []).join(', ') || 'unspecified'}, £${pro.hourly_rate}/hr${pro.country ? `, ${pro.country}` : ''}`);
        }
    }

    return lines.join('\n');
};

/**
 * Assemble the request.
 *
 * Two cache breakpoints, in order of how often each changes:
 *   1. the system prompt — frozen
 *   2. the person's health context — changes only when they add a result
 *
 * The conversation itself sits after both, so a turn re-reads the expensive prefix from
 * cache and pays full price only for what is new. Nothing volatile (a timestamp, a message
 * id) may move above those breakpoints or the cache silently stops hitting.
 */
const buildPrompt = async (userId) => {
    const [profile, actionable] = await Promise.all([
        _gatherContext(userId),
        gatherActionable(userId),
    ]);

    // `gatherContext` attaches `previous` — the last interpretation's summary and risks —
    // by reading `content` directly, without going through `presentToPatient`. That is
    // correct for the interpretation engine, which writes a draft for a clinician to
    // review and is not addressing the patient.
    //
    // It is not correct here. This model's words go straight to the person, so if
    // `showsUnverifiedToPatient()` is ever flipped to false, an unverified interpretation
    // must be unreachable through *every* path into the context — including this one.
    // `renderActionable` already honours the policy; dropping `previous` closes the door
    // the shared builder would otherwise leave open.
    if (presentToPatient(actionable.interpretation).withheld) {
        profile.previous = null;
    }

    return `${buildContext(profile)}\n\n${renderActionable(actionable)}`;
};

/**
 * Answer one message.
 *
 * @param {object} args
 * @param {string} args.userId
 * @param {string} args.message         what the person just typed
 * @param {Array<{role:string, text:string}>} args.history  prior turns, oldest first
 * @param {{data: Buffer, mediaType: string}} [args.image]  a photograph sent with the message
 * @returns {Promise<{ok:boolean, data?:object, error?:string, usage?:object}>}
 */
const ask = async ({ userId, message, history = [], image = null }) => {
    if (!isConfigured()) {
        return { ok: false, error: 'The assistant is not configured on this server.' };
    }

    try {
        const context = await buildPrompt(userId);

        // Replayed turns carry only the text. The card was rendered from data the model can
        // see in the context anyway, and echoing serialised widgets back would spend a
        // large share of the window restating what it already knows.
        const turns = history.slice(-HISTORY_WINDOW).map((m) => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.text,
        }));

        // The API requires the first message to be from the user. A transcript can begin
        // with an assistant greeting, so drop any leading assistant turns rather than
        // sending a request that fails validation.
        while (turns.length && turns[0].role === 'assistant') turns.shift();

        // A photograph rides on the final turn only, and never above a cache breakpoint —
        // an image block in the cached prefix would change every time a picture was sent
        // and invalidate the person's health context along with it.
        //
        // Image first, text second: the model reads the blocks in order, and a question
        // that begins "what is this" makes no sense before the thing it refers to.
        const finalTurn = image
            ? [
                { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data.toString('base64') } },
                { type: 'text', text: message },
            ]
            : message;

        const stream = getClient().messages.stream({
            model: MODEL,
            max_tokens: 8000,
            system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
            thinking: { type: 'adaptive' },
            output_config: {
                // Lower than the interpretation's `high`: this runs many times per session
                // rather than once per test result, and the reasoning it needs is recall
                // and selection from a context it has been handed, not novel clinical
                // synthesis. Raise it if answers start missing what the data shows.
                effort: 'medium',
                format: { type: 'json_schema', schema: ASSISTANT_SCHEMA },
            },
            messages: [
                {
                    role: 'user',
                    content: [{
                        type: 'text',
                        text: `Here is everything on record for the person you are talking to.\n\n${context}`,
                        cache_control: { type: 'ephemeral' },
                    }],
                },
                {
                    role: 'assistant',
                    content: 'Understood — I have their records and will answer from them.',
                },
                ...turns,
                { role: 'user', content: finalTurn },
            ],
        });

        const response = await stream.finalMessage();

        if (response.stop_reason === 'refusal') {
            // Photographs of skin and bodies trip a classifier far more readily than text
            // does, and the generic wording reads as a judgement about what they asked
            // rather than about the picture. `nutritionEngine` splits the same two cases.
            return {
                ok: false,
                error: image
                    ? 'I could not look at that photograph. You can describe what you are seeing instead, '
                      + 'and if it is worrying you, please have a clinician look at it.'
                    : 'I can\'t help with that one. If this is about symptoms you are having, please speak to a clinician.',
            };
        }

        const textBlock = response.content.find((b) => b.type === 'text');
        if (!textBlock) return { ok: false, error: 'The assistant returned an empty reply.' };

        const data = JSON.parse(textBlock.text);

        // A card whose every slot is empty renders as a titled void. Drop it rather than
        // asking the client to guess whether an empty card was intentional.
        if (data.widget && !data.widget.stats?.length && !data.widget.rows?.length && !data.widget.progress) {
            data.widget = null;
        }

        return { ok: true, data, usage: response.usage };
    } catch (error) {
        console.error('❌ Assistant reply failed:', error);
        if (error instanceof Anthropic.RateLimitError) {
            return { ok: false, error: 'The assistant is busy right now. Try again in a moment.' };
        }
        return { ok: false, error: error.message || 'The assistant could not reply.' };
    }
};

module.exports = { ask, buildPrompt, isConfigured, MODEL, HISTORY_WINDOW };
