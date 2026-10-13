const { normaliseMeasurement, checkPlausible, PLAUSIBLE, BIOMARKERS } = require('../utils/unitNormaliser');

describe('values that are not physically possible in their stated unit', () => {
    test('albumin 5.0 "g/L" is held for review and offers g/dL, never flagged', () => {
        const norm = normaliseMeasurement({ name: 'Serum Albumin', value: 5, unit: 'g/L' });
        expect(norm.name).toBe('albumin');
        expect(norm.needsReview).toBe(true);
        expect(norm.plausible).toBe(false);
        expect(norm.suggestedUnit).toBe('g/dl');
        expect(norm.suggestedValue).toBe(50);
        // stored as reported: the guard asks, it never converts on its own
        expect(norm.value).toBe(5);
        expect(norm.normalisationNote).toMatch(/not a possible Albumin/);
    });

    test('total protein 8.0 "g/L" offers 80 g/L', () => {
        const norm = normaliseMeasurement({ name: 'Total Protein', value: 8, unit: 'g/L' });
        expect(norm.needsReview).toBe(true);
        expect(norm.suggestedValue).toBe(80);
    });

    test('the same figures in g/dL convert and pass', () => {
        const albumin = normaliseMeasurement({ name: 'Albumin', value: 4.6, unit: 'g/dL' });
        expect(albumin.value).toBe(46);
        expect(albumin.needsReview).toBe(false);
        expect(albumin.plausible).toBeUndefined();
    });

    test('a genuinely abnormal but possible value is untouched', () => {
        const low = normaliseMeasurement({ name: 'Albumin', value: 22, unit: 'g/L' });
        expect(low.needsReview).toBe(false);
        const hb = normaliseMeasurement({ name: 'Haemoglobin', value: 6.1, unit: 'g/dL' });
        expect(hb.needsReview).toBe(false);
    });

    test('haemoglobin in g/L labelled g/dL is caught', () => {
        const norm = normaliseMeasurement({ name: 'Hb', value: 138, unit: 'g/dL' });
        expect(norm.needsReview).toBe(true);
        expect(norm.suggestedValue).toBeCloseTo(13.8);
    });

    test('a value no accepted unit can rescue gets no suggestion', () => {
        const check = checkPlausible('albumin', 9000, 'g/L', 9000);
        expect(check).not.toBeNull();
        expect(check.suggestion).toBeNull();
    });

    test('an unrecognised unit is left to the existing review path', () => {
        const norm = normaliseMeasurement({ name: 'Albumin', value: 5, unit: 'furlongs' });
        expect(norm.needsReview).toBe(true);
        expect(norm.plausible).toBeUndefined();
    });

    test('every limit belongs to a real analyte and is a real interval', () => {
        for (const [name, [min, max]] of Object.entries(PLAUSIBLE)) {
            expect(BIOMARKERS[name]).toBeDefined();
            expect(min).toBeLessThan(max);
        }
    });
});

test('bilirubin in mg/dL labelled µmol/L offers the conversion', () => {
    const norm = normaliseMeasurement({ name: 'Total Bilirubin', value: 0.81, unit: 'µmol/L' });
    expect(norm.needsReview).toBe(true);
    expect(norm.suggestedValue).toBeCloseTo(13.854, 2);
});
