/**
 * Plan engine and biomarker evaluation.
 *
 * These lock in the behaviours that were bugs earlier in the build: consultations pinned to
 * age 50, screenings emitting ten occurrences regardless of frequency, gene modifiers
 * silently not applying, and units compared across scales.
 */
const { firstDueDate, occurrenceDates, matchProduct } = require('../utils/planGeneratorV2');
const { classify, applyGeneModifiers } = require('../utils/biomarkerEvaluator');
const { normaliseMeasurement, resolveName } = require('../utils/unitNormaliser');
const { dueOffset } = require('../jobs/reminderJob');
const PlanItem = require('../models/PlanItem');

const daysFromNow = (n) => new Date(Date.now() + n * 86400000);

describe('firstDueDate', () => {
    it('is due today when the starting age has already passed', () => {
        const due = firstDueDate('1978-03-14', 30);
        expect(due.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('falls on a future birthday when the age is still ahead', () => {
        const due = firstDueDate('1995-06-01', 40);
        expect(due.getFullYear()).toBe(2035);
    });
});

describe('occurrenceDates — frequency is honoured', () => {
    it('produces exactly one occurrence for a once-only test', () => {
        // The old generator emitted ten regardless
        expect(occurrenceDates(new Date(), 'once')).toHaveLength(1);
        expect(occurrenceDates(new Date(), 'as_advised')).toHaveLength(1);
    });

    it('spaces annual screenings a year apart', () => {
        const dates = occurrenceDates(new Date('2026-01-01'), 'annually');
        expect(dates.length).toBeGreaterThan(1);
        expect(dates[1].getFullYear()).toBe(2027);
    });

    it('caps the list so a plan never becomes a calendar dump', () => {
        expect(occurrenceDates(new Date(), 'every_6_months').length).toBeLessThanOrEqual(6);
    });
});

describe('matchProduct', () => {
    const products = [
        { _id: '1', name: 'CA-125' },
        { _id: '2', name: 'Transvaginal Ultrasound' },
        { _id: '3', name: 'Breast MRI' },
    ];

    it('prefers the most specific match on a combined recommendation', () => {
        // Returning the first match offered the £59.99 blood test over the £279 scan
        const match = matchProduct('Transvaginal ultrasound plus serum CA-125', products);
        expect(match.name).toBe('Transvaginal Ultrasound');
    });

    it('returns null when nothing matches', () => {
        expect(matchProduct('Risk-reducing salpingo-oophorectomy', products)).toBeNull();
    });
});

describe('biomarker classification', () => {
    it('flags below and above a two-sided range', () => {
        expect(classify(25, { min: 30, max: 400 })).toBe('low');
        expect(classify(500, { min: 30, max: 400 })).toBe('high');
        expect(classify(100, { min: 30, max: 400 })).toBe('normal');
    });

    it('escalates past a critical bound', () => {
        expect(classify(5, { min: 30, max: 400, criticalMin: 10 })).toBe('critical_low');
    });

    it('handles a one-sided analyte', () => {
        expect(classify(2.1, { max: 3.0 })).toBe('normal');
        expect(classify(4.0, { max: 3.0 })).toBe('high');
    });

    it('returns unknown when there are no bounds at all', () => {
        expect(classify(42, {})).toBe('unknown');
    });
});

describe('gene modifiers', () => {
    const range = {
        min: 30, max: 400,
        geneModifiers: [{ gene: 'HFE', max: 200, rationale: 'iron overload risk' }],
    };

    it('narrows the range for a carrier', () => {
        const result = applyGeneModifiers(range, new Map([['HFE', 'C282Y']]));
        expect(result.max).toBe(200);
        expect(result.geneAdjusted).toBe(true);
    });

    it('leaves a non-carrier on the population range', () => {
        const result = applyGeneModifiers(range, new Map());
        expect(result.max).toBe(400);
        expect(result.geneAdjusted).toBe(false);
    });
});

describe('unit normalisation — the dangerous conversions', () => {
    it('converts mg/dL glucose to mmol/L instead of comparing across scales', () => {
        // 90 mg/dL against a mmol/L range would read as critical_high
        const result = normaliseMeasurement({ name: 'Glucose', value: 90, unit: 'mg/dL' });
        expect(result.name).toBe('fasting_glucose');
        expect(result.value).toBeCloseTo(5.0, 1);
        expect(result.unit).toBe('mmol/L');
    });

    it('applies the affine DCCT to IFCC conversion for HbA1c', () => {
        const result = normaliseMeasurement({ name: 'HbA1c', value: 6.0, unit: '%' });
        expect(result.value).toBeCloseTo(42.08, 1);
    });

    it('resolves composite analyte names labs actually print', () => {
        expect(resolveName('ALT (SGPT)')).toBe('alt');
        expect(resolveName('Glucose, Fasting')).toBe('fasting_glucose');
        expect(resolveName('25-OH Vitamin D')).toBe('vitamin_d');
    });

    it('marks an unrecognised unit for review rather than evaluating it', () => {
        const result = normaliseMeasurement({ name: 'Ferritin', value: 25, unit: 'furlongs' });
        expect(result.needsReview).toBe(true);
    });

    it('keeps an unknown analyte without pretending to evaluate it', () => {
        const result = normaliseMeasurement({ name: 'Unobtainium', value: 42, unit: 'ng/mL' });
        expect(result.needsReview).toBe(true);
        expect(result.recognised).toBe(false);
    });
});

describe('PlanItem.deriveStatus', () => {
    it('marks a past due date urgent', () => {
        expect(PlanItem.deriveStatus(daysFromNow(-5))).toBe('urgent');
    });

    it('marks today due and the future upcoming', () => {
        expect(PlanItem.deriveStatus(new Date())).toBe('due');
        expect(PlanItem.deriveStatus(daysFromNow(30))).toBe('upcoming');
    });
});

describe('reminder scheduling', () => {
    const prefs = { offsetDays: [7, 0], overdueReminders: true };
    const item = (days, sent = []) => ({
        dueDate: daysFromNow(days),
        reminder: { offsetDays: [7, 0], sentOffsets: sent },
    });

    it('fires at a configured offset', () => {
        expect(dueOffset(item(7), prefs)).toBe(7);
        expect(dueOffset(item(0), prefs)).toBe(0);
    });

    it('never fires the same offset twice', () => {
        expect(dueOffset(item(7, [7]), prefs)).toBeNull();
        expect(dueOffset(item(0, [0]), prefs)).toBeNull();
    });

    it('stays quiet on a day that is not an offset', () => {
        expect(dueOffset(item(3), prefs)).toBeNull();
    });

    it('nudges overdue items weekly rather than daily', () => {
        expect(dueOffset(item(-3), prefs)).toBeNull();
        expect(dueOffset(item(-7), prefs)).toBe(-1);
        expect(dueOffset(item(-7, [-1]), prefs)).toBeNull();
        expect(dueOffset(item(-14, [-1]), prefs)).toBe(-2);
    });

    it('respects the overdue preference being off', () => {
        expect(dueOffset(item(-30), { ...prefs, overdueReminders: false })).toBeNull();
    });
});
