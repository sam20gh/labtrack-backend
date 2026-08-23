/**
 * Extracts structured biomarker data from a photographed or scanned lab report.
 *
 * Uses Claude Sonnet 5 with a strict output schema, so the response is guaranteed to
 * validate rather than being coaxed into JSON and hopefully parsed.
 *
 * Design rules, all of them safety-driven:
 *
 *   1. **Never invent.** The prompt forbids inferring values that are not printed. A
 *      hallucinated ferritin is worse than a missing one — the user can re-scan a missing
 *      value, but they cannot know an invented one is wrong.
 *   2. **Report units verbatim.** Conversion happens afterwards in `unitNormaliser`, in
 *      deterministic code. Asking a model to convert units puts arithmetic on the critical
 *      path of a medical decision.
 *   3. **Confidence per row.** Anything below CONFIDENCE_THRESHOLD is marked for human
 *      confirmation instead of being written straight to the record.
 */
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-5';

/** Rows at or below this confidence must be confirmed by the user before they count. */
const CONFIDENCE_THRESHOLD = 0.8;

const isConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

let client = null;
const getClient = () => {
    if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return client;
};

/**
 * Output schema. `additionalProperties: false` plus explicit `required` is what makes the
 * response shape guaranteed rather than merely likely.
 */
const EXTRACTION_SCHEMA = {
    type: 'object',
    properties: {
        lab_name: { type: ['string', 'null'], description: 'Laboratory or clinic name printed on the report' },
        collection_date: { type: ['string', 'null'], description: 'Sample collection date in YYYY-MM-DD, or null if not printed' },
        test_type: { type: ['string', 'null'], description: 'Panel name, e.g. "Full Blood Count"' },
        measurements: {
            type: 'array',
            description: 'One entry per analyte printed on the report',
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Analyte name exactly as printed' },
                    value: { type: 'number', description: 'Numeric result exactly as printed. Do not convert.' },
                    unit: { type: ['string', 'null'], description: 'Unit exactly as printed, e.g. "mg/dL". Null if absent.' },
                    reference_range_raw: { type: ['string', 'null'], description: 'Reference interval as printed, e.g. "30 - 400"' },
                    flag_on_report: { type: ['string', 'null'], description: 'Any H/L/abnormal marker the lab printed' },
                    confidence: { type: 'number', description: '0-1 confidence that name, value and unit were read correctly' },
                },
                required: ['name', 'value', 'unit', 'reference_range_raw', 'flag_on_report', 'confidence'],
                additionalProperties: false,
            },
        },
        unreadable_regions: {
            type: 'array',
            description: 'Parts of the document that could not be read (blur, glare, cropping)',
            items: { type: 'string' },
        },
    },
    required: ['lab_name', 'collection_date', 'test_type', 'measurements', 'unreadable_regions'],
    additionalProperties: false,
};

const SYSTEM_PROMPT = `You extract laboratory test results from scanned or photographed reports.

This output feeds a medical record, so accuracy matters more than completeness:

- Transcribe ONLY values printed on the document. Never infer, estimate, or complete a
  partially visible number. If a digit is ambiguous, lower the confidence rather than guess.
- Copy names, values, and units EXACTLY as printed. Do not convert units, do not translate
  analyte names, do not normalise spelling. Downstream code handles all of that.
- If the same analyte appears more than once (e.g. a repeat), return each occurrence.
- Set confidence per row: 1.0 for a crisp, unambiguous printed value; below 0.8 when the
  text is blurred, cropped, handwritten, or otherwise uncertain.
- List anything you could not read in unreadable_regions so the user can re-scan.
- If the document is not a lab report, return an empty measurements array.`;

/**
 * Parse a report document.
 *
 * @param {Buffer} buffer   file bytes
 * @param {string} mediaType  'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp'
 * @returns {Promise<{ok: boolean, data?: object, error?: string}>}
 */
const parseReport = async (buffer, mediaType) => {
    if (!isConfigured()) {
        return { ok: false, error: 'ANTHROPIC_API_KEY is not configured on the server' };
    }

    const base64 = buffer.toString('base64');

    // PDFs go in as `document`; images as `image`. Sending the wrong block type is rejected.
    const documentBlock = mediaType === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
        : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };

    try {
        // Streamed: a multi-page report at high effort can exceed the non-streaming timeout
        const stream = getClient().messages.stream({
            model: MODEL,
            max_tokens: 16000,
            system: SYSTEM_PROMPT,
            thinking: { type: 'adaptive' },
            output_config: {
                format: { type: 'json_schema', schema: EXTRACTION_SCHEMA },
            },
            messages: [{
                role: 'user',
                content: [
                    documentBlock,
                    { type: 'text', text: 'Extract every laboratory measurement from this report.' },
                ],
            }],
        });

        const message = await stream.finalMessage();

        // Safety classifiers can decline: check before reading content
        if (message.stop_reason === 'refusal') {
            return { ok: false, error: 'The document could not be processed automatically. Please enter the values manually.' };
        }

        const textBlock = message.content.find((b) => b.type === 'text');
        if (!textBlock) return { ok: false, error: 'No extraction returned' };

        const data = JSON.parse(textBlock.text);
        return { ok: true, data, usage: message.usage };
    } catch (error) {
        console.error('❌ Report parsing failed:', error);
        return { ok: false, error: error.message || 'Parsing failed' };
    }
};

/**
 * Split extracted rows by whether they can be trusted without confirmation.
 * Low-confidence rows are not discarded — they are pre-filled for the user to check.
 */
const partitionByConfidence = (measurements = []) => {
    const confident = [];
    const needsReview = [];

    for (const m of measurements) {
        const row = {
            name: m.name,
            value: m.value,
            unit: m.unit,
            reportedRange: m.reference_range_raw ? { raw: m.reference_range_raw } : undefined,
            extractionConfidence: m.confidence,
        };
        if (typeof m.confidence === 'number' && m.confidence >= CONFIDENCE_THRESHOLD) {
            confident.push(row);
        } else {
            needsReview.push({ ...row, needsReview: true });
        }
    }

    return { confident, needsReview };
};

module.exports = {
    parseReport,
    partitionByConfidence,
    isConfigured,
    CONFIDENCE_THRESHOLD,
    MODEL,
    EXTRACTION_SCHEMA,
};
