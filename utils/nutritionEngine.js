/**
 * Estimates what is in a meal, and how it sits against the person's health plan.
 *
 * Claude Sonnet 5, matching `reportParser.js`: this is a vision call made several times a
 * day per active user, so it is the high-volume, moderate-stakes tier — not Opus, which
 * `interpretationEngine.js` reserves for the once-per-document clinical read.
 *
 * The plan guidance goes in as a labelled block below the system prompt. It is small,
 * changes only when the person's interpretation is regenerated, and every meal in a session
 * is judged against the same text — so it sits behind a cache breakpoint, and the photo
 * (the volatile part) goes after it.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { ANALYSIS_SCHEMA, SYSTEM_PROMPT } = require('./nutritionSchema');

const MODEL = 'claude-sonnet-5';

/** Below this the client asks the person to confirm before saving. Mirrors reportParser. */
const CONFIDENCE_THRESHOLD = 0.6;

const ACCEPTED_MEDIA = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

const isConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

let client = null;
const getClient = () => {
    if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return client;
};

/**
 * Render the person's dietary context as prompt text.
 *
 * Plain labelled prose rather than JSON, for the reason `interpretationEngine.buildContext`
 * gives: the model misreads a nested object more often than it misreads a sentence.
 *
 * Allergies and preferences are stated as hard constraints and repeated at the end, because
 * they are the one part of this block where being ignored is a safety problem rather than a
 * quality problem.
 */
const buildGuidanceBlock = (plan) => {
    if (!plan) {
        return 'No dietary guidance is on file for this person. Set alignment to "unassessed", '
            + 'guidance_keys to an empty array, and swap to null.';
    }

    const lines = ['## This person\'s dietary guidance'];

    const guidance = (plan.guidance || []).filter((g) => g.directive);
    if (guidance.length === 0) {
        lines.push('No dietary directives are on their health plan.');
        lines.push('Set alignment to "unassessed", guidance_keys to an empty array, and swap to null.');
    } else {
        lines.push('Taken from their health plan. Judge the meal against these and nothing else.');
        lines.push('');
        for (const g of guidance) {
            lines.push(`- key: ${g.key}`);
            lines.push(`  directive: ${g.directive}`);
            if (g.rationale) lines.push(`  why their plan says this: ${g.rationale}`);
            if (g.emphasise?.length) lines.push(`  moves towards: ${g.emphasise.join(', ')}`);
            if (g.reduce?.length) lines.push(`  moves away from: ${g.reduce.join(', ')}`);
        }
    }

    lines.push('');
    lines.push('## Daily targets');
    const t = plan.targets || {};
    lines.push(`Calories: ${t.calories ?? 'not set'} kcal`);
    lines.push(`Protein: ${t.protein ?? 'not set'} g, carbohydrate: ${t.carbs ?? 'not set'} g, fat: ${t.fat ?? 'not set'} g`);
    if (plan.mealsPerDay) lines.push(`They eat around ${plan.mealsPerDay} times a day.`);

    const constraints = [];
    if (plan.allergies?.length) constraints.push(`Allergies: ${plan.allergies.join(', ')}`);
    if (plan.dietaryPreferences?.length) constraints.push(`Dietary preferences: ${plan.dietaryPreferences.join(', ')}`);
    if (plan.notes) constraints.push(`In their own words: "${plan.notes}"`);

    if (constraints.length) {
        lines.push('');
        lines.push('## Hard constraints');
        lines.push(...constraints);
        lines.push('A suggested swap must satisfy every one of these. If nothing safe comes to mind, return null.');
    }

    return lines.join('\n');
};

/**
 * Run the model and return parsed output.
 * Shared by the photo and description paths so the two cannot drift apart in how they
 * handle refusals, missing content blocks, or malformed JSON.
 */
const run = async (contentBlocks, plan) => {
    if (!isConfigured()) {
        return { ok: false, error: 'ANTHROPIC_API_KEY is not configured on the server' };
    }

    try {
        const stream = getClient().messages.stream({
            model: MODEL,
            max_tokens: 4000,
            system: [
                { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
                { type: 'text', text: buildGuidanceBlock(plan), cache_control: { type: 'ephemeral' } },
            ],
            output_config: { format: { type: 'json_schema', schema: ANALYSIS_SCHEMA } },
            messages: [{ role: 'user', content: contentBlocks }],
        });

        const message = await stream.finalMessage();

        // Photographs of food occasionally trip a classifier; check before reading content
        if (message.stop_reason === 'refusal') {
            return {
                ok: false,
                error: 'This image could not be analysed automatically. Please enter the meal manually.',
            };
        }

        const textBlock = message.content.find((b) => b.type === 'text');
        if (!textBlock) return { ok: false, error: 'No analysis returned' };

        return { ok: true, data: JSON.parse(textBlock.text), usage: message.usage, model: MODEL };
    } catch (error) {
        console.error('❌ Meal analysis failed:', error);
        return { ok: false, error: error.message || 'Analysis failed' };
    }
};

/**
 * Analyse a photograph of a meal.
 *
 * @param {Buffer} buffer      image bytes
 * @param {string} mediaType   one of ACCEPTED_MEDIA
 * @param {object|null} plan   the person's NutritionPlan, or null when they have none yet
 * @param {string} [note]      anything they typed alongside the photo
 */
const analysePhoto = async (buffer, mediaType, plan, note) => {
    const blocks = [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } },
        {
            type: 'text',
            text: note
                ? `Estimate the nutrition of this meal. The person adds: "${note}"`
                : 'Estimate the nutrition of this meal.',
        },
    ];
    return run(blocks, plan);
};

/**
 * Analyse a typed description, e.g. "grilled salmon with new potatoes, one plate".
 * The design's search screen; there is no food database behind it, and estimating from a
 * description is both more forgiving of how people actually describe food and one fewer
 * third-party dependency in a health record.
 */
const analyseDescription = async (description, plan) => {
    return run(
        [{ type: 'text', text: `Estimate the nutrition of this meal, described by the person: "${description}"` }],
        plan
    );
};

/** Reshape model output into the fields `MealLog` stores. Never writes; the caller confirms. */
const toMealDraft = (data, { source, imageUrl = null, model = MODEL } = {}) => ({
    name: data.name,
    mealType: data.meal_type || undefined,
    servings: data.servings || 1,
    calories: Math.max(0, Math.round(data.calories || 0)),
    protein: Math.max(0, Math.round(data.protein || 0)),
    carbs: Math.max(0, Math.round(data.carbs || 0)),
    fat: Math.max(0, Math.round(data.fat || 0)),
    fibre: data.fibre == null ? undefined : Math.max(0, Math.round(data.fibre)),
    sodium: data.sodium == null ? undefined : Math.max(0, Math.round(data.sodium)),
    items: (data.items || []).map((i) => ({
        name: i.name,
        quantity: i.quantity,
        calories: Math.max(0, Math.round(i.calories || 0)),
        protein: Math.max(0, Math.round(i.protein || 0)),
        carbs: Math.max(0, Math.round(i.carbs || 0)),
        fat: Math.max(0, Math.round(i.fat || 0)),
    })),
    source,
    imageUrl,
    analysis: {
        confidence: data.confidence,
        alignment: data.alignment || 'unassessed',
        rationale: data.alignment_rationale,
        guidanceKeys: data.guidance_keys || [],
        swap: data.swap || undefined,
        model,
    },
});

module.exports = {
    analysePhoto,
    analyseDescription,
    toMealDraft,
    buildGuidanceBlock,
    isConfigured,
    MODEL,
    CONFIDENCE_THRESHOLD,
    ACCEPTED_MEDIA,
};
