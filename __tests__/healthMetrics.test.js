/**
 * Blood-pressure staging and hydration targets.
 *
 * The blood-pressure half of this file is the reason `utils/bloodPressure.js` is a table
 * rather than a model, and it is the same argument `medicationInteractions.test.js` makes: you
 * cannot assert that a model will always catch a hypertensive crisis, and there is no way to
 * find out afterwards which reading was the one it missed.
 *
 * What has to hold:
 *   - The **worse of the two numbers** decides the category. A systolic-only reading of the
 *     table files half of real hypertension as normal, and that is the failure most likely to
 *     be reintroduced by someone simplifying this.
 *   - A crisis is never just another band.
 *   - A nonsense or transposed reading is refused rather than filed.
 *   - Hydration never scores a day nobody logged, and never suggests an unsafe target.
 */
const bp = require('../utils/bloodPressure');
const hydration = require('../utils/hydrationTargets');
const { _scoreHydration, _scoreVitals } = require('../utils/labtrackScore');

describe('blood pressure — the worse number decides', () => {
    it('stages a normal systolic with a high diastolic on the diastolic', () => {
        // The case a systolic-only gauge gets wrong, and the reason `match: 'either'` exists.
        expect(bp.classify(118, 92).key).toBe('stage_2');
        expect(bp.classify(118, 92).driver).toBe('diastolic');

        expect(bp.classify(125, 85).key).toBe('stage_1');
        expect(bp.classify(125, 85).driver).toBe('diastolic');
    });

    it('stages a high systolic with a normal diastolic on the systolic', () => {
        expect(bp.classify(135, 75).key).toBe('stage_1');
        expect(bp.classify(135, 75).driver).toBe('systolic');
        expect(bp.classify(145, 78).key).toBe('stage_2');
    });

    it('reserves elevated for a raised systolic with a normal diastolic', () => {
        expect(bp.classify(125, 78).key).toBe('elevated');
        // The same systolic with a raised diastolic is not elevated, it is stage 1.
        expect(bp.classify(125, 82).key).toBe('stage_1');
    });

    it('classifies the textbook boundaries the way the guideline does', () => {
        expect(bp.classify(119, 79).key).toBe('normal');
        expect(bp.classify(120, 79).key).toBe('elevated');
        expect(bp.classify(130, 79).key).toBe('stage_1');
        expect(bp.classify(140, 79).key).toBe('stage_2');
        expect(bp.classify(119, 80).key).toBe('stage_1');
        expect(bp.classify(119, 90).key).toBe('stage_2');
    });

    it('has a category for a low reading rather than calling it normal', () => {
        expect(bp.classify(85, 55).key).toBe('low');
        expect(bp.classify(85, 55).key).not.toBe('normal');
    });

    it('flags a crisis separately from the band', () => {
        const c = bp.classify(190, 125);
        expect(c.key).toBe('crisis');
        expect(c.isCrisis).toBe(true);
        // Every non-crisis reading must say so, so a screen cannot forget to check.
        expect(bp.classify(145, 88).isCrisis).toBe(false);
    });

    it('treats a single crisis systolic as a crisis even with a normal diastolic', () => {
        expect(bp.classify(200, 70).isCrisis).toBe(true);
    });
});

describe('blood pressure — refusing what it cannot classify', () => {
    it('refuses a transposed reading rather than filing it', () => {
        expect(bp.classify(80, 120)).toBeNull();
    });

    it('refuses implausible numbers', () => {
        expect(bp.classify(300, 90)).toBeNull();
        expect(bp.classify(40, 20)).toBeNull();
        expect(bp.classify(NaN, 80)).toBeNull();
        expect(bp.classify(120, undefined)).toBeNull();
    });

    it('accepts a genuinely severe reading — the limits reject typos, not physiology', () => {
        expect(bp.classify(220, 130)).not.toBeNull();
        expect(bp.classify(220, 130).isCrisis).toBe(true);
    });
});

describe('blood pressure — summarising a window', () => {
    const readings = [
        { systolic: 118, diastolic: 76 },
        { systolic: 122, diastolic: 78 },
        { systolic: 190, diastolic: 124 },  // one crisis
        { systolic: 120, diastolic: 74 },
    ];

    it('reports the worst reading alongside the mean', () => {
        const s = bp.summarise(readings);
        // The average of these four looks unremarkable, which is exactly the problem.
        expect(s.mean.category.isCrisis).toBe(false);
        expect(s.hadCrisis).toBe(true);
        expect(s.worst.category.key).toBe('crisis');
    });

    it('caps the score when the window contained a crisis, however good the mean', () => {
        const withCrisis = bp.score(bp.summarise(readings));
        const without = bp.score(bp.summarise(readings.slice(0, 2).concat(readings[3])));
        expect(withCrisis).toBeLessThan(without);
        expect(withCrisis).toBeLessThanOrEqual(5);
    });

    it('returns null for a window with nothing in it', () => {
        expect(bp.summarise([])).toBeNull();
        expect(bp.score(null)).toBeNull();
    });

    it('carries the one-reading-is-not-a-diagnosis note', () => {
        expect(bp.summarise(readings).note).toMatch(/not a diagnosis/i);
    });
});

describe('hydration targets', () => {
    it('scales the target with body mass rather than using a flat figure', () => {
        expect(hydration.computeTarget({ weightKg: 50 }).ml)
            .toBeLessThan(hydration.computeTarget({ weightKg: 100 }).ml);
    });

    it('adds for recorded activity', () => {
        expect(hydration.computeTarget({ weightKg: 70, exerciseMin: 60 }).ml)
            .toBeGreaterThan(hydration.computeTarget({ weightKg: 70 }).ml);
    });

    it('states its default rather than guessing when there is no weight', () => {
        const t = hydration.computeTarget({});
        expect(t.ml).toBe(hydration.DEFAULT_TARGET_ML);
        expect(t.basis.join(' ')).toMatch(/no weight on record/i);
    });

    it('never suggests an unsafe target, however heavy or active', () => {
        const t = hydration.computeTarget({ weightKg: 200, exerciseMin: 300 });
        expect(t.ml).toBeLessThanOrEqual(hydration.CAPS.daily);
        expect(t.note).toMatch(/not safer|fluid limit/i);
    });

    it('counts coffee and tea in full — the dehydration claim is a myth', () => {
        for (const d of hydration.DRINK_TYPES) expect(d.factor).toBe(1);
    });
});

describe('hydration — a day nobody logged is not a failed day', () => {
    it('has no level for a day with no logs', () => {
        expect(hydration.levelFor(0, 2300, { logs: 0 })).toBeNull();
    });

    it('excludes unlogged days from the score instead of scoring them zero', () => {
        const logged = [{ logs: 4, consumedMl: 2300, targetMl: 2300 }];
        const withGaps = [...logged, { logs: 0, consumedMl: 0, targetMl: 2300 }];
        // The empty day must not drag the score down — it is absence of data, not a dry day.
        expect(hydration.score(withGaps)).toBe(hydration.score(logged));
    });

    it('returns null when nothing at all was logged', () => {
        expect(hydration.score([{ logs: 0, consumedMl: 0, targetMl: 2300 }])).toBeNull();
        expect(_scoreHydration({ metrics: [] }).value).toBeNull();
    });

    it('does not bank credit for drinking far over the target', () => {
        expect(hydration.score([{ logs: 9, consumedMl: 9000, targetMl: 2000 }])).toBe(100);
    });
});

describe('the vitals pillar reads both heart rate and blood pressure', () => {
    const days = (bpRow) => Array.from({ length: 10 }, () => ({
        heart: { restingBpm: 62 },
        ...(bpRow ? { bloodPressure: bpRow } : {}),
    }));

    it('drops when blood pressure is raised despite a healthy resting rate', () => {
        const healthy = _scoreVitals({ metrics: days({ readings: 1, systolic: 115, diastolic: 74 }) });
        const raised = _scoreVitals({ metrics: days({ readings: 1, systolic: 148, diastolic: 94 }) });
        expect(raised.value).toBeLessThan(healthy.value);
        expect(raised.detail).toMatch(/blood pressure/i);
    });

    it('still scores on heart rate alone when no pressure has been logged', () => {
        const p = _scoreVitals({ metrics: days(null) });
        expect(p.value).not.toBeNull();
        expect(p.source).toBe('observed');
    });

    it('scores nothing when neither is present', () => {
        const p = _scoreVitals({ metrics: [{}, {}] });
        expect(p.value).toBeNull();
        expect(p.detail).toMatch(/blood-pressure|device/i);
    });
});
