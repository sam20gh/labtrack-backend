/**
 * The one Claude call the predictor makes, and the merge that keeps it honest.
 *
 * ── Model tier ────────────────────────────────────────────────────────────────────────
 *
 * Opus 5, the same tier as `interpretationEngine` and `medicationEngine.review`, for the
 * same reasons: it runs once per prediction rather than per screen, it produces a durable
 * record on `Prediction`, and a person acts on it. Nothing here is high volume.
 *
 * ── The merge is the safety property ──────────────────────────────────────────────────
 *
 * `predictionForecast` has already produced every number by the time this runs. The model is
 * asked only for sentences. `mergeNarrative` is what stops it doing anything else:
 *
 *   - `chance` on a risk is **overwritten** with the forecast's own confidence, whatever the
 *     model returned. The schema has no other numeric field, so this is the only route by
 *     which a model-authored number could reach a screen, and it is closed.
 *   - A `component_note` naming a component that was not forecast is dropped. A note about
 *     "diastolic" on a weight prediction is either a hallucination or a prompt regression,
 *     and either way it must not render.
 *   - `risks` is capped and every entry is clamped to the enum. An unrecognised severity
 *     becomes `low`, never `high` — the same direction `mergeFindings` clamps in, because a
 *     malformed response must not be able to raise an alarm.
 *   - The headline is checked for figures that are not in the forecast. One that invents a
 *     number is discarded and the deterministic headline is used instead. `findQualityIssues`
 *     in `interpretationEngine` makes the same call about a degenerate plain summary.
 *
 * ── Prompt caching ────────────────────────────────────────────────────────────────────
 *
 * The system prompt sits behind a cache breakpoint; the person's forecast, which is
 * different every call, goes after it. Nothing volatile may move above that breakpoint or
 * the cache silently stops hitting — check `usage.cache_read_input_tokens` if costs climb.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { PREDICTION_SCHEMA, PREDICTION_PROMPT } = require('./predictionSchema');
const { HORIZON_LABELS } = require('./predictionMetrics');

/** Clinical, durable, once per prediction. */
const PREDICTION_MODEL = 'claude-opus-5';

/** Below this the summary has to say so in plain words. Mirrored in the prompt. */
const WEAK_CONFIDENCE = 0.6;

const RISK_LEVELS = ['high', 'moderate', 'low'];

const isConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

let client = null;
const getClient = () => {
    if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return client;
};

/* ------------------------------------------------------------------ *
 * Prompt context
 * ------------------------------------------------------------------ */

const pct = (v) => `${Math.round(v * 100)}%`;

/**
 * Render the settled forecast as prompt text.
 *
 * Labelled prose rather than JSON, for the reason `interpretationEngine.buildContext` gives:
 * the model misreads a nested object more often than it misreads a sentence.
 */
const buildContext = ({ metric, horizonDays, forecast, band, profile, related }) => {
    const horizon = HORIZON_LABELS[horizonDays] || { long: `the next ${horizonDays} days` };
    const lines = [];

    lines.push(`## The forecast — SETTLED, do not restate differently or contradict`);
    lines.push(`Metric: ${metric.label}${metric.unit ? ` (${metric.unit})` : ''}`);
    lines.push(`Horizon: ${horizon.long}`);
    lines.push('');

    for (const c of forecast.components) {
        lines.push(`### ${c.label}`);
        lines.push(`- Predicted: ${c.point}${metric.unit ? ` ${metric.unit}` : ''}, `
            + `range ${c.low} to ${c.high}`);
        lines.push(`- Last measured: ${c.currentValue ?? 'unknown'}`
            + (c.changePct === null ? '' : ` (a ${c.changePct > 0 ? 'rise' : 'fall'} of ${Math.abs(c.changePct)}%)`));
        lines.push(`- Direction: ${c.direction}`);
        lines.push(`- Confidence: ${pct(c.confidence)}`);
        lines.push(`- Built from ${c.basis.points} readings spanning ${c.basis.spanDays} days; `
            + `the most recent is ${c.basis.staleDays} days old.`);
        lines.push('');
    }

    if (band) {
        lines.push(`### Clinical band of the predicted value`);
        lines.push(`${band.label}${band.detail ? ` — ${band.detail}` : ''}`);
        if (band.crisis) {
            lines.push('THIS IS A HYPERTENSIVE CRISIS CATEGORY. Your summary must open by telling '
                + 'them to seek medical care now.');
        }
        lines.push('');
    }

    if (forecast.confidence < WEAK_CONFIDENCE) {
        lines.push(`### Weak signal`);
        lines.push(`Overall confidence is ${pct(forecast.confidence)}, which is low. Say so in plain `
            + `words in your summary.`);
        lines.push('');
    }

    lines.push('## What else is on this person\'s record');
    if (!profile || !Object.keys(profile).length) {
        lines.push('Nothing beyond the readings above.');
    } else {
        if (profile.age) lines.push(`- Age ${profile.age}${profile.gender ? `, ${profile.gender}` : ''}`);
        if (profile.conditions?.length) lines.push(`- Conditions: ${profile.conditions.join(', ')}`);
        if (profile.medications?.length) lines.push(`- Medicines: ${profile.medications.join(', ')}`);
        if (profile.planAdvice?.length) lines.push(`- Their health plan says: ${profile.planAdvice.join('; ')}`);
    }
    lines.push('');

    if (related?.length) {
        lines.push('## Other metrics moving at the same time');
        for (const r of related) {
            lines.push(`- ${r.label}: ${r.direction} (${r.detail})`);
        }
        lines.push('');
    }

    lines.push('## Components you must write a note for, in this order');
    lines.push(forecast.components.map((c) => c.key).join(', '));

    return lines.join('\n');
};

/* ------------------------------------------------------------------ *
 * The merge
 * ------------------------------------------------------------------ */

/** Every figure the forecast actually contains, as strings, for the headline check. */
const allowedFigures = (forecast) => {
    const out = new Set();
    for (const c of forecast.components) {
        for (const v of [c.point, c.low, c.high, c.currentValue, c.margin]) {
            if (Number.isFinite(v)) {
                out.add(String(v));
                out.add(String(Math.round(v)));
            }
        }
        if (Number.isFinite(c.changePct)) {
            out.add(String(Math.abs(c.changePct)));
            out.add(String(Math.round(Math.abs(c.changePct))));
        }
    }
    return out;
};

/**
 * True when the headline contains a number the forecast does not.
 *
 * Deliberately lenient about the horizon ("In 1 week"), percentages the forecast carries, and
 * anything under 32, which is a date or a small count rather than a measurement. The check
 * exists to catch an invented *reading* — "your blood pressure will reach 165/104" when the
 * forecast said 126/96 — which is the failure that would matter.
 */
const inventsFigure = (text, forecast, horizonDays) => {
    if (!text) return false;
    const allowed = allowedFigures(forecast);
    const numbers = text.match(/\d+(?:\.\d+)?/g) || [];
    return numbers.some((n) => {
        if (allowed.has(n)) return false;
        const v = Number(n);
        if (v === horizonDays) return false;
        // 1 week / 3 months / 7 days — small integers are units of time here, not readings.
        if (Number.isInteger(v) && v <= 31) return false;
        return true;
    });
};

/**
 * Merge the model's prose onto the settled forecast.
 *
 * The forecast always wins. There is deliberately no path by which a model response changes
 * a figure, a direction, a band or a confidence.
 */
const mergeNarrative = (data, { forecast, horizonDays, fallbackHeadline }) => {
    const validKeys = new Set(forecast.components.map((c) => c.key));

    const risks = (Array.isArray(data.risks) ? data.risks : [])
        .filter((r) => r && r.label)
        .slice(0, 3)
        .map((r) => ({
            label: String(r.label).slice(0, 60),
            detail: r.detail || '',
            // An unrecognised level clamps DOWN. The arithmetic owns alarm.
            risk: RISK_LEVELS.includes(r.risk) ? r.risk : 'low',
            preventable: r.preventable !== false,
            // Overwritten, always. This is the only numeric field in the schema and it is
            // the forecast's own confidence, not the model's opinion of one.
            chance: forecast.confidence,
        }));

    const headline = inventsFigure(data.headline, forecast, horizonDays)
        ? fallbackHeadline
        : data.headline;

    return {
        headline,
        summary: data.summary,
        tone: data.tone,
        keyFactors: (Array.isArray(data.key_factors) ? data.key_factors : []).slice(0, 4).map(String),
        suggestions: (Array.isArray(data.suggestions) ? data.suggestions : []).slice(0, 4).map(String),
        risks,
        componentNotes: (Array.isArray(data.component_notes) ? data.component_notes : [])
            // A note about a component that was not forecast is a hallucination or a prompt
            // regression. Either way it does not render.
            .filter((n) => n && validKeys.has(n.component))
            .map((n) => ({ component: n.component, note: n.note })),
        model: PREDICTION_MODEL,
        degraded: false,
    };
};

/* ------------------------------------------------------------------ *
 * The call
 * ------------------------------------------------------------------ */

/**
 * Write the readable half of a forecast.
 *
 * @param {object} input
 * @param {object} input.metric        the registry entry
 * @param {number} input.horizonDays
 * @param {object} input.forecast      `{ components, confidence }` — already settled
 * @param {object} [input.band]        the clinical band of the predicted value, or null
 * @param {object} [input.profile]     age, conditions, medicines, plan advice
 * @param {object[]} [input.related]   other metrics moving at the same time
 * @param {string} input.fallbackHeadline  used when the model invents a figure
 */
const narrate = async ({
    metric, horizonDays, forecast, band = null, profile = null, related = [], fallbackHeadline,
}) => {
    if (!isConfigured()) {
        return { ok: false, error: 'ANTHROPIC_API_KEY is not configured on the server' };
    }

    try {
        const stream = getClient().messages.stream({
            model: PREDICTION_MODEL,
            max_tokens: 3000,
            system: [{ type: 'text', text: PREDICTION_PROMPT, cache_control: { type: 'ephemeral' } }],
            output_config: { format: { type: 'json_schema', schema: PREDICTION_SCHEMA } },
            messages: [{
                role: 'user',
                content: [{
                    type: 'text',
                    text: `${buildContext({ metric, horizonDays, forecast, band, profile, related })}

Write the prediction.`,
                }],
            }],
        });

        const message = await stream.finalMessage();

        // Descriptions of somebody's own blood pressure occasionally trip a classifier.
        // Check before reading content, as nutritionEngine and medicationEngine both do.
        if (message.stop_reason === 'refusal') {
            return { ok: false, error: 'This prediction could not be written automatically.' };
        }

        const textBlock = message.content.find((b) => b.type === 'text');
        if (!textBlock) return { ok: false, error: 'No narrative returned' };

        return {
            ok: true,
            data: mergeNarrative(JSON.parse(textBlock.text), { forecast, horizonDays, fallbackHeadline }),
            usage: message.usage,
            model: PREDICTION_MODEL,
        };
    } catch (error) {
        console.error('❌ Prediction narrative call failed:', error);
        return { ok: false, error: error.message || 'Narrative failed' };
    }
};

/**
 * The prediction as it stands with no model available.
 *
 * `/api/predictions` degrades to this rather than answering 503, and the difference matters:
 * the forecast is the part with the numbers in it and it needs no API key. Losing the prose
 * is a worse experience; losing the projection would be no feature at all. `degraded: true`
 * travels to the client, which labels it — the same call `MedicationCheck.degraded` makes.
 */
const deterministicNarrative = ({ metric, horizonDays, forecast, band, headline }) => {
    const horizon = HORIZON_LABELS[horizonDays] || { long: `the next ${horizonDays} days` };
    const weak = forecast.confidence < WEAK_CONFIDENCE;
    const c = forecast.components[0];

    const parts = [headline];
    parts.push(
        `This is projected from ${c.basis.points} readings over ${Math.round(c.basis.spanDays)} days `
        + `of your own ${metric.label.toLowerCase()} data.`
    );
    if (band?.crisis) {
        parts.unshift('This projection is in a range that needs medical attention now.');
    } else if (band) {
        parts.push(`A value there would be classified as ${band.label.toLowerCase()}.`);
    }
    parts.push(
        weak
            ? 'Confidence is low — there is not much history behind this yet, and it could easily be wrong.'
            : 'Keep logging and this projection will sharpen.'
    );

    return {
        headline,
        summary: parts.join(' '),
        tone: band?.crisis ? 'urgent' : weak ? 'neutral' : 'watchful',
        keyFactors: [],
        suggestions: [],
        risks: [],
        componentNotes: forecast.components.map((comp) => ({
            component: comp.key,
            note: comp.direction === 'flat'
                ? `${comp.label} is projected to hold near ${comp.point}${metric.unit ? ` ${metric.unit}` : ''} over ${horizon.long}.`
                : `${comp.label} is ${comp.direction} towards ${comp.point}${metric.unit ? ` ${metric.unit}` : ''}.`,
        })),
        model: null,
        degraded: true,
    };
};

module.exports = {
    narrate,
    deterministicNarrative,
    mergeNarrative,
    buildContext,
    inventsFigure,
    isConfigured,
    PREDICTION_MODEL,
    WEAK_CONFIDENCE,
};
