/**
 * The two Claude calls the medication checker makes, and the merge that keeps the second
 * one honest.
 *
 * ── Model tiering, matching the rest of the codebase ─────────────────────────────────
 *
 * | call        | model          | why                                                    |
 * |-------------|----------------|--------------------------------------------------------|
 * | `identify`  | Sonnet 5       | Vision, many times a day per active user, moderate      |
 * |             |                | stakes because the person confirms before anything      |
 * |             |                | is saved. Same tier as `nutritionEngine` and            |
 * |             |                | `reportParser`.                                          |
 * | `review`    | Opus 5         | Runs once per change to the medication list, produces   |
 * |             |                | a durable record a person acts on. Same tier as         |
 * |             |                | `interpretationEngine`.                                  |
 *
 * ── The merge is the safety property ─────────────────────────────────────────────────
 *
 * `runRules` produces findings deterministically. The model is then asked for prose and for
 * anything the table missed. `mergeFindings` is what stops the second step undoing the
 * first: rule findings pass through untouched, model findings are admitted only when they
 * describe a pair the table did not already cover, and a model finding can never lower the
 * severity of anything. That is enforced in code rather than asked for in the prompt,
 * because a prompt is a request and this has to be a guarantee.
 *
 * ── Prompt caching ───────────────────────────────────────────────────────────────────
 *
 * The system prompt and the class vocabulary sit behind cache breakpoints; the person's
 * medication list, which changes on every check, goes after them. Nothing volatile may move
 * above those breakpoints or the cache silently stops hitting — check
 * `usage.cache_read_input_tokens` if costs climb.
 */
const Anthropic = require('@anthropic-ai/sdk');
const {
    IDENTIFY_SCHEMA, IDENTIFY_PROMPT, REVIEW_SCHEMA, REVIEW_PROMPT,
} = require('./medicationSchema');
const {
    KNOWN_CLASSES, SEVERITY, severityRank, atLeastAsSevere, explain, SAFETY_FOOTER,
} = require('./medicationCatalogue');

/** Vision, high volume, person confirms the result. */
const IDENTIFY_MODEL = 'claude-sonnet-5';
/** Clinical, durable, once per change. */
const REVIEW_MODEL = 'claude-opus-5';

/** Below this the client shows the "we couldn't find your medication" path from the design. */
const CONFIDENCE_THRESHOLD = 0.6;

const ACCEPTED_MEDIA = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

const isConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

let client = null;
const getClient = () => {
    if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return client;
};

/** Shared call plumbing, so the two paths cannot drift on refusals or malformed JSON. */
const run = async ({ model, system, messages, schema, maxTokens }) => {
    if (!isConfigured()) {
        return { ok: false, error: 'ANTHROPIC_API_KEY is not configured on the server' };
    }

    try {
        const stream = getClient().messages.stream({
            model,
            max_tokens: maxTokens,
            system,
            output_config: { format: { type: 'json_schema', schema } },
            messages,
        });

        const message = await stream.finalMessage();

        // Photographs of pills and lists of psychiatric medication both occasionally trip a
        // classifier. Check before reading content, as nutritionEngine does.
        if (message.stop_reason === 'refusal') {
            return {
                ok: false,
                error: 'This could not be analysed automatically. Please enter the details by hand.',
            };
        }

        const textBlock = message.content.find((b) => b.type === 'text');
        if (!textBlock) return { ok: false, error: 'No analysis returned' };

        return { ok: true, data: JSON.parse(textBlock.text), usage: message.usage, model };
    } catch (error) {
        console.error('❌ Medication engine call failed:', error);
        return { ok: false, error: error.message || 'Analysis failed' };
    }
};

// ── Identification ───────────────────────────────────────────────────────────────────

/**
 * Identify a medicine from a photograph.
 *
 * @param {Buffer} buffer     image bytes
 * @param {string} mediaType  one of ACCEPTED_MEDIA
 * @param {string} [note]     anything the person typed alongside the picture
 */
const identify = async (buffer, mediaType, note) => {
    const result = await run({
        model: IDENTIFY_MODEL,
        maxTokens: 2000,
        schema: IDENTIFY_SCHEMA,
        system: [{ type: 'text', text: IDENTIFY_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{
            role: 'user',
            content: [
                { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } },
                {
                    type: 'text',
                    text: note
                        ? `Identify this medicine. The person adds: "${note}"`
                        : 'Identify this medicine.',
                },
            ],
        }],
    });

    if (!result.ok) return result;

    // Attach the catalogue entry when the identified name is one we hold. The model supplies
    // the identification; the plain-language copy is ours, so it stays consistent with what
    // the medication detail screen shows for the same drug entered by hand.
    const data = result.data;
    const entry = data.name ? explain(data.name) : null;

    return { ...result, data: { ...data, catalogue: entry } };
};

/** Reshape identification output into the fields the add-medication form expects. */
const toMedicationDraft = (data) => ({
    name: data.catalogue?.key?.replace(/_/g, ' ') || data.name || '',
    brandName: data.brandName || data.catalogue?.brandNames?.[0] || null,
    strength: data.strength || null,
    form: data.form || data.catalogue?.form || 'tablet',
    shape: data.shape || null,
    colour: data.colour || null,
    imprint: data.imprint || null,
    source: 'scan',
    identification: {
        confidence: data.confidence,
        basis: data.basis,
        surface: data.surface,
        alternatives: data.alternatives || [],
        warnings: data.warnings || [],
        model: IDENTIFY_MODEL,
    },
});

// ── Interaction review ───────────────────────────────────────────────────────────────

/**
 * Render the person's medicines and the table's verdict as prompt text.
 *
 * Labelled prose rather than JSON, for the reason `interpretationEngine.buildContext`
 * gives: the model misreads a nested object more often than it misreads a sentence.
 */
const buildReviewContext = ({ medications, findings, uncheckable, conditions, allergies }) => {
    const lines = ['## The medicines this person takes'];

    if (!medications.length) {
        lines.push('None recorded.');
    } else {
        for (const m of medications) {
            const bits = [m.name];
            if (m.strength) bits.push(m.strength);
            if (m.form) bits.push(m.form);
            const schedule = m.frequency ? m.frequency.replace(/_/g, ' ') : 'schedule not set';
            lines.push(`- ${bits.join(', ')} — ${schedule}${m.notes ? ` (their note: "${m.notes}")` : ''}`);
        }
    }

    if (conditions?.length) {
        lines.push('');
        lines.push('## Conditions on their record');
        lines.push(conditions.join(', '));
    }

    if (allergies?.length) {
        lines.push('');
        lines.push('## Allergies on their record');
        lines.push(allergies.join(', '));
    }

    lines.push('');
    lines.push('## CONFIRMED FINDINGS — settled, do not restate or contradict');
    if (!findings.length) {
        lines.push('The rule table found nothing among the medicines it was able to check.');
        lines.push('This is NOT an all-clear. Say so explicitly in your summary.');
    } else {
        for (const f of findings) {
            lines.push(`- [${f.severity}] ${f.between.join(' + ')} — ${f.effect}`);
        }
    }

    lines.push('');
    lines.push('## Medicines the catalogue could not classify');
    if (!uncheckable.length) {
        lines.push('None — every medicine listed was covered by the rule table.');
    } else {
        lines.push(uncheckable.join(', '));
        lines.push('These were NOT checked against any rule. Classify them below, and make sure');
        lines.push('your summary tells the person which of their medicines could not be checked.');
    }

    return lines.join('\n');
};

/** The class vocabulary block. Stable across every user, so it sits behind a cache breakpoint. */
const CLASS_VOCABULARY = `## Drug class vocabulary
Use ONLY these class names in "classifications". Anything else matches no rule.

${KNOWN_CLASSES.join(', ')}`;

/**
 * Merge model findings into rule findings.
 *
 * The guarantee, in order of precedence:
 *   1. Every rule finding survives, with its severity untouched.
 *   2. A model finding about a pair the table already covered is dropped — the table has
 *      already spoken about that pair and a second opinion on screen reads as disagreement.
 *   3. A model finding about a new pair is admitted, tagged `source: 'model'` so the client
 *      can render its provenance, and clamped to a severity the schema allows.
 *
 * There is deliberately no path by which a model finding lowers a rule severity.
 */
const mergeFindings = (ruleFindings = [], modelFindings = []) => {
    const pairKey = (between) => [...(between || [])].map((s) => String(s).toLowerCase().trim()).sort().join('|');
    const covered = new Set(ruleFindings.map((f) => pairKey(f.between)));

    const admitted = [];
    for (const f of modelFindings) {
        if (!f || !Array.isArray(f.between) || f.between.length !== 2) continue;
        const key = pairKey(f.between);
        if (covered.has(key)) continue;
        covered.add(key);

        admitted.push({
            id: `model-${key}`,
            kind: f.kind || 'drug',
            // An unrecognised severity becomes the mildest rather than the worst: the table
            // owns alarm, and a malformed model response should not be able to raise one.
            severity: SEVERITY.includes(f.severity) ? f.severity : 'mild',
            source: 'model',
            between: f.between,
            effect: f.effect,
            action: f.action,
        });
    }

    return [...ruleFindings, ...admitted]
        .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
};

/**
 * Write the readable half of an interaction check.
 *
 * @param {object} input
 * @param {object[]} input.medications  the person's list
 * @param {object[]} input.findings     rule findings, already computed — settled facts
 * @param {string[]} input.uncheckable  medications the catalogue could not classify
 * @param {string[]} [input.conditions]
 * @param {string[]} [input.allergies]
 */
const review = async ({ medications = [], findings = [], uncheckable = [], conditions = [], allergies = [] }) => {
    const result = await run({
        model: REVIEW_MODEL,
        maxTokens: 4000,
        schema: REVIEW_SCHEMA,
        system: [
            { type: 'text', text: REVIEW_PROMPT, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: CLASS_VOCABULARY, cache_control: { type: 'ephemeral' } },
        ],
        messages: [{
            role: 'user',
            content: [{
                type: 'text',
                text: `${buildReviewContext({ medications, findings, uncheckable, conditions, allergies })}

Write the check.`,
            }],
        }],
    });

    if (!result.ok) return result;

    const data = result.data;
    return {
        ...result,
        data: {
            summary: data.summary,
            findings: mergeFindings(findings, data.additional_findings),
            classifications: data.classifications || [],
            timingAdvice: data.timing_advice || [],
            questionsForClinician: data.questions_for_clinician || [],
        },
    };
};

/**
 * The check as it stands with no model available.
 *
 * `/api/medications/check` degrades to this rather than answering 503, and the difference
 * matters: the rule table is the part that catches warfarin and ibuprofen, and it needs no
 * API key. Losing the prose is a worse experience; losing the findings would be a worse
 * outcome. The client renders `degraded: true` so nobody mistakes the terse summary for a
 * complete one.
 */
const ruleOnlyReview = ({ findings = [], uncheckable = [], checkedCount = 0 }) => {
    const severe = findings.filter((f) => f.severity === 'severe').length;

    const parts = [];
    parts.push(
        checkedCount === 0
            ? 'None of your medicines could be checked against our interaction rules.'
            : `We checked ${checkedCount} of your medicines against our interaction rules.`
    );
    if (severe > 0) {
        parts.push(`${severe === 1 ? 'One finding needs' : `${severe} findings need`} attention before your next dose.`);
    } else if (findings.length) {
        parts.push('Some things came up that are worth raising at your next appointment.');
    } else {
        parts.push('Nothing came up among the medicines we could check — which is not the same as being cleared.');
    }
    if (uncheckable.length) {
        parts.push(`We could not check ${uncheckable.join(', ')} at all.`);
    }

    return {
        summary: parts.join(' '),
        findings,
        classifications: [],
        timingAdvice: [],
        questionsForClinician: [],
    };
};

module.exports = {
    identify,
    toMedicationDraft,
    review,
    ruleOnlyReview,
    mergeFindings,
    buildReviewContext,
    isConfigured,
    IDENTIFY_MODEL,
    REVIEW_MODEL,
    CONFIDENCE_THRESHOLD,
    ACCEPTED_MEDIA,
    SAFETY_FOOTER,
};
