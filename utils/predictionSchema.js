/**
 * The structured-output contract for the one Claude call the predictor makes.
 *
 * The two constraints `assistantSchema.js`, `nutritionSchema.js` and `medicationSchema.js`
 * all record apply here too, and are easy to reintroduce by accident:
 *
 *   - A **nullable enum carries `null` inside `enum` and omits `type`**. Writing
 *     `{ type: ['string','null'], enum: [...] }` is rejected outright.
 *   - Every object lists **all** its properties in `required` and sets
 *     `additionalProperties: false`. Optionality is a nullable type, never a missing key.
 *
 * ── What the model is and is not allowed to decide ────────────────────────────────────
 *
 * It decides **none of the numbers**. `utils/predictionForecast.js` has already produced the
 * interval, the direction, the confidence and the band by the time this prompt is built, and
 * they are handed over as settled fact. This call writes the sentences a person reads.
 *
 * That is the same split the medication checker makes between `runRules` and `review`, and
 * for the same reason: a forecast a model produced cannot be reproduced, cannot be unit
 * tested, and cannot be scored against what actually happened. A regression can be all
 * three, and `Prediction.resolution` does the third.
 *
 * The schema therefore has no numeric fields at all except `chance`, which is copied from
 * the forecast's own confidence by `mergeNarrative` and overwritten there whatever the model
 * returns. There is deliberately no way for the model to express "actually I think it will
 * be 140" — the field does not exist.
 */

const PREDICTION_SCHEMA = {
    type: 'object',
    properties: {
        headline: {
            type: 'string',
            description:
                'One sentence, second person, in the shape the app prints large: "In 1 week, your blood '
                + 'pressure will elevate to 126/96 mmHg". Use the horizon and the figures EXACTLY as given '
                + 'to you. Say "is likely to" or "we expect" — never "will definitely". Max 120 characters.',
        },
        summary: {
            type: 'string',
            description:
                'Two to four sentences explaining what the forecast rests on and what it means for them. '
                + 'Name what the projection was built from (how many readings, over how long). If the '
                + 'confidence you were given is below 0.6, say plainly that this is a weak signal. Never '
                + 'introduce a figure that was not given to you.',
        },
        tone: {
            enum: ['reassuring', 'neutral', 'watchful', 'urgent'],
            description:
                'How the app frames the card. "urgent" ONLY when the band you were given is a crisis or '
                + 'stage 2 category — it is not for a large percentage change in a harmless metric.',
        },

        key_factors: {
            type: 'array',
            description:
                'Two to four short noun phrases naming what in their record is driving this — '
                + '"Consistent sleep", "Rising resting heart rate", "Irregular logging". Three words or '
                + 'fewer each. Draw them ONLY from the context given; do not speculate about diet or '
                + 'stress if nothing in the context mentions either.',
            items: { type: 'string' },
        },

        suggestions: {
            type: 'array',
            description:
                'Two to four concrete things this person could do next, each one sentence and each '
                + 'something they can act on today. No doses, no numeric targets, no "consult your doctor" '
                + 'as a filler line — if a clinician is genuinely warranted, say what to ask them.',
            items: { type: 'string' },
        },

        risks: {
            type: 'array',
            description:
                'Conditions this PATTERN is associated with, at most three, most relevant first. These are '
                + 'associations, never diagnoses, and the app labels them as such. Return an empty array '
                + 'unless the forecast genuinely points at something — a mildly rising step count is '
                + 'associated with nothing and padding this list is the failure mode that matters here.',
            items: {
                type: 'object',
                properties: {
                    label: {
                        type: 'string',
                        description: 'Phrased as a possibility, e.g. "Possible prediabetes risk". Max 40 characters.',
                    },
                    detail: {
                        type: 'string',
                        description: 'One sentence saying what in the forecast points at it.',
                    },
                    risk: {
                        enum: ['high', 'moderate', 'low'],
                        description: 'How strongly the pattern points at it — NOT how serious the condition is.',
                    },
                    preventable: {
                        type: 'boolean',
                        description: 'Whether anything in their control plausibly changes this trajectory.',
                    },
                },
                required: ['label', 'detail', 'risk', 'preventable'],
                additionalProperties: false,
            },
        },

        component_notes: {
            type: 'array',
            description:
                'One short note per component you were given, in the same order. For blood pressure that '
                + 'is systolic and diastolic; for a single-series metric it is one entry. Say what the '
                + 'projection does and whether it leaves the normal range — using only the figures given.',
            items: {
                type: 'object',
                properties: {
                    component: { type: 'string', description: 'The component key exactly as given, e.g. "systolic".' },
                    note: { type: 'string', description: 'One sentence, max 90 characters.' },
                },
                required: ['component', 'note'],
                additionalProperties: false,
            },
        },
    },
    required: ['headline', 'summary', 'tone', 'key_factors', 'suggestions', 'risks', 'component_notes'],
    additionalProperties: false,
};

const PREDICTION_PROMPT = `You write the readable half of a health forecast for a consumer
health app. A member of the public reads your words on a screen that also shows a chart of
their own measurements.

WHAT HAS ALREADY BEEN DECIDED, AND IS NOT YOURS TO CHANGE
A statistical projection has already been computed from this person's own recorded data. You
are given its interval, its direction, its confidence and — where the metric has one — the
clinical band the predicted value falls into. Those are settled.

- Never state a figure that was not given to you. Not a rounder one, not a range you widened,
  not a "roughly" version. If you need a number, copy it.
- Never contradict the direction or the band. If you are told the projection is flat, do not
  write that it is climbing.
- Never present the forecast as a measurement. It is an extrapolation from a handful of
  readings and the person is entitled to know that.

CONFIDENCE IS PART OF THE MESSAGE
You are told how confident the projection is. Below 0.6 that has to appear in your summary in
plain words — "this is based on only a few readings and could easily be wrong" — not as a
hedge buried in a subordinate clause. A weak forecast presented confidently is the single
worst thing this feature can do.

WHAT YOU ARE NOT
You are not diagnosing. "risks" are patterns associated with a trajectory, and the app labels
them that way. Do not name a condition the context gives you no reason to name. An empty
risks array is a perfectly good answer and is the right answer most of the time.

You are not prescribing. No doses, no numeric targets, no supplement names. Suggestions are
behaviours and questions.

TONE
Second person, present tense, plain words. A number that is out of range is stated, not
softened. A number that is fine is stated, not celebrated. No exclamation marks, no "great
news", no "don't worry".

If the forecast is for blood pressure and the band you were given is a crisis category, your
summary's first sentence must tell them to seek medical care now, before anything else.`;

module.exports = { PREDICTION_SCHEMA, PREDICTION_PROMPT };
