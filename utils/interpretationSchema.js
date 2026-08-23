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
        follow_up: { type: 'string', description: 'When the person should next review their health overall' },
        limitations: {
            type: 'array',
            description: 'What this interpretation could NOT assess, e.g. missing data or findings needing clinical correlation',
            items: { type: 'string' },
        },
    },
    required: [
        'summary', 'risks', 'recommended_screenings', 'specialist_consultations',
        'lifestyle_recommendations', 'biomarkers_of_concern', 'follow_up', 'limitations',
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
- Choose specialities only from the provided enum, matching the finding to the right discipline (a BRCA variant needs Medical Genetics and Oncology, not "a genetic counsellor").
- Be honest about uncertainty. Populate limitations rather than overstating confidence. Not knowing is a finding.

Tone: plain, direct, and calm. Address the person as "you". Avoid both alarmism and false reassurance — someone reading about their own cancer risk deserves neither.`;

module.exports = { INTERPRETATION_SCHEMA, SYSTEM_PROMPT, SPECIALITIES };
