/**
 * Plain-language glossary.
 *
 * The failure this guards against is silent and user-facing: someone adds an analyte to
 * `unitNormaliser` so the app can store and flag it, forgets the glossary, and a member of
 * the public is shown "GGT 61 U/L — High" with no way to find out what that is. Nothing
 * throws, no request fails, and the gap is invisible until a user reports it.
 *
 * The content assertions are deliberately about *shape* rather than wording — copy will be
 * revised, but an entry that quietly loses its `low` string leaves a flagged result with a
 * dangling half-explanation.
 */
const {
    GLOSSARY, UNCATALOGUED, explain, explainFlag, listGlossary, auditGlossary,
} = require('../utils/biomarkerGlossary');
const { listBiomarkers } = require('../utils/unitNormaliser');

describe('coverage', () => {
    it('explains every analyte the catalogue can store', () => {
        const { missing } = auditGlossary();
        expect(missing).toEqual([]);
    });

    it('has no entries for analytes that no longer exist', () => {
        const { orphaned } = auditGlossary();
        expect(orphaned).toEqual([]);
    });

    it('covers the full catalogue, not a subset that happens to match', () => {
        const catalogued = listGlossary().filter((e) => !UNCATALOGUED[e.name]);
        expect(catalogued).toHaveLength(listBiomarkers().length);
    });

    it('explains the analytes real reports carry that the catalogue does not normalise', () => {
        // Observed on a live full blood count: all of these are stored under run-together
        // fallback keys, shown without a verdict, and were previously unexplained.
        for (const name of [
            'neutrophils', 'lymphocytes', 'monocytes', 'eosinophils', 'basophils',
            'mch', 'mchc', 'redcelldistributionwidth',
            'nonhdlcholesterol', 'cholesteroltohdlratio', 'estimatedaverageglucose',
        ]) {
            expect(explain(name)).not.toBeNull();
        }
    });
});

describe('entry shape', () => {
    // Both tables: an uncatalogued entry is read by the same UI and held to the same bar.
    const entries = [...Object.entries(GLOSSARY), ...Object.entries(UNCATALOGUED)];

    it.each(entries)('%s carries all five fields, non-empty', (name, entry) => {
        for (const field of ['plainName', 'whatItIs', 'whyItMatters', 'low', 'high']) {
            expect(typeof entry[field]).toBe('string');
            expect(entry[field].trim().length).toBeGreaterThan(0);
        }
    });

    it.each(entries)('%s has a plainName short enough to sit under a row title', (name, entry) => {
        // A label, not a definition. Anything longer wraps and stops being scannable.
        expect(entry.plainName.length).toBeLessThanOrEqual(34);
    });

    it.each(entries)('%s quotes no thresholds', (name, entry) => {
        // Ranges are personal — sex, age, and gene-adjusted per ReferenceRange. A number
        // baked into the copy will eventually contradict the band the user is shown.
        const numeric = /\d+(\.\d+)?\s*(mmol|ng|mg|µmol|umol|pmol|nmol|g\/|U\/L|fL|%)/i;
        expect(`${entry.low} ${entry.high} ${entry.whatItIs} ${entry.whyItMatters}`)
            .not.toMatch(numeric);
    });

    it.each(entries)('%s hedges rather than diagnoses', (name, entry) => {
        // "means you have" is the phrasing that turns information into a diagnosis.
        expect(`${entry.low} ${entry.high}`).not.toMatch(/means you have|you have (cancer|diabetes|disease)/i);
    });
});

describe('explain', () => {
    it('supplies a presentable medical name for every entry', () => {
        // The row title falls back to this whenever the stored displayName is the mangled
        // slug the fallback path writes.
        for (const { name } of listGlossary()) {
            expect(explain(name).label).toEqual(expect.any(String));
        }
    });

    it('resolves a canonical name', () => {
        expect(explain('mcv').plainName).toBe('Average red blood cell size');
    });

    it('is case- and punctuation-insensitive, matching how names arrive from reports', () => {
        expect(explain('MCV')).toEqual(explain('mcv'));
        expect(explain('Vitamin B12')).toEqual(explain('vitamin_b12'));
    });

    it('resolves the fallback keys canonicalise() produces for uncatalogued spellings', () => {
        // A report printing the words out in full must not lose its explanation.
        expect(explain('mean_corpuscular_volume')).toEqual(explain('mcv'));
        expect(explain('Hematocrit')).toEqual(explain('haematocrit'));
    });

    it('matches whether or not the stored key kept its separators', () => {
        // canonicalise() strips separators entirely for analytes outside the catalogue, so
        // the same test arrives as 'redcelldistributionwidth' from a report and
        // 'red_cell_distribution_width' from anywhere that normalises first.
        expect(explain('Red Cell Distribution Width')).toEqual(explain('redcelldistributionwidth'));
        expect(explain('RDW')).toEqual(explain('redcelldistributionwidth'));
    });

    it('explains a lab spelling that failed to normalise, so the row is not left bare', () => {
        // Stored as 'glycosylatedhemoglobinhba1c' on a live report — it never reached the
        // hba1c key, so it carries no range and no flag. It should still say what it is,
        // and title as 'HbA1c' rather than as the slug.
        expect(explain('glycosylatedhemoglobinhba1c')).toEqual(explain('hba1c'));
        expect(explain('glycosylatedhemoglobinhba1c').label).toBe('HbA1c');
        expect(explain('calculatedldl').label).toBe('LDL Cholesterol');
    });

    it('returns null rather than a generic placeholder for an unknown analyte', () => {
        // "This measures something in your blood" is worse than silence: it looks like an
        // answer, so the client would render it instead of falling back.
        expect(explain('lipoprotein_a')).toBeNull();
        expect(explain('')).toBeNull();
        expect(explain(undefined)).toBeNull();
    });

    it('hands back a copy, so a caller cannot mutate the shared table', () => {
        const first = explain('ferritin');
        first.plainName = 'mutated';
        expect(explain('ferritin').plainName).toBe('Iron stores');
    });
});

describe('explainFlag', () => {
    it('picks the direction that applies to the value', () => {
        expect(explainFlag('ferritin', 'low')).toBe(GLOSSARY.ferritin.low);
        expect(explainFlag('ferritin', 'high')).toBe(GLOSSARY.ferritin.high);
        expect(explainFlag('ferritin', 'critical_low')).toBe(GLOSSARY.ferritin.low);
        expect(explainFlag('ferritin', 'critical_high')).toBe(GLOSSARY.ferritin.high);
    });

    it('says nothing for an in-range or unevaluated result', () => {
        // Someone whose bloods are fine does not need a paragraph per row about what would
        // have been wrong.
        expect(explainFlag('ferritin', 'normal')).toBeNull();
        expect(explainFlag('ferritin', 'unknown')).toBeNull();
    });

    it('says nothing for an analyte it cannot explain', () => {
        expect(explainFlag('lipoprotein_a', 'high')).toBeNull();
    });
});
