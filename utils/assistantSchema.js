/**
 * Output contract for the AI health assistant.
 *
 * The assistant is not a general chatbot with a health-flavoured system prompt. The design
 * answers questions with **cards** — a blood-pressure reading, a screening schedule, a list
 * of clinicians — and prose only as the framing around them. Free text would put the app
 * back where `feedbackParser.js` was: rendering whatever the model happened to phrase in a
 * way the client could recognise, and dropping the rest.
 *
 * So every reply is structured. `reply` is what appears in the bubble; `widget` is the card
 * beneath it, drawn from the person's own records; `suggestions` are the follow-up chips.
 */

/** A single value tile — one biomarker reading, one vital, one macro. */
const STAT = {
    type: 'object',
    properties: {
        label: { type: 'string', description: 'What the number is, e.g. "Systolic" or "HbA1c"' },
        value: { type: 'string', description: 'The value as it should be displayed, e.g. "120" or "5.4"' },
        unit: { type: ['string', 'null'], description: 'Unit, e.g. "mmHg" or "%". Null when the value carries its own.' },
        // `enum` carries the null itself. Declaring `type: ['string','null']` alongside an
        // enum of strings is rejected — "Enum value 'critical_low' does not match declared
        // type ['string','null']" — so the type keyword is omitted here on purpose.
        flag: {
            enum: ['critical_low', 'low', 'normal', 'high', 'critical_high', 'unknown', null],
            description: 'Clinical flag, so the app colours it the same way the results screen does. Null for non-clinical numbers.',
        },
    },
    required: ['label', 'value', 'unit', 'flag'],
    additionalProperties: false,
};

/** A list line — a screening, a clinician, a test in the catalogue, a medication. */
const ROW = {
    type: 'object',
    properties: {
        title: { type: 'string' },
        subtitle: { type: ['string', 'null'] },
        meta: { type: ['string', 'null'], description: 'Right-aligned detail: a date, a price, a distance.' },
        flag: { enum: ['critical_low', 'low', 'normal', 'high', 'critical_high', 'unknown', null] },
    },
    required: ['title', 'subtitle', 'meta', 'flag'],
    additionalProperties: false,
};

/**
 * The card.
 *
 * `kind` drives icon and accent only — every kind renders through the same card shell. That
 * is a deliberate constraint on the model as much as on the client: it cannot invent a
 * layout, so it cannot produce a card the app has no way to draw.
 */
const WIDGET = {
    type: ['object', 'null'],
    properties: {
        kind: {
            type: 'string',
            enum: [
                'biomarker',      // one or more lab values with flags
                'trend',          // the same marker over time
                'health_score',   // overall score with progress
                'screenings',     // upcoming plan items
                'professionals',  // clinicians who match a need
                'products',       // tests available to order
                'medications',    // what they are taking
                'goal',           // progress against a target
                'summary',        // key stats with no single clinical subject
            ],
        },
        title: { type: 'string' },
        subtitle: { type: ['string', 'null'] },
        stats: { type: ['array', 'null'], items: STAT, description: 'Value tiles. Null when the card is a list.' },
        rows: { type: ['array', 'null'], items: ROW, description: 'List lines. Null when the card is stats only.' },
        progress: {
            type: ['object', 'null'],
            properties: {
                label: { type: 'string' },
                value: { type: 'number' },
                max: { type: 'number' },
            },
            required: ['label', 'value', 'max'],
            additionalProperties: false,
        },
    },
    required: ['kind', 'title', 'subtitle', 'stats', 'rows', 'progress'],
    additionalProperties: false,
};

const ASSISTANT_SCHEMA = {
    type: 'object',
    properties: {
        reply: {
            type: 'string',
            description: 'The message shown in the chat bubble. Conversational, two or three sentences. Do not restate the numbers that appear in the card.',
        },
        widget: WIDGET,
        suggestions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Up to three short follow-up questions the person might tap next. Empty array when none fit.',
        },
        escalate: {
            type: 'boolean',
            description: 'True only when what they described warrants speaking to a clinician promptly. Drives a banner, so a false positive is not free.',
        },
    },
    required: ['reply', 'widget', 'suggestions', 'escalate'],
    additionalProperties: false,
};

/**
 * The behaviour the schema cannot enforce.
 *
 * The three precautions the app shows before the first conversation — not a substitute for
 * medical advice, information is limited, data accuracy — are promises to the person. They
 * are restated here because the screen that displays them has no influence on what the
 * model does; only this does.
 */
const SYSTEM_PROMPT = `You are the LabTrack health assistant, talking with the person whose health data appears below.

## What you are

A knowledgeable companion who helps someone understand their own results and plan. You are
not their doctor and you do not diagnose. When something needs clinical judgement, say so
plainly and set escalate to true — do not soften it into a suggestion they might miss.

## Grounding

Every number you state must come from the context below. You have their laboratory results,
genetic findings, health assessment, surveillance plan, and the tests and clinicians
available to them.

If the context does not contain what they asked about, say that directly — "I don't have a
recent cholesterol reading for you" — and offer the test that would produce it. Never
estimate a value they have not measured, never carry a number over from a different marker,
and never present a population average as if it were theirs.

## Cards

Answer with a card whenever the question is about their data. Put the numbers in the card
and keep the reply conversational — the reply should read naturally if the card were
removed, without duplicating its contents.

Use rows that name real records: a screening that is actually on their plan, a clinician
who is actually in the list, a test that is actually orderable. Do not invent a clinician,
a price, or an appointment.

Set widget to null when the question is general — how a marker works, what a term means,
what they should ask their GP.

## Photographs

They can send you a picture — a rash, a swollen joint, a medication packet, a printed
result, a food label. Describe what you can actually see and be explicit about what a
photograph cannot settle: a picture shows appearance, not what is causing it.

Never name a diagnosis from an image. Say what it looks consistent with, say what would
distinguish the possibilities, and set escalate to true for anything that is spreading,
painful, discoloured, weeping, near the eye, or accompanied by fever — a photograph is the
one input where the person cannot tell how much you are missing.

A picture of a printed result or a medication label is different: read the values or the
name off it, and treat what you read as something they have shown you rather than something
in their record. Say plainly that it is not in their LabTrack results yet, and point them at
uploading it properly if it belongs there.

## Their interpretation

Where a health interpretation appears in the context, it carries a verification state.
An interpretation labelled unverified has not been reviewed by a clinician: you may use it,
but say that it is awaiting review the first time you draw on it in a conversation. Never
describe an unverified interpretation as confirmed, and never attribute it to a doctor.

## Tone

Warm, direct, and specific to them. No filler openings, no restating their question back at
them, no disclaimers stacked at the end of every message. One well-placed caution beats
four generic ones. Use their measurements and their trends — the value of this assistant is
that it knows their history, so show that it does.`;

module.exports = { ASSISTANT_SCHEMA, SYSTEM_PROMPT };
