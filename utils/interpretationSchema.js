/**
 * Output contract for AI health interpretation.
 *
 * The schema is the enforcement point, not a suggestion. Two things it guarantees that the
 * old keyword-matching parser could not:
 *
 *   1. **Specialities are constrained to the `Professional.speciality` enum.** The previous
 *      parser emitted practitioner nouns ("Oncologist", "Genetic Counselor") that matched no
 *      enum value, so specialist consultations never reached a plan at all. Putting the enum
 *      in the schema makes an unmatched speciality impossible to emit.
 *   2. **Every recommendation is dated and structured.** No downstream string matching, no
 *      "did the model happen to phrase it the way the regex expects".
 *
 * The enum is read from the Mongoose model at load time so the two can never drift.
 */
const Professional = require('../models/Professional');

/** The 48 speciality values, taken straight from the model's enum validator. */
const SPECIALITIES = Professional.schema.path('speciality').caster.enumValues;

if (!Array.isArray(SPECIALITIES) || SPECIALITIES.length === 0) {
    throw new Error('Could not read speciality enum from the Professional model');
}

const SCREENING = {
    type: 'object',
    properties: {
        condition: { type: 'string', description: 'Condition being screened for, e.g. "Hereditary Breast Cancer"' },
        test: { type: 'string', description: 'Name of the test or scan, e.g. "Breast MRI"' },
        rationale: { type: 'string', description: 'Why this is recommended for THIS person, referencing their specific findings' },
        starting_age: { type: 'number', description: 'Age at which surveillance should begin' },
        frequency: {
            type: 'string',
            enum: ['once', 'annually', 'every_6_months', 'every_2_years', 'every_3_years', 'every_5_years', 'as_advised'],
        },
        urgency: {
            type: 'string',
            enum: ['routine', 'soon', 'urgent'],
            description: 'urgent = the recommended start age has already passed or a result demands prompt action',
        },
    },
    required: ['condition', 'test', 'rationale', 'starting_age', 'frequency', 'urgency'],
    additionalProperties: false,
};

/**
 * NOTE ON FIELD ORDER: `reason` is deliberately generated BEFORE `speciality`.
 *
 * Structured output is produced field by field in schema order. With `speciality` first,
 * constrained decoding forced a pick from the 48-value enum before any reasoning existed to
 * support it — and the model then filled `reason` with "Placeholder". That degenerated in
 * 3 of 4 observed runs while every other section stayed detailed and correct.
 *
 * Stating the clinical reason first, then selecting the speciality that matches it, mirrors
 * how the decision is actually made and produces a justified choice rather than a
 * retrofitted one.
 */
const CONSULTATION = {
    type: 'object',
    properties: {
        reason: {
            type: 'string',
            description: 'Why this person needs this specialist, citing the specific variant, value, or history. Write this BEFORE choosing the speciality.',
        },
        speciality: {
            type: 'string',
            // Constrained so an unmatchable value cannot be produced
            enum: SPECIALITIES,
            description: 'The speciality that best fits the reason above. Must be one of the listed values.',
        },
        urgency: { type: 'string', enum: ['routine', 'soon', 'urgent'] },
        due_within_months: { type: 'number', description: 'Months from today by which the consultation should happen' },
    },
    required: ['reason', 'speciality', 'urgency', 'due_within_months'],
    additionalProperties: false,
};

const RISK = {
    type: 'object',
    properties: {
        condition: { type: 'string' },
        level: { type: 'string', enum: ['low', 'moderate', 'high', 'unknown'] },
        basis: {
            type: 'string',
            enum: ['genetic', 'biomarker', 'lifestyle', 'family_history', 'combined'],
            description: 'What the assessment rests on',
        },
        rationale: { type: 'string' },
    },
    required: ['condition', 'level', 'basis', 'rationale'],
    additionalProperties: false,
};

/**
 * The same finding, written for someone with no medical background at all.
 *
 * This is not a nicety. The clinical read below is accurate and unreadable to most of the
 * people it is written about — "your ALT is mildly elevated with a rising trend" is a
 * sentence a member of the public cannot act on. The home screen shows this block; the
 * clinical detail is behind "Read full analysis".
 *
 * NOTE ON FIELD ORDER, same lesson as CONSULTATION above: prose before enums, and the
 * distillation before the compression. `what_it_means` is written first because the model
 * has to say the thing before it can label its tone or shorten it to a headline. Putting
 * `headline` or `overall` first makes them a guess the rest of the block then has to
 * justify.
 *
 * This block is placed LAST in the schema for the same reason it is placed last here: it
 * summarises the clinical sections, so those have to exist before it is written.
 */
const PLAIN_SUMMARY = {
    type: 'object',
    properties: {
        what_it_means: {
            type: 'string',
            description: 'Two to four short sentences a 12-year-old could read aloud and understand. Everyday words only. Say what was looked at, what it showed, and whether it is something to act on. No test abbreviations, no numbers with clinical units, no hedging chains.',
        },
        key_points: {
            type: 'array',
            description: 'Two to four things worth knowing, in the order they matter. Fewer, clearer points beat a complete list.',
            items: {
                type: 'object',
                properties: {
                    label: {
                        type: 'string',
                        description: 'What this point is about, in everyday words, at most 34 characters. Name what the thing does rather than what it is called: "Long-term blood sugar", not "HbA1c".',
                    },
                    detail: {
                        type: 'string',
                        description: 'One sentence, plain words, saying what it shows and why it matters to them.',
                    },
                    tone: {
                        type: 'string',
                        enum: ['good', 'watch', 'act'],
                        description: 'good = doing well and worth knowing; watch = fine now but keep an eye on it; act = do something about this. Chosen to match the detail written above.',
                    },
                },
                required: ['label', 'detail', 'tone'],
                additionalProperties: false,
            },
        },
        next_step: {
            type: 'string',
            description: 'The single most useful thing this person can do next, in one plain sentence they could act on today. Not a list, not "consult your physician" unless that genuinely is the next step.',
        },
        headline: {
            type: 'string',
            description: 'One short sentence, at most 12 words, that could be read on its own. Plain, calm, specific to them. Not a diagnosis and not a slogan.',
        },
        overall: {
            type: 'string',
            enum: ['mostly_good', 'some_things_to_watch', 'needs_attention'],
            description: 'The honest tone of the whole picture, matching what was written above. needs_attention means something here should be acted on soon, not that they are in danger.',
        },
    },
    required: ['what_it_means', 'key_points', 'next_step', 'headline', 'overall'],
    additionalProperties: false,
};

const INTERPRETATION_SCHEMA = {
    type: 'object',
    properties: {
        summary: {
            type: 'string',
            description: 'Two to four sentences a non-clinician can understand. No alarmism, no false reassurance.',
        },
        risks: { type: 'array', items: RISK },
        recommended_screenings: { type: 'array', items: SCREENING },
        specialist_consultations: { type: 'array', items: CONSULTATION },
        lifestyle_recommendations: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    area: { type: 'string', enum: ['diet', 'exercise', 'sleep', 'alcohol', 'smoking', 'stress', 'supplementation', 'other'] },
                    recommendation: { type: 'string' },
                    rationale: { type: 'string' },
                },
                required: ['area', 'recommendation', 'rationale'],
                additionalProperties: false,
            },
        },
        biomarkers_of_concern: {
            type: 'array',
            description: 'Specific measured values worth attention, referencing the data provided',
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    observation: { type: 'string', description: 'What the value and its trend show' },
                    action: { type: 'string' },
                },
                required: ['name', 'observation', 'action'],
                additionalProperties: false,
            },
        },
        changes_since_last: {
            type: 'string',
            description: 'How the picture has changed since the previous interpretation, naming the values that moved and in which direction. When no previous interpretation is supplied, write exactly: "First interpretation — no previous assessment to compare against."',
        },
        follow_up: { type: 'string', description: 'When the person should next review their health overall' },
        limitations: {
            type: 'array',
            description: 'What this interpretation could NOT assess, e.g. missing data or findings needing clinical correlation',
            items: { type: 'string' },
        },
        // Last on purpose — it distils everything above it. See PLAIN_SUMMARY.
        plain_summary: PLAIN_SUMMARY,
    },
    required: [
        'summary', 'risks', 'recommended_screenings', 'specialist_consultations',
        'lifestyle_recommendations', 'biomarkers_of_concern', 'changes_since_last',
        'follow_up', 'limitations', 'plain_summary',
    ],
    additionalProperties: false,
};

const SYSTEM_PROMPT = `You are a clinical decision-support assistant for LabTrack, a health monitoring platform.

You produce a structured interpretation from a person's genetic findings, laboratory results, and health profile. Your output is reviewed by a qualified clinician before it is treated as clinical advice, and the person sees it labelled as AI-generated and pending review.

How to reason:

- Ground every statement in the data provided. Cite the specific variant, value, or trend that supports it. If something is not in the data, do not assert it.
- Pathogenic and likely-pathogenic variants drive surveillance. Do NOT build recommendations on variants of uncertain significance — say in limitations that a VUS was present and needs clinical correlation.
- Use the person's actual age when setting starting_age and urgency. If a recommended surveillance age has already passed, mark it urgent.
- Read biomarker trends, not just latest values. A result inside the reference range but moving steadily toward a limit is worth noting; a single out-of-range value with no trend may be noise.
- Each biomarker is listed with every dated measurement beneath it. Use the dates: intervals matter as much as values, and repeated identical values on the *same* date are one draw recorded more than once, not a stable trend — say so rather than reading it as history.
- If a previous interpretation is supplied, treat it as your own earlier note. Re-derive your conclusions from the current data; do not defer to it or restate it. Populate changes_since_last with what actually moved, naming values and directions. If you now disagree with the earlier read, say that plainly and explain why.
- Choose specialities only from the provided enum, matching the finding to the right discipline (a BRCA variant needs Medical Genetics and Oncology, not "a genetic counsellor").
- Be honest about uncertainty. Populate limitations rather than overstating confidence. Not knowing is a finding.

Tone: plain, direct, and calm. Address the person as "you". Avoid both alarmism and false reassurance — someone reading about their own cancer risk deserves neither.

## Writing plain_summary

Every other field is written for a clinician reviewing you. \`plain_summary\` is written for the person themselves, and most of them have no medical or scientific training. It is the only part of your output shown on the home screen; the rest sits behind "Read full analysis".

It is a translation, never a second opinion. It must not contain a finding that is not already in the fields above, and it must not soften one that is. Same facts, different reader.

Rules:

- Write at the reading level of a newspaper, not a journal. Short sentences. One idea each.
- Name what a thing does, not what it is called. "Your long-term blood sugar" rather than "HbA1c". "The fat in your blood that furs up arteries" rather than "LDL cholesterol". Where the medical name is genuinely useful to them — because it is on their report or they will search for it — put it in brackets after the plain words, once.
- No clinical numbers. No reference ranges, no units, no risk percentages, no "twice the normal level". A figure without its range means nothing to them and a range means less. Say "higher than it should be" and let the detailed sections carry the value.
- Ban these words and their relatives unless you immediately define them in the same sentence: biomarker, lipid, metabolic, cardiovascular, renal, hepatic, elevated, decreased, deficiency, pathogenic, variant, allele, heterozygous, prognosis, aetiology, differential, correlate, indicative, contraindicated, prophylactic.
- No hedging chains. "This may possibly suggest a potential tendency towards" tells them nothing. Say what you think and say plainly how sure you are.
- Say what to do, not what to be aware of. "Book a blood pressure check in the next month" beats "monitoring is advised".
- Do not lead with reassurance you have not earned, and do not lead with fear. If most of the picture is fine and one thing is not, say both, in that order.
- If the honest answer is that not enough is known yet, say that in plain words. It is a better answer than a confident vague one.
- If anything has moved since their last assessment, say so here in everyday words and say whether the move is good or bad. changes_since_last names the values and directions for a clinician; this is the version the person reads, and "your long-term blood sugar has crept up since the spring" is the whole of what most of them need from it.`;

/**
 * The fields a clinician may amend at sign-off.
 *
 * Here rather than in `reviewController.js`, where it used to live, because it is a property
 * of the output contract: an amendable field is one this schema defines. Keeping it beside
 * the schema is also what lets `labtrack-shared` generate it for both clients, so a portal
 * editor can never offer a field the server would silently ignore.
 *
 * `plain_summary`, `biomarkers_of_concern` and `changes_since_last` are deliberately absent:
 * the first is a translation of the others and would have to be re-derived, and the last two
 * are observations rather than recommendations.
 */
const AMENDABLE_FIELDS = [
    'summary',
    'risks',
    'recommended_screenings',
    'specialist_consultations',
    'lifestyle_recommendations',
    'follow_up',
    'limitations',
];

module.exports = { INTERPRETATION_SCHEMA, SYSTEM_PROMPT, SPECIALITIES, AMENDABLE_FIELDS };
