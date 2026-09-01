/**
 * Suggests meals for one person, from their plan's dietary guidance and today's gap.
 *
 * Sonnet 5, not Opus. The tier argument is `nutritionEngine.js`'s: this runs at most a
 * handful of times a day per active user, the person chooses whether to act on it, and
 * nothing it produces is written to a clinical record. Opus stays reserved for the
 * once-per-document interpretation.
 *
 * Two things are enforced in code rather than by prompt, and both are the point of the file:
 *
 *   1. **Every suggestion is screened by `nutritionSafety.screen()` before it is returned.**
 *      An allergen or a preference violation is dropped, not flagged. `RECOMMENDATION_PROMPT`
 *      asks for the same thing, and asking is not a guarantee — the same division of labour
 *      `mergeFindings` draws in the interaction checker.
 *   2. **A person with no dietary guidance is told so.** `basis` carries `grounded: false`
 *      and the client captions the rail as general rather than as their plan's. A tracker
 *      whose whole claim is that it enforces the health plan must not present generic advice
 *      as though the plan had asked for it — the same line `alignment: 'unassessed'` holds.
 */
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { RECOMMENDATION_SCHEMA, RECOMMENDATION_PROMPT } = require('./nutritionSchema');
const { buildGuidanceBlock } = require('./nutritionEngine');
const { screen } = require('./nutritionSafety');

const MODEL = 'claude-sonnet-5';

/** How many to ask for. The screen can only remove, so this is a ceiling, never a floor. */
const WANTED = 6;

const isConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

let client = null;
const getClient = () => {
    if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return client;
};

/**
 * What the cached set was generated for.
 *
 * Recomputed on every read and compared against the stored one, exactly as
 * `nutritionTargets.syncGuidance` compares a guidance signature: a set that regenerated
 * every time the dashboard opened would cost a model call per pull-to-refresh and — worse —
 * show the person a different six meals each time, which reads as the app having no opinion.
 *
 * Remaining calories are bucketed to 250 kcal. Suggestions do not meaningfully change
 * between 840 and 870 kcal left, and an unbucketed figure would invalidate the cache on
 * every logged meal.
 */
const signatureFor = ({ plan, remaining, mealType, day }) => {
    const guidance = (plan?.guidance || [])
        .map((g) => `${g.key}:${g.directive}`)
        .sort()
        .join('|');
    const parts = [
        day,
        mealType,
        guidance,
        (plan?.allergies || []).slice().sort().join(','),
        (plan?.dietaryPreferences || []).slice().sort().join(','),
        plan?.notes || '',
        plan?.targets?.calories ?? '',
        remaining == null ? 'null' : Math.round(remaining / 250) * 250,
    ];
    return crypto.createHash('sha1').update(parts.join('~')).digest('hex');
};

/**
 * What they have eaten today, and what is left.
 *
 * Prose rather than JSON, for the reason `buildGuidanceBlock` gives. This block is the
 * volatile half of the prompt and goes in the user turn, below both cache breakpoints —
 * the guidance above it is stable across a session and must stay cacheable.
 */
const buildDayBlock = ({ meals, totals, targets, remaining, mealType }) => {
    const lines = [`It is around ${mealType} time for them.`];

    if (!meals.length) {
        lines.push('They have logged nothing yet today.');
    } else {
        lines.push('Logged so far today:');
        for (const m of meals) {
            lines.push(`- ${m.name} (${m.mealType}) — ${Math.round(m.calories)} kcal, `
                + `${Math.round(m.protein || 0)}g protein, ${Math.round(m.carbs || 0)}g carbs, `
                + `${Math.round(m.fat || 0)}g fat`);
        }
        lines.push(`Totals so far: ${Math.round(totals.calories)} kcal, `
            + `${Math.round(totals.protein)}g protein, ${Math.round(totals.carbs)}g carbs, `
            + `${Math.round(totals.fat)}g fat.`);
    }

    if (targets?.calories) {
        lines.push(remaining != null && remaining > 0
            ? `They have about ${Math.round(remaining)} kcal left against today's target of ${Math.round(targets.calories)}.`
            : `They have already reached today's target of ${Math.round(targets.calories)} kcal. Suggest lighter options, and say so plainly rather than telling them not to eat.`);
        const gap = (key, unit = 'g') => {
            if (targets[key] == null) return null;
            const left = Math.round(targets[key] - (totals[key] || 0));
            return `${key}: ${left > 0 ? `${left}${unit} left` : 'target met'}`;
        };
        const gaps = ['protein', 'carbs', 'fat'].map((k) => gap(k)).filter(Boolean);
        if (gaps.length) lines.push(`Against their macro targets — ${gaps.join('; ')}.`);
    } else {
        lines.push('They have no calorie target set. Do not invent one; suggest sensible portions and say nothing about totals.');
    }

    lines.push('');
    lines.push(`Suggest up to ${WANTED} meals.`);
    return lines.join('\n');
};

/**
 * Generate a set. Returns `{ ok, data }` in the shape `nutritionEngine.run` uses so callers
 * handle the two engines identically.
 *
 * @param {object} context  { plan, meals, totals, targets, remaining, mealType, day }
 */
const recommend = async (context) => {
    if (!isConfigured()) {
        return { ok: false, error: 'ANTHROPIC_API_KEY is not configured on the server' };
    }

    const { plan } = context;

    try {
        const stream = getClient().messages.stream({
            model: MODEL,
            max_tokens: 4000,
            system: [
                { type: 'text', text: RECOMMENDATION_PROMPT, cache_control: { type: 'ephemeral' } },
                { type: 'text', text: buildGuidanceBlock(plan), cache_control: { type: 'ephemeral' } },
            ],
            output_config: { format: { type: 'json_schema', schema: RECOMMENDATION_SCHEMA } },
            messages: [{ role: 'user', content: [{ type: 'text', text: buildDayBlock(context) }] }],
        });

        const message = await stream.finalMessage();
        if (message.stop_reason === 'refusal') {
            return { ok: false, error: 'Suggestions could not be generated for this request.' };
        }

        const textBlock = message.content.find((b) => b.type === 'text');
        if (!textBlock) return { ok: false, error: 'No suggestions returned' };

        const raw = JSON.parse(textBlock.text);

        // The guarantee. Anything the model proposed that this person cannot eat leaves here.
        const { kept, dropped } = screen(raw.suggestions || [], plan);
        if (dropped.length) {
            console.warn('⚠️ Nutrition suggestions dropped by the safety screen:',
                dropped.map((d) => `${d.name} (${d.reason})`).join('; '));
        }

        return {
            ok: true,
            data: {
                headline: raw.headline,
                suggestions: kept.map(normalise),
                dropped: dropped.length,
            },
            usage: message.usage,
            model: MODEL,
        };
    } catch (error) {
        console.error('❌ Meal recommendation failed:', error);
        return { ok: false, error: error.message || 'Could not generate suggestions' };
    }
};

/** Model output → the shape `NutritionRecommendation.suggestions` stores. */
const normalise = (s) => ({
    name: s.name,
    mealType: s.meal_type,
    why: s.why,
    ingredients: s.ingredients || [],
    tags: (s.tags || []).slice(0, 3),
    prepMinutes: s.prep_minutes == null ? undefined : Math.max(0, Math.round(s.prep_minutes)),
    calories: Math.max(0, Math.round(s.calories || 0)),
    protein: Math.max(0, Math.round(s.protein || 0)),
    carbs: Math.max(0, Math.round(s.carbs || 0)),
    fat: Math.max(0, Math.round(s.fat || 0)),
    fibre: s.fibre == null ? undefined : Math.max(0, Math.round(s.fibre)),
    guidanceKeys: s.guidance_keys || [],
});

module.exports = {
    recommend,
    signatureFor,
    buildDayBlock,
    normalise,
    isConfigured,
    MODEL,
    WANTED,
};
