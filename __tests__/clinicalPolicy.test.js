/**
 * Clinical policy.
 *
 * These two rules are expected to change under regulatory pressure, so what matters is
 * that flipping them changes behaviour correctly *without* touching the schema or the
 * client. The tests exercise both settings of each, including the one that cannot occur
 * today — otherwise the switch is untested until the day it is urgent.
 */
const { presentToPatient, requiresReview } = require('../config/clinicalPolicy');

const AI = { summary: 'What the model said.' };
const CORRECTED = { summary: 'What the clinician said.' };

describe('presentToPatient — current policy (unverified is shown)', () => {
    it('shows an unreviewed interpretation, marked unverified', () => {
        const shown = presentToPatient({ content: AI, review: { status: 'pending' } });
        expect(shown.status).toBe('unverified');
        expect(shown.withheld).toBe(false);
        expect(shown.content).toEqual(AI);
    });

    it('prefers the clinician amendment over the AI text once signed off', () => {
        const shown = presentToPatient({
            content: AI,
            amended: { content: CORRECTED },
            review: { status: 'amended' },
        });
        expect(shown.status).toBe('amended');
        // The whole point: a correction reaches the patient.
        expect(shown.content).toEqual(CORRECTED);
    });

    it('falls back to the original when approved without edits', () => {
        const shown = presentToPatient({ content: AI, review: { status: 'approved' } });
        expect(shown.status).toBe('approved');
        expect(shown.content).toEqual(AI);
    });

    it('handles having no interpretation at all', () => {
        const shown = presentToPatient(null);
        expect(shown.content).toBeNull();
        expect(shown.withheld).toBe(false);
    });

    it('requires review of everything', () => {
        expect(requiresReview(AI)).toBe(true);
    });
});

describe('presentToPatient — the regulatory switch (sign-off required first)', () => {
    // The real function, with the policy flag flipped. This is the setting that cannot
    // occur today; testing it now is what makes it safe to turn on later.
    const strict = (i) => presentToPatient(i, { showsUnverified: false });

    it('withholds an unreviewed interpretation and returns no content', () => {
        const shown = strict({ content: AI, review: { status: 'pending' } });
        expect(shown.status).toBe('unverified');
        expect(shown.withheld).toBe(true);
        // Nothing leaks: the client renders its awaiting-review state from this.
        expect(shown.content).toBeNull();
    });

    it('still releases one a clinician has signed, amendment first', () => {
        const shown = strict({ content: AI, amended: { content: CORRECTED }, review: { status: 'amended' } });
        expect(shown.withheld).toBe(false);
        expect(shown.content).toEqual(CORRECTED);
    });

    it('releases an approved interpretation unchanged', () => {
        const shown = strict({ content: AI, review: { status: 'approved' } });
        expect(shown.withheld).toBe(false);
        expect(shown.content).toEqual(AI);
    });
});
