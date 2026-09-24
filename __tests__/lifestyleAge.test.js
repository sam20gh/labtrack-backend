/**
 * Predyqt Age — the lifestyle half.
 *
 * The lab half is a published equation, so its tests are mostly about refusing. This half is
 * an aggregation we assembled, so its tests are mostly about **calibration**: that a typical
 * person comes out at their own age, that no single contributor can run away with the answer,
 * and that four measurements of one person's fitness are not counted as four facts.
 *
 * The first draft failed the first of those — every anchor was a guideline rather than a
 * population median, so a person on the median for every measure came out six years older
 * than they are. That is the assertion at the top of this file, and it is the one that would
 * catch the same mistake being reintroduced one contributor at a time.
 */
const life = require('../utils/lifestyleAge');
const bio = require('../utils/biologicalAge');

const ctxOf = (age = 45, sex = 'male') => ({ age, sex });

/** A person sitting exactly on the table's own medians, built from the table itself. */
const medianInputs = (age = 45, sex = 'male', days = 160) => Object.fromEntries(
    life.CONTRIBUTORS.map((c) => [c.key, { value: c.median(ctxOf(age, sex)), days }]),
);

const run = (inputs, age = 45, sex = 'male') =>
    life.lifestyleAge({ chronologicalAge: age, sex, inputs });

const FIT = {
    vo2max: { value: 52, days: 90 }, resting_hr: { value: 52, days: 150 },
    steps: { value: 11000, days: 160 }, vigorous_minutes: { value: 120, days: 160 },
    strength_minutes: { value: 90, days: 160 }, sleep_duration: { value: 7.6, days: 140 },
    sleep_consistency: { value: 0.6, days: 140 }, bmi: { value: 23, days: 20 },
    blood_pressure: { value: { systolic: 112, diastolic: 70 }, days: 20 },
};

const SEDENTARY = {
    vo2max: { value: 26, days: 90 }, resting_hr: { value: 78, days: 150 },
    steps: { value: 3200, days: 160 }, vigorous_minutes: { value: 0, days: 160 },
    strength_minutes: { value: 0, days: 160 }, sleep_duration: { value: 5.6, days: 140 },
    sleep_consistency: { value: 2.4, days: 140 }, bmi: { value: 32, days: 20 },
    blood_pressure: { value: { systolic: 146, diastolic: 94 }, days: 20 },
};

describe('calibration', () => {
    /**
     * The assertion this file exists for.
     *
     * A biological age is a comparison against peers. If the median person does not come out
     * at their own age, the number is a distance-from-ideal score wearing years — which is
     * what the Predyqt score already is, on an honest 0-100 scale.
     */
    it('puts a person on the population median at exactly their chronological age', () => {
        for (const age of [25, 40, 55, 70]) {
            for (const sex of ['male', 'female']) {
                const r = run(medianInputs(age, sex), age, sex);
                expect(r.ok).toBe(true);
                expect(r.delta).toBe(0);
                expect(r.value).toBe(age);
            }
        }
    });

    it('scores every contributor at zero for a median person, not just the total', () => {
        // A total of zero could be two errors cancelling. This is the stronger claim.
        for (const c of run(medianInputs()).contributions) {
            expect(c.years).toBe(0);
        }
    });

    it('separates a fit person from a sedentary one by a believable margin', () => {
        const fit = run(FIT);
        const sedentary = run(SEDENTARY);
        expect(fit.delta).toBeLessThan(-5);
        expect(sedentary.delta).toBeGreaterThan(10);
        // And neither is pinned against the bound, which would mean the model had stopped
        // discriminating exactly where it matters most.
        expect(fit.clamped).toBe(false);
        expect(sedentary.clamped).toBe(false);
    });

    it('carries a target that is a guideline, not the median', () => {
        // The median is what the maths is centred on; the target is what a lever points at.
        // "Reach 8,000 steps" is advice. "Reach the median 5,500" is not.
        const steps = life.CONTRIBUTOR_BY_KEY.steps;
        expect(steps.target(ctxOf())).toBeGreaterThan(steps.median(ctxOf()));
        const strength = life.CONTRIBUTOR_BY_KEY.strength_minutes;
        expect(strength.median(ctxOf())).toBe(0);
        expect(strength.target(ctxOf())).toBe(60);
    });
});

describe('the conversion to years', () => {
    it('uses PhenoAge’s own Gompertz slope, so a year means one thing in both halves', () => {
        // Blending two numbers measured on different scales would be an average of nothing.
        // The constant is duplicated rather than imported to avoid a mutual require; this is
        // what keeps the duplication honest.
        const labSlopeUsed = bio.phenoAge(46, {
            albumin: 45, creatinine: 80, fasting_glucose: 5, crp: 1,
            lymphocytes_pct: 32, mcv: 90, rdw: 13, alp: 70, wbc: 6,
        }) - bio.phenoAge(45, {
            albumin: 45, creatinine: 80, fasting_glucose: 5, crp: 1,
            lymphocytes_pct: 32, mcv: 90, rdw: 13, alp: 70, wbc: 6,
        });
        // One chronological year moves PhenoAge by roughly one year, which is only true
        // because AGE_COEFFICIENT and AGE_SLOPE are near-matched. The point of the test is
        // that lifestyleAge divides by the same figure.
        expect(life.GOMPERTZ_SLOPE).toBeCloseTo(0.090165, 6);
        expect(labSlopeUsed).toBeGreaterThan(0.5);
    });
});

describe('bounds', () => {
    it('caps a single contributor so one broken reading cannot dominate', () => {
        expect(life._clampTerm(9)).toBe(life.TERM_CAP);
        expect(life._clampTerm(-9)).toBe(-life.TERM_CAP);
    });

    it('does not let the cap bind on an ordinary bad reading', () => {
        /**
         * The calibration failure the cap itself can cause. A BMI of 32 is a perfectly
         * ordinary measurement; if it hits the cap then a BMI of 32, 38 and 45 all produce
         * the same answer and the cap has stopped being a guard and started being the model.
         */
        const bmi = life.CONTRIBUTOR_BY_KEY.bmi;
        const term = bmi.lnHR(32) - bmi.lnHR(bmi.median());
        expect(Math.abs(term)).toBeLessThan(life.TERM_CAP);
        expect(run({ ...SEDENTARY, bmi: { value: 32, days: 20 } })
            .contributions.find((c) => c.key === 'bmi').capped).toBe(false);
    });

    it('drops an implausible reading rather than clamping it', () => {
        // Clamping a resting heart rate of 200 from a watch on a desk still ages somebody by
        // years. A broken sensor is not a finding.
        const r = run({ ...FIT, resting_hr: { value: 205, days: 150 } });
        expect(r.contributions.some((c) => c.key === 'resting_hr')).toBe(false);
        expect(r.skipped.find((s) => s.key === 'resting_hr').reason).toBe('implausible');
    });

    it('bounds the whole answer and says when it did', () => {
        const extreme = run({
            ...SEDENTARY,
            vo2max: { value: 12, days: 90 }, bmi: { value: 55, days: 20 },
            sleep_duration: { value: 2.5, days: 140 }, sleep_consistency: { value: 7, days: 140 },
            blood_pressure: { value: { systolic: 195, diastolic: 128 }, days: 20 },
        });
        expect(extreme.clamped).toBe(true);
        expect(extreme.delta).toBe(life.MAX_DEVIATION_YEARS);
    });
});

describe('overlap correction', () => {
    it('counts the first measurement of a domain in full and halves each one after', () => {
        const { adjusted } = life._correctOverlap([
            { domain: 'fitness', lnHR: 0.4 }, { domain: 'fitness', lnHR: 0.2 },
            { domain: 'fitness', lnHR: 0.1 }, { domain: 'fitness', lnHR: 0.05 },
        ]);
        expect(adjusted.map((t) => t.weight)).toEqual([1, 0.5, 0.25, 0.125]);
    });

    it('ranks by magnitude, so the dominant signal survives whichever way it points', () => {
        const { adjusted } = life._correctOverlap([
            { domain: 'fitness', lnHR: 0.1 }, { domain: 'fitness', lnHR: -0.5 },
        ]);
        expect(adjusted[0].lnHR).toBe(-0.5);
        expect(adjusted[0].weight).toBe(1);
    });

    it('never discounts a domain’s only contributor', () => {
        const { adjusted } = life._correctOverlap([
            { domain: 'sleep', lnHR: 0.3 }, { domain: 'body', lnHR: 0.2 },
        ]);
        expect(adjusted.every((t) => t.weight === 1)).toBe(true);
    });

    it('makes five views of one person’s fitness worth less than five facts', () => {
        // The whole reason the correction exists, and the one Whoop names explicitly.
        const uncorrected = [0.3, 0.28, 0.25, 0.22, 0.2];
        const { total } = life._correctOverlap(
            uncorrected.map((lnHR) => ({ domain: 'fitness', lnHR })),
        );
        expect(total).toBeLessThan(uncorrected.reduce((a, b) => a + b, 0) / 2);
    });
});

describe('coverage', () => {
    it('refuses below the minimum number of domains rather than answering vaguely', () => {
        const r = run({ sleep_duration: { value: 6.2, days: 40 } });
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('insufficient_coverage');
        expect(r.have).toBe(1);
        expect(r.need).toBe(life.MIN_DOMAINS);
    });

    it('refuses with nothing at all, and offers a way in', () => {
        const r = run({});
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/connect a watch/i);
    });

    it('answers once a second domain arrives', () => {
        const r = run({
            sleep_duration: { value: 6.2, days: 40 },
            bmi: { value: 29, days: 5 },
        });
        expect(r.ok).toBe(true);
        expect(r.coverage.domains.sort()).toEqual(['body', 'sleep']);
    });

    it('drops a contributor measured over too few days rather than scoring two readings', () => {
        const r = run({ ...FIT, vo2max: { value: 52, days: 2 } });
        const skip = r.skipped.find((s) => s.key === 'vo2max');
        expect(skip.reason).toBe('too_few_days');
        expect(skip.need).toBe(life.MIN_DAYS.fitness);
    });

    it('treats a missing contributor as absent, never as zero', () => {
        // A watch that was not worn is not a resting heart rate of zero.
        const withoutSteps = { ...FIT, steps: { value: null, days: 0 } };
        expect(run(withoutSteps).contributions.some((c) => c.key === 'steps')).toBe(false);
        expect(run(withoutSteps).skipped.find((s) => s.key === 'steps').reason).toBe('no_data');
    });

    it('names a route out for everything it skipped', () => {
        // A screen has to be able to send somebody somewhere. A skipped contributor with no
        // route is the dead end PILLAR_ROUTE exists to prevent on the score screen.
        for (const s of run({ bmi: { value: 24, days: 3 } }).skipped) {
            expect(s.route).toMatch(/^\//);
        }
    });
});

describe('individual contributors', () => {
    it('stages blood pressure with bloodPressure.classify, not with its own thresholds', () => {
        const bp = life.CONTRIBUTOR_BY_KEY.blood_pressure;
        // A reading this file ages somebody for must be exactly a reading the log screen
        // already called stage 1 — the delegation predictionMetrics makes for the same reason.
        expect(bp.lnHR({ systolic: 135, diastolic: 85 })).toBe(bp.ladder.stage_1);
        expect(bp.lnHR({ systolic: 112, diastolic: 70 })).toBe(bp.ladder.normal);
        // 118/92 is stage 2 on its diastolic alone. If this ever reads as normal, somebody
        // has reimplemented the thresholds here.
        expect(bp.lnHR({ systolic: 118, diastolic: 92 })).toBe(bp.ladder.stage_2);
    });

    it('skips a blood pressure the table cannot stage instead of scoring it normal', () => {
        const r = run({ ...FIT, blood_pressure: { value: { systolic: 0, diastolic: 0 }, days: 20 } });
        expect(r.contributions.some((c) => c.key === 'blood_pressure')).toBe(false);
        expect(r.skipped.find((s) => s.key === 'blood_pressure').reason).toBe('not_computable');
    });

    it('treats sleep as asymmetric, because more is not better', () => {
        const sleep = life.CONTRIBUTOR_BY_KEY.sleep_duration;
        // Long sleep carries the larger hazard in the meta-analysis, so an hour over must
        // cost more than an hour under. A symmetric curve gets this backwards.
        expect(sleep.lnHR(9)).toBeGreaterThan(sleep.lnHR(6));
        expect(sleep.lnHR(7.5)).toBe(0);
        expect(sleep.lnHR(7)).toBe(0);
        expect(sleep.lnHR(8)).toBe(0);
    });

    it('floors the credit for a very low resting heart rate', () => {
        const rhr = life.CONTRIBUTOR_BY_KEY.resting_hr;
        // An athlete's 42 is not four times the benefit of a 55, and an unfloored linear term
        // would hand large credit to a bradycardia that can be a finding.
        expect(rhr.lnHR(38)).toBe(rhr.lnHR(30));
        expect(rhr.lnHR(55)).toBeLessThan(0);
    });

    it('plateaus steps where the meta-analysis does, and lower for older adults', () => {
        const steps = life.CONTRIBUTOR_BY_KEY.steps;
        expect(steps.lnHR(14000, ctxOf(45))).toBe(steps.lnHR(10000, ctxOf(45)));
        expect(steps.lnHR(12000, ctxOf(70))).toBe(steps.lnHR(8000, ctxOf(70)));
    });

    it('declines to take a view on weight or sleep direction', () => {
        // Colouring a BMI forecast green would make the app take a view on somebody's body —
        // the call `weight` already makes in the prediction registry.
        expect(life.CONTRIBUTOR_BY_KEY.bmi.betterWhen).toBeNull();
        expect(life.CONTRIBUTOR_BY_KEY.sleep_duration.betterWhen).toBeNull();
    });

    it('does not score HRV at all', () => {
        // Weak as an independent mortality predictor, not comparable between devices, and
        // absent from Whoop's nine. It is context on a screen, not arithmetic.
        expect(life.CONTRIBUTORS.map((c) => c.key)).not.toContain('hrv');
    });

    it('gives every contributor a median, a target, a route and a modifiable flag', () => {
        for (const c of life.CONTRIBUTORS) {
            expect(typeof c.median(ctxOf())).not.toBe('undefined');
            expect(typeof c.target(ctxOf())).not.toBe('undefined');
            expect(c.route).toMatch(/^\//);
            expect(['behaviour', 'clinical', 'fixed']).toContain(c.modifiable);
        }
    });

    it('moves the fitness reference with age and sex', () => {
        expect(life.vo2Reference(25, 'male')).toBeGreaterThan(life.vo2Reference(65, 'male'));
        expect(life.vo2Reference(45, 'male')).toBeGreaterThan(life.vo2Reference(45, 'female'));
        // Anything unrecognised falls to the female curve rather than throwing; the test is
        // that it produces a usable number, not that the fallback is ideal.
        expect(life.vo2Reference(45, null)).toBeGreaterThan(0);
    });
});

describe('the mortality score never appears here either', () => {
    it('is absent from a result and from a refusal', () => {
        for (const r of [run(FIT), run({}), run(SEDENTARY)]) {
            expect(JSON.stringify(r).toLowerCase()).not.toMatch(/mortalit|death|survival/);
        }
    });
});
