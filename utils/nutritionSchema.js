/**
 * Structured output contract for meal analysis.
 *
 * Two constraints learned on `assistantSchema.js` apply here too and are easy to
 * reintroduce by accident:
 *
 *   - A **nullable enum carries `null` inside `enum` and omits `type`**. Writing
 *     `{ type: ['string','null'], enum: [...] }` is rejected outright.
 *   - Every object lists **all** its properties in `required` and sets
 *     `additionalProperties: false`. Optionality is a nullable type, never a missing key.
 */

const MACROS = {
    calories: { type: 'number', description: 'kcal for the portion described, not per 100g' },
    protein: { type: 'number', description: 'grams' },
    carbs: { type: 'number', description: 'grams' },
    fat: { type: 'number', description: 'grams' },
};

const MEAL_ITEM = {
    type: 'object',
    properties: {
        name: { type: 'string', description: 'The component as a person would name it, e.g. "grilled chicken thigh"' },
        quantity: { type: 'string', description: 'Portion as estimated, e.g. "about 150g" or "1 cup"' },
        ...MACROS,
    },
    required: ['name', 'quantity', 'calories', 'protein', 'carbs', 'fat'],
    additionalProperties: false,
};

const ANALYSIS_SCHEMA = {
    type: 'object',
    properties: {
        detected: {
            type: 'boolean',
            description: 'False when the input does not show or describe food. Everything else may then be null or zero.',
        },
        name: { type: 'string', description: 'A short name for the whole meal, e.g. "Hummus & fresh veggie platter with pita"' },
        meal_type: { enum: ['breakfast', 'lunch', 'dinner', 'snack', null], description: 'Only when the food strongly implies it; otherwise null' },
        servings: { type: 'number', description: 'Number of servings shown or described. Usually 1.' },

        ...MACROS,
        fibre: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'grams, or null when it cannot be estimated' },
        sodium: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'milligrams, or null when it cannot be estimated' },

        items: { type: 'array', items: MEAL_ITEM },

        confidence: {
            type: 'number',
            description: '0-1. Below 0.6 when the portion is ambiguous, the photo is unclear, or the description is vague.',
        },
        uncertainties: {
            type: 'array',
            description: 'What could not be judged — hidden ingredients, cooking fat, portion size. Shown to the person so they can correct it.',
            items: { type: 'string' },
        },

        alignment: {
            enum: ['aligned', 'partial', 'off_plan', 'unassessed'],
            description: 'How this meal sits against the dietary guidance supplied. Use "unassessed" only when no guidance was given.',
        },
        alignment_rationale: {
            type: 'string',
            description: 'One or two sentences addressed to the person, naming the specific guidance this relates to. Neutral, never scolding.',
        },
        guidance_keys: {
            type: 'array',
            description: 'The `key` values of the supplied guidance this meal was judged against. Empty when none applied.',
            items: { type: 'string' },
        },

        swap: {
            anyOf: [
                {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        why: { type: 'string', description: 'One sentence: what it moves towards in their plan' },
                        ...MACROS,
                    },
                    required: ['name', 'why', 'calories', 'protein', 'carbs', 'fat'],
                    additionalProperties: false,
                },
                { type: 'null' },
            ],
            description: 'A plan-aligned alternative for the same occasion. Null when the meal is already aligned, or when no guidance was supplied.',
        },
    },
    required: [
        'detected', 'name', 'meal_type', 'servings',
        'calories', 'protein', 'carbs', 'fat', 'fibre', 'sodium',
        'items', 'confidence', 'uncertainties',
        'alignment', 'alignment_rationale', 'guidance_keys', 'swap',
    ],
    additionalProperties: false,
};

/**
 * The analyser does two jobs, and the prompt keeps them separate on purpose: estimating
 * what is in the food, and judging it against this person's plan. Mixing them produces
 * estimates bent towards the advice — a salad scored as fewer calories because the plan
 * asked for salads.
 */
const SYSTEM_PROMPT = `You estimate the nutritional content of a meal and relate it to one
person's health plan. Your output is shown directly to a member of the public in a health
app, and it is saved to their record once they confirm it.

ESTIMATE FIRST, JUDGE SECOND. Work out what the food is and what is in it before you look
at the dietary guidance. Never let the guidance change your numbers: if someone is asked to
eat less refined carbohydrate and they photograph a bowl of white pasta, the carbohydrate
figure is whatever the pasta contains. Bending an estimate to flatter or punish a choice
makes every number in the app worthless.

ESTIMATING
- Estimate for the portion actually shown or described, not per 100g.
- Account for what a photograph hides: cooking oil, butter, dressing, sauces, and sugar in
  drinks. Say so in uncertainties when you have had to assume.
- Use the person's own words for the meal name where they gave any.
- Set confidence honestly. Below 0.6 when the portion is ambiguous, the image is unclear,
  or several very different dishes would look the same. The person is asked to confirm
  low-confidence estimates, so an honest 0.5 is more useful than a confident guess.
- If the input is not food at all, set detected to false and leave the numbers at zero.

JUDGING AGAINST THE PLAN
- You are given this person's dietary guidance, taken from their health plan. Judge only
  against what is there. If no guidance is supplied, alignment is "unassessed", swap is
  null, and guidance_keys is empty. Do not invent general healthy-eating advice — this
  person's plan is the only authority here.
- "aligned" means the meal moves towards the guidance. "partial" means it does some of
  what the guidance asks and not the rest. "off_plan" means it works against it.
- alignment_rationale must name the guidance concretely — "this is mostly refined
  carbohydrate, which your plan asks you to cut back" — not "this is unhealthy".
- Never shame. A person logging an honest record of what they ate is doing the thing the
  app wants; a scolding tone teaches them to stop logging. State what the meal is, what the
  plan asks for, and what would move them closer. No exclamation marks, no judgement of the
  person.

SWAPS
- Suggest a swap only when it would genuinely help: the meal is partial or off plan and a
  realistic alternative exists for the same occasion. Otherwise return null.
- A swap must respect every stated allergy and dietary preference, without exception. If
  the person has recorded a peanut allergy, nothing containing nuts is ever a swap. If you
  cannot suggest something safe, return null rather than something they cannot eat.
- Keep it ordinary and specific — a dish someone would actually cook or order, named the way
  a menu would name it.

You are not a clinician. Do not diagnose, do not mention conditions or biomarkers, and do
not tell anyone to change medication. Nutrition estimates only.`;

module.exports = { ANALYSIS_SCHEMA, SYSTEM_PROMPT };
