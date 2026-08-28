/**
 * The parse → review → confirm round-trip.
 *
 * A report is parsed, shown to the person, and only then written to the record. The name
 * survives that round-trip through the client, and **which** name it sends decides whether
 * the measurement is ever range-checked.
 *
 * `resolveName` matches composite names by splitting on parentheses and commas, so it
 * resolves "Glycosylated Hemoglobin (HbA1c)". `normaliseMeasurement` slugs anything it
 * cannot match — separators stripped — and the review screen used to send *that slug* back.
 * The second pass then had nothing left to split on, so the value was stored raw,
 * unconverted, in the reported unit, and never compared to a range.
 *
 * That is not hypothetical: one live account had five HbA1c measurements and a calculated
 * LDL stored this way, all showing "Not evaluated". These tests fail if the client ever
 * reverts to sending the canonical/slugged form.
 */
const mongoose = require('mongoose');
const Biomarker = require('../models/Biomarker');
const ReferenceRange = require('../models/ReferenceRange');
const User = require('../models/userModel');
const { persistMeasurements, isGenotypeCall } = require('../controllers/biomarkerController');
const { normaliseMeasurement } = require('../utils/unitNormaliser');

/** Exactly as a lab prints them — the composite forms the parser has to cope with. */
const AS_PRINTED = {
    hba1c: 'Glycosylated Hemoglobin (HbA1c)',
    ldl: 'LDL Cholesterol (Calculated)',
};

const seedUser = () => {
    const id = new mongoose.Types.ObjectId();
    return User.create({
        username: `rt-${id}`,
        firstName: 'Round', lastName: 'Trip',
        email: `rt-${id}@example.com`,
        password: 'x',
        dob: new Date('1986-05-20'),
        // Capitalised: the schema enum is ['Male', 'Female', 'Other', null], while
        // `biomarkerEvaluator` lowercases before matching a ReferenceRange.
        gender: 'Male',
    });
};

const seedRanges = () => ReferenceRange.insertMany([
    { biomarker: 'hba1c', displayName: 'HbA1c', unit: 'mmol/mol', sex: 'any', ageMin: 18, ageMax: 200, max: 42, criticalMax: 86 },
    { biomarker: 'ldl_cholesterol', displayName: 'LDL Cholesterol', unit: 'mmol/L', sex: 'any', ageMin: 18, ageMax: 200, max: 3.0, criticalMax: 5.0 },
]);

describe('name resolution across the round-trip', () => {
    it('resolves the composite name a lab actually prints', () => {
        expect(normaliseMeasurement({ name: AS_PRINTED.hba1c, value: 5.69, unit: '%' }))
            .toMatchObject({ name: 'hba1c', unit: 'mmol/mol', recognised: true });

        expect(normaliseMeasurement({ name: AS_PRINTED.ldl, value: 103, unit: 'mg/dL' }))
            .toMatchObject({ name: 'ldl_cholesterol', unit: 'mmol/L', recognised: true });
    });

    it('cannot resolve the slug of that same name — the regression this guards', () => {
        // Nothing left to split on. This is what the client used to send back.
        const slugged = normaliseMeasurement({
            name: 'glycosylatedhemoglobinhba1c', value: 5.69, unit: '%',
        });
        expect(slugged.recognised).toBe(false);
        expect(slugged.name).toBe('glycosylatedhemoglobinhba1c');
        expect(slugged.needsReview).toBe(true);
    });

    it('converts the unit as well as the name, which the slug path silently skipped', () => {
        // DCCT % → IFCC mmol/mol is affine, so a stored 5.69 is not "close enough" to 38.69:
        // it is off the scale entirely, and would have been flagged against the wrong band.
        const { value, unit } = normaliseMeasurement({ name: AS_PRINTED.hba1c, value: 5.69, unit: '%' });
        expect(unit).toBe('mmol/mol');
        expect(value).toBeCloseTo(38.69, 1);
    });
});

describe('what reaches the record', () => {
    let user;
    beforeEach(async () => {
        user = await seedUser();
        await seedRanges();
    });

    it('stores a range-checked measurement when sent the printed name', async () => {
        const { saved } = await persistMeasurements({
            userId: user._id,
            user,
            measurements: [
                { name: AS_PRINTED.hba1c, value: 5.69, unit: '%' },
                { name: AS_PRINTED.ldl, value: 103, unit: 'mg/dL' },
            ],
            source: 'lab_report',
        });

        expect(saved).toHaveLength(2);

        const hba1c = saved.find((b) => b.name === 'hba1c');
        expect(hba1c.value).toBeCloseTo(38.69, 1);
        expect(hba1c.unit).toBe('mmol/mol');
        expect(hba1c.flag).toBe('normal');
        expect(hba1c.needsReview).toBe(false);
        expect(hba1c.appliedRange.max).toBe(42);

        const ldl = saved.find((b) => b.name === 'ldl_cholesterol');
        expect(ldl.value).toBeCloseTo(2.66, 2);
        expect(ldl.flag).toBe('normal');
    });

    it('leaves the value unevaluated when sent the slug, as the live data shows', async () => {
        const { saved } = await persistMeasurements({
            userId: user._id,
            user,
            measurements: [{ name: 'glycosylatedhemoglobinhba1c', value: 5.69, unit: '%' }],
            source: 'lab_report',
        });

        const [row] = saved;
        // Every one of these is a defect the person sees: no verdict, the wrong unit, a
        // display name that is the key, and no trend shared with their other HbA1c results.
        expect(row.flag).toBe('unknown');
        expect(row.unit).toBe('%');
        expect(row.needsReview).toBe(true);
        expect(row.displayName).toBe('glycosylatedhemoglobinhba1c');
        expect(await Biomarker.countDocuments({ userId: user._id, name: 'hba1c' })).toBe(0);
    });

    it('keeps the lab wording as the display name for a genuinely unknown analyte', async () => {
        // The fallback still applies to analytes outside the catalogue — but it should now
        // preserve what the report said rather than storing the key twice.
        const { saved } = await persistMeasurements({
            userId: user._id,
            user,
            measurements: [{ name: 'Red Cell Distribution Width', value: 13.1, unit: '%' }],
            source: 'lab_report',
        });

        const [row] = saved;
        expect(row.name).toBe('redcelldistributionwidth');
        expect(row.displayName).toBe('Red Cell Distribution Width');
        expect(row.flag).toBe('unknown');
    });

    it('is idempotent on the unit when the client sends an already-canonical value', async () => {
        // The review screen sends `normalisedValue` with `normalisedUnit`, so the server
        // converts canonical → canonical. That must be a no-op, or every confirmed report
        // would be converted twice.
        const { saved } = await persistMeasurements({
            userId: user._id,
            user,
            measurements: [{ name: AS_PRINTED.ldl, value: 2.66, unit: 'mmol/L' }],
            source: 'lab_report',
        });

        expect(saved[0].value).toBeCloseTo(2.66, 2);
        expect(saved[0].unit).toBe('mmol/L');
    });
});

describe('genotype calls are not measurements', () => {
    it('recognises a dbSNP identifier, with or without the called genotype appended', () => {
        expect(isGenotypeCall('rs429358')).toBe(true);
        expect(isGenotypeCall('rs429358ct')).toBe(true);
        expect(isGenotypeCall('RS7412 CC')).toBe(true);
        // Not a SNP: analyte names that merely start with the same letters.
        expect(isGenotypeCall('rbc')).toBe(false);
        expect(isGenotypeCall('RDW')).toBe(false);
        expect(isGenotypeCall('')).toBe(false);
    });

    it('refuses to store one, and says why', async () => {
        const user = await seedUser();
        const { saved, failed } = await persistMeasurements({
            userId: user._id,
            user,
            measurements: [
                { name: 'rs429358ct', value: 25.22, unit: '%' },
                { name: 'Ferritin', value: 120, unit: 'ng/mL' },
            ],
            source: 'lab_report',
        });

        // Rejected loudly rather than stored and hidden: the upload path that produced it is
        // the thing that needs fixing, and a silent skip hides it.
        expect(saved.map((b) => b.name)).toEqual(['ferritin']);
        expect(failed).toHaveLength(1);
        expect(failed[0].reason).toMatch(/genetic variant/i);
        expect(await Biomarker.countDocuments({ userId: user._id, name: /^rs/ })).toBe(0);
    });
});
