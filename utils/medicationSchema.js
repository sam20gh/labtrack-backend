/**
 * Structured output contracts for the two Claude calls the medication checker makes.
 *
 * The two constraints `assistantSchema.js` and `nutritionSchema.js` both record apply here
 * and are easy to reintroduce by accident:
 *
 *   - A **nullable enum carries `null` inside `enum` and omits `type`**. Writing
 *     `{ type: ['string','null'], enum: [...] }` is rejected outright with
 *     *"Enum value 'x' does not match declared type"*.
 *   - Every object lists **all** its properties in `required` and sets
 *     `additionalProperties: false`. Optionality is a nullable type, never a missing key.
 *
 * ── What the model is and is not allowed to decide ────────────────────────────────────
 *
 * Identification is the model's job: reading an imprint off a tablet is exactly what a
 * vision model is for, and there is no deterministic alternative.
 *
 * The interaction verdict is NOT the model's job. `medicationCatalogue.runRules` has already
 * run by the time the review prompt is built, and its findings are handed to the model as
 * settled fact. The model may add a finding the table does not carry, and it may write the
 * summary — it may not contradict, soften, or drop a rule finding. `mergeFindings` in
 * `medicationEngine.js` enforces that mechanically rather than trusting the prompt, because
 * a prompt is a request and a merge function is a guarantee.
 */

const { KNOWN_CLASSES, SEVERITY } = require('./medicationCatalogue');

// ── Identification ───────────────────────────────────────────────────────────────────

const IDENTIFY_SCHEMA = {
    type: 'object',
    properties: {
        detected: {
            type: 'boolean',
            description: 'False when the image does not show a medicine, its packet, or a label. Everything else may then be null.',
        },
        surface: {
            enum: ['tablet', 'capsule', 'packet', 'bottle', 'label', 'blister', 'other', null],
            description: 'What was actually photographed. A box tells you far more than a loose tablet does.',
        },

        name: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: 'The active ingredient in lowercase, e.g. "atorvastatin". Null when it cannot be read or inferred.',
        },
        brandName: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: 'The brand as printed, e.g. "Lipitor". Null when none is visible.',
        },
        strength: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: 'Exactly as printed, with its unit, e.g. "20mg". Null unless it is legible — never estimated from the size of the tablet.',
        },
        form: {
            enum: ['tablet', 'capsule', 'liquid', 'injection', 'inhaler', 'patch', 'drops', 'cream', 'other', null],
            description: 'The dose form.',
        },
        shape: {
            enum: ['round', 'oval', 'oblong', 'capsule', 'square', 'triangle', 'diamond', 'pentagon', 'hexagon', 'teardrop', 'shield', 'trapezoid', 'other', null],
            description: 'Physical shape when a loose tablet or capsule is visible. The design lets people pick this by hand too.',
        },
        colour: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: 'Plain colour word or words, e.g. "white", "pink and white". Null for a packet.',
        },
        imprint: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: 'Any letters, numbers or score line printed on the tablet, transcribed exactly. This is the single most identifying feature — never guess it.',
        },

        confidence: {
            type: 'number',
            description: '0-1. Below 0.6 whenever the identification rests on appearance alone rather than on readable text — many tablets look alike.',
        },
        basis: {
            type: 'string',
            description: 'One sentence naming what the identification actually rests on, e.g. "the name printed on the box" or "a white round tablet with no legible imprint".',
        },
        alternatives: {
            type: 'array',
            description: 'Other medicines this could plausibly be, most likely first. Populate this whenever confidence is below 0.8 — presenting one answer for an ambiguous tablet is the failure mode that matters here.',
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    why: { type: 'string', description: 'What makes it plausible, in one clause' },
                },
                required: ['name', 'why'],
                additionalProperties: false,
            },
        },
        warnings: {
            type: 'array',
            description: 'What the person should know before trusting this, e.g. that generics of different drugs share an appearance, or that the strength was not legible.',
            items: { type: 'string' },
        },
    },
    required: [
        'detected', 'surface', 'name', 'brandName', 'strength', 'form', 'shape', 'colour',
        'imprint', 'confidence', 'basis', 'alternatives', 'warnings',
    ],
    additionalProperties: false,
};

const IDENTIFY_PROMPT = `You identify a medicine from a photograph. Your output is shown to a
member of the public in a health app, and if they accept it, it is added to their medication
list and used to check for drug interactions.

WHAT YOU ARE READING
The picture is one of: a loose tablet or capsule, a blister strip, a box or bottle, or a
printed label. Set "surface" to what you actually see. A box with a printed name is strong
evidence. A loose white tablet is weak evidence, however confident you feel.

READ, DO NOT GUESS
- Transcribe the imprint exactly as printed, character for character. If you cannot read it,
  the imprint is null. A wrong imprint is worse than none, because it looks like evidence.
- The strength comes from printed text only. Never infer a strength from the size of a
  tablet.
- If the name is not printed anywhere, you may infer it from appearance and imprint, but
  say so in "basis" and keep confidence low.

CONFIDENCE IS THE SAFETY CONTROL
Thousands of generic tablets are round and white. Below 0.6 whenever the identification
rests on appearance alone. Above 0.8 only when a name is legibly printed in the image.
Whenever you are below 0.8, fill "alternatives" with the other medicines it could be. An
over-confident single answer is the failure that reaches a person's medication list, and
from there their interaction check.

WHAT YOU MUST NOT DO
- Do not say whether the person should take it, how much to take, or whether it is safe with
  anything else. That check runs separately, against their own record, and is not yours.
- Do not diagnose, and do not infer what condition the person has from the drug.
- Do not describe an unmarked tablet as a specific brand.

The person is shown your answer and has to confirm it before anything is saved. Being
usefully uncertain is worth far more here than being confidently wrong.`;

// ── Interaction review ───────────────────────────────────────────────────────────────

const FINDING = {
    type: 'object',
    properties: {
        kind: {
            enum: ['drug', 'food', 'condition', 'timing', 'duplicate'],
            description: 'What the finding is between.',
        },
        between: {
            type: 'array',
            description: 'Exactly two items, named as the person named them: two medicines, or a medicine and a food, condition, or activity.',
            items: { type: 'string' },
        },
        severity: {
            enum: [...SEVERITY],
            description: '"severe" means it can cause serious harm and needs advice before the next dose. "moderate" needs a conversation at the next opportunity. "mild" is worth knowing and usually solved by timing.',
        },
        effect: {
            type: 'string',
            description: 'What could happen, addressed to the person, in two or three sentences. Concrete and physical — what they would notice — never a mechanism in Latin.',
        },
        action: {
            type: 'string',
            description: 'What to do, today, in one or two sentences. Always something actionable. Never "consult your doctor" alone — say what to ask them.',
        },
    },
    required: ['kind', 'between', 'severity', 'effect', 'action'],
    additionalProperties: false,
};

const REVIEW_SCHEMA = {
    type: 'object',
    properties: {
        summary: {
            type: 'string',
            description: 'Two to four sentences a person reads first. State what was checked and what stood out. If nothing stood out, say what was checked and that this is not the same as being cleared.',
        },
        additional_findings: {
            type: 'array',
            description: 'Interactions NOT already supplied to you in the confirmed findings. Leave empty when you have nothing to add. Do not restate what you were given.',
            items: FINDING,
        },
        classifications: {
            type: 'array',
            description: 'For each medication listed as unclassified: the drug classes it belongs to, chosen ONLY from the supplied vocabulary. This is what lets the deterministic rules cover it next time.',
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'The medication as the person named it' },
                    resolvedName: {
                        anyOf: [{ type: 'string' }, { type: 'null' }],
                        description: 'The active ingredient in lowercase, if you recognise the name. Null if you do not recognise it at all.',
                    },
                    classes: {
                        type: 'array',
                        description: 'Classes from the supplied vocabulary only. Empty when you do not recognise the drug — never guess a class.',
                        items: { type: 'string' },
                    },
                },
                required: ['name', 'resolvedName', 'classes'],
                additionalProperties: false,
            },
        },
        timing_advice: {
            type: 'array',
            description: 'Practical scheduling notes, e.g. a medicine that must be taken on an empty stomach or separated from another by hours. Empty when there is nothing worth saying.',
            items: {
                type: 'object',
                properties: {
                    medication: { type: 'string' },
                    advice: { type: 'string', description: 'One sentence, specific about when.' },
                },
                required: ['medication', 'advice'],
                additionalProperties: false,
            },
        },
        questions_for_clinician: {
            type: 'array',
            description: 'Questions the person could take to their pharmacist or doctor, phrased so they can be read out loud. Two or three at most, and only where something genuinely needs a human answer.',
            items: { type: 'string' },
        },
    },
    required: ['summary', 'additional_findings', 'classifications', 'timing_advice', 'questions_for_clinician'],
    additionalProperties: false,
};

const REVIEW_PROMPT = `You write the readable part of a medication interaction check for one
person, in a consumer health app. A deterministic rule table has already run against their
medication list; its findings are given to you as CONFIRMED FINDINGS and they are settled.

YOUR STANDING RELATIVE TO THE RULE TABLE
- The confirmed findings are facts. You may not contradict them, soften them, lower a
  severity, or argue that one does not apply. If you disagree, say nothing about it.
- Do not restate the confirmed findings in additional_findings. They are already being shown
  to the person in full, above your summary.
- You may add findings the table missed. Add them only when you are confident, and rate
  severity on the same scale.

NEVER ISSUE AN ALL-CLEAR
This is the most important instruction here. The table only knows the medicines the person
has entered, and only the ones in a catalogue of a few dozen drugs. You are told which of
their medicines could not be classified. An empty result means "nothing was found among what
we could check", and your summary must say that plainly rather than "no interactions" or
"you're fine". A person who reads an all-clear will stop asking their pharmacist.

HOW TO WRITE
- Address the person as "you". Short sentences. No Latin, no mechanism unless it changes
  what they should do.
- Be concrete about what they would notice: "bleeding from the stomach, which can show up as
  black or tarry stools" beats "increased haemorrhagic risk".
- Never frighten without a next step. Every serious statement is followed by something they
  can do today.
- Do not tell anyone to stop a prescribed medicine. Tell them what to ask, and who to ask.
- No numbers: no doses, no percentages, no risk multiples. Dosing is prescriber-specific and
  a number here will contradict the label on their box.

CLASSIFYING UNKNOWN MEDICINES
You are given the medicines the catalogue could not classify, and the exact class vocabulary
the rules use. Map each one into that vocabulary if you recognise it. Use only the classes
supplied — a class name that is not in the list matches no rule and is worse than an empty
list, because it looks like coverage. If you do not recognise a name, return an empty array
and a null resolvedName. Say so rather than guessing: a wrongly classified drug produces a
confident warning about the wrong thing.

You are not a clinician and you are not their clinician. You are helping someone arrive at a
pharmacy counter knowing what to ask.`;

module.exports = {
    IDENTIFY_SCHEMA,
    IDENTIFY_PROMPT,
    REVIEW_SCHEMA,
    REVIEW_PROMPT,
    FINDING,
    KNOWN_CLASSES,
};
