/**
 * The generated client types, and the schema they come from.
 *
 * `labtrack-shared/generate.mjs` emits both clients' TypeScript for the interpretation
 * contract from `INTERPRETATION_SCHEMA`. This is the only repo with a test suite, so this is
 * where the guarantee lives: change the schema without regenerating and this fails.
 *
 * The failure it prevents is silent by construction. A client type that names a field the
 * model never writes renders nothing; one that misses a field the model does write hides
 * clinical content. Neither breaks a build — the portal had three such mistakes at once
 * before the generator existed.
 */
const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const {
    INTERPRETATION_SCHEMA,
    AMENDABLE_FIELDS,
    SPECIALITIES,
} = require('../utils/interpretationSchema');

const generator = path.join(__dirname, '..', '..', 'labtrack-shared', 'generate.mjs');

describe('AMENDABLE_FIELDS', () => {
    it('names only fields the schema actually defines', () => {
        // An amendable field the schema does not produce is an editor for something that can
        // never appear, and `submitReview` would happily record an amendment to it.
        for (const field of AMENDABLE_FIELDS) {
            expect(Object.keys(INTERPRETATION_SCHEMA.properties)).toContain(field);
        }
    });

    it('excludes the fields that are derived rather than recommended', () => {
        // `plain_summary` is a translation of the others and would have to be re-derived;
        // the other two are observations, not recommendations.
        expect(AMENDABLE_FIELDS).not.toContain('plain_summary');
        expect(AMENDABLE_FIELDS).not.toContain('biomarkers_of_concern');
        expect(AMENDABLE_FIELDS).not.toContain('changes_since_last');
    });
});

describe('the speciality enum', () => {
    it('is read from the model rather than restated', () => {
        const Professional = require('../models/Professional');
        expect(SPECIALITIES).toEqual(Professional.schema.path('speciality').caster.enumValues);
    });

    it('uses the directory spelling, not the practitioner noun', () => {
        // "Cardiologist" matches no `Professional.speciality`, and `planGeneratorV2` compares
        // by substring in both directions — neither contains the other, so a referral spelled
        // that way can never resolve.
        expect(SPECIALITIES).toContain('Cardiology');
        expect(SPECIALITIES).not.toContain('Cardiologist');
    });
});

describe('generated client types', () => {
    const runnable = existsSync(generator);

    // Skipped rather than failed when only this repo is checked out: the generator writes
    // into sibling repos, and their absence is a normal state, not a regression.
    (runnable ? it : it.skip)('are up to date with the schema', () => {
        expect(() =>
            execFileSync('node', [generator, '--check'], { encoding: 'utf8', stdio: 'pipe' })
        ).not.toThrow();
    });
});
