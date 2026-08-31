/**
 * The plain-language layer on an interpretation.
 *
 * The point of these tests is not that the model writes well — nothing can assert that.
 * It is that the two guarantees around it hold in code rather than only in the prompt:
 *
 *   1. An analysis whose plain-language block is missing or empty never reaches a person.
 *      This block is the only part of the interpretation most users will read, so a
 *      degenerate one is not a cosmetic fault — it is the whole feature failing silently
 *      while the card still looks like it worked. Same argument `findQualityIssues`
 *      already makes for a "Placeholder" consultation reason.
 *   2. Clinical wording is detected, but is never fatal. Failing an entire analysis over
 *      one word would cost the person their assessment to fix a readability problem.
 */
const {
    findQualityIssues, findPlainLanguageWarnings,
} = require('../utils/interpretationEngine');
const { INTERPRETATION_SCHEMA, SYSTEM_PROMPT } = require('../utils/interpretationSchema');

/** A well-formed plain-language block. */
const PLAIN = {
    what_it_means:
        'Most of your blood test came back in the usual range. One of the fats in your '
        + 'blood is a little higher than it should be, and it has crept up since last year. '
        + 'This is worth doing something about, but it is not urgent.',
    key_points: [
        { label: 'Blood sugar', detail: 'Steady and in the usual range over the past two years.', tone: 'good' },
        { label: 'Fat in your blood', detail: 'A little higher than it should be, and rising slowly.', tone: 'act' },
    ],
    next_step: 'Book a repeat blood test in three months so we can see which way this is going.',
    headline: 'Most things look fine, one worth acting on',
    overall: 'some_things_to_watch',
};

/** An otherwise-valid interpretation, so the plain block is the only thing under test. */
const interpretation = (plain_summary) => ({
    summary: 'Lipid profile shows an isolated LDL elevation with an upward trend across two draws. '
        + 'Glycaemic markers are stable. No genetic findings bear on this.',
    risks: [],
    recommended_screenings: [],
    specialist_consultations: [],
    lifestyle_recommendations: [],
    biomarkers_of_concern: [],
    changes_since_last: 'First interpretation — no previous assessment to compare against.',
    follow_up: 'Review in twelve months.',
    limitations: [],
    plain_summary,
});

describe('the schema asks for a plain-language block', () => {
    const props = INTERPRETATION_SCHEMA.properties;

    it('requires plain_summary, so it cannot be omitted', () => {
        expect(INTERPRETATION_SCHEMA.required).toContain('plain_summary');
        expect(props.plain_summary.required).toEqual(
            expect.arrayContaining(['what_it_means', 'key_points', 'next_step', 'headline', 'overall']),
        );
    });

    /**
     * The lesson `CONSULTATION` already records: structured output is generated in schema
     * order, and an enum picked before the prose that justifies it degenerates. `overall`
     * and `tone` are both picks that have to follow their own reasoning.
     */
    it('generates the prose before the enum that labels it', () => {
        const order = Object.keys(props.plain_summary.properties);
        expect(order.indexOf('what_it_means')).toBeLessThan(order.indexOf('overall'));
        expect(order.indexOf('what_it_means')).toBeLessThan(order.indexOf('headline'));

        const point = Object.keys(props.plain_summary.properties.key_points.items.properties);
        expect(point.indexOf('detail')).toBeLessThan(point.indexOf('tone'));
    });

    /** It distils the clinical sections, so they have to exist before it is written. */
    it('is the last field in the schema', () => {
        const order = Object.keys(props);
        expect(order[order.length - 1]).toBe('plain_summary');
    });

    it('tells the model what plain actually means', () => {
        expect(SYSTEM_PROMPT).toMatch(/Writing plain_summary/);
        expect(SYSTEM_PROMPT).toMatch(/No clinical numbers/);
    });
});

describe('a degenerate plain-language block is caught', () => {
    it('passes a well-formed one', () => {
        expect(findQualityIssues(interpretation(PLAIN))).toEqual([]);
    });

    it('rejects an analysis with no plain block at all', () => {
        expect(findQualityIssues(interpretation(undefined)))
            .toContain('plain_summary is missing');
    });

    it('rejects placeholder text where the explanation should be', () => {
        const issues = findQualityIssues(interpretation({ ...PLAIN, what_it_means: 'TBD' }));
        expect(issues).toContain('plain_summary.what_it_means is empty or placeholder text');
    });

    it('rejects a block with no key points', () => {
        expect(findQualityIssues(interpretation({ ...PLAIN, key_points: [] })))
            .toContain('plain_summary has no key points');
    });

    it('names the key point that says nothing', () => {
        const issues = findQualityIssues(interpretation({
            ...PLAIN,
            key_points: [{ label: 'Blood sugar', detail: 'N/A', tone: 'good' }],
        }));
        expect(issues).toContain('plain_summary key point 1 (Blood sugar) says nothing');
    });

    /** The clinical summary is still checked; the plain block is an addition, not a swap. */
    it('still rejects a degenerate clinical summary', () => {
        const data = interpretation(PLAIN);
        data.summary = 'Placeholder';
        expect(findQualityIssues(data)).toContain('summary is empty or placeholder text');
    });
});

describe('clinical wording is reported but never fatal', () => {
    it('finds nothing to warn about in plain English', () => {
        expect(findPlainLanguageWarnings(interpretation(PLAIN))).toEqual([]);
    });

    it('catches jargon anywhere in the block, not just the paragraph', () => {
        expect(findPlainLanguageWarnings(interpretation({
            ...PLAIN,
            key_points: [{ label: 'Cholesterol', detail: 'Mildly elevated since last year.', tone: 'act' }],
        }))).toContain('elevated');

        expect(findPlainLanguageWarnings(interpretation({
            ...PLAIN,
            headline: 'Your cardiovascular picture is stable',
        }))).toContain('cardiovascular');
    });

    /**
     * "your LDL (the fat that furs up arteries)" is exactly what the prompt asks for. A
     * checker that punished it would push the model towards vaguer copy, not plainer copy.
     */
    it('forgives a term the sentence immediately defines', () => {
        expect(findPlainLanguageWarnings(interpretation({
            ...PLAIN,
            what_it_means: 'One of your lipids (the fats in your blood) is higher than it should be.',
        }))).toEqual([]);
    });

    /** Jargon is a readability problem. Losing the analysis over it is a worse one. */
    it('does not fail the analysis', () => {
        const jargony = interpretation({ ...PLAIN, next_step: 'Discuss prophylactic options with your doctor.' });
        expect(findPlainLanguageWarnings(jargony)).toContain('prophylactic');
        expect(findQualityIssues(jargony)).toEqual([]);
    });
});
