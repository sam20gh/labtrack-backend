/**
 * Nutrition targets.
 *
 * The point of these tests is the link between the health plan and the tracker. A calorie
 * number is easy; what has to hold is that dietary advice from an interpretation actually
 * moves the macro targets, that conflicting advice cannot drive a macro out of a safe band,
 * and that advice nobody wrote a rule for is still carried through to the person rather
 * than silently dropped.
 */
const {
    computeTargets, deriveGuidance, applyGuidance, explain, ageFromDob,
    BASELINE_SPLIT, KCAL_PER_GRAM,
} = require('../utils/nutritionTargets');

/** A 40-year-old, 180cm, 80kg, exercising 2-3 times a week. */
const USER = {
    dob: new Date(new Date().getFullYear() - 40, 0, 15).toISOString(),
    gender: 'Male',
    height: 180,
    weight: 80,
    healthAssessment: { lifestyle: { exerciseFrequency: 'Moderate' } },
};

const dietItem = (title, description = 'Because of your results.') => ({
    _id: 'item1', title, description,
});

describe('deriveGuidance', () => {
    it('recognises a Mediterranean pattern and a refined-carbohydrate instruction separately', () => {
        const guidance = deriveGuidance([
            dietItem('Shift towards a Mediterranean-style eating pattern'),
            dietItem('Cut back on refined carbohydrates'),
        ]);

        expect(guidance.map((g) => g.key).sort()).toEqual(['mediterranean', 'refined_carbs']);
        expect(guidance.find((g) => g.key === 'mediterranean').emphasise).toContain('olive oil');
        expect(guidance.find((g) => g.key === 'refined_carbs').reduce).toContain('white bread');
    });

    it('keeps the interpretation\'s own wording as the directive', () => {
        const wording = 'Shift towards a Mediterranean-style eating pattern';
        const [g] = deriveGuidance([dietItem(wording)]);
        // The person is shown this, and it goes into the analyser prompt. Paraphrasing
        // clinical advice on the way through is how a tracker coaches something the plan
        // never said.
        expect(g.directive).toBe(wording);
    });

    it('carries advice no rule matches rather than dropping it', () => {
        const guidance = deriveGuidance([dietItem('Eat your largest meal before 3pm')]);
        expect(guidance).toHaveLength(1);
        expect(guidance[0].key).toBe('other');
        expect(guidance[0].directive).toBe('Eat your largest meal before 3pm');
    });

    it('does not emit the same directive twice when two plan items say the same thing', () => {
        const guidance = deriveGuidance([
            dietItem('Move to a Mediterranean diet'),
            dietItem('A Mediterranean pattern would suit you'),
        ]);
        expect(guidance.filter((g) => g.key === 'mediterranean')).toHaveLength(1);
    });

    it('returns nothing for an empty plan', () => {
        expect(deriveGuidance([])).toEqual([]);
        expect(deriveGuidance()).toEqual([]);
    });
});

describe('applyGuidance', () => {
    it('leaves the baseline split alone when there is no guidance', () => {
        expect(applyGuidance([])).toEqual(BASELINE_SPLIT);
    });

    it('moves carbohydrate down and fat up for the Mediterranean + refined-carbs pair', () => {
        const guidance = deriveGuidance([
            dietItem('Shift towards a Mediterranean-style eating pattern'),
            dietItem('Cut refined carbohydrates'),
        ]);
        const split = applyGuidance(guidance);

        // This is the whole feature: without it, the advice changes nothing the user sees.
        expect(split.carbs).toBeLessThan(BASELINE_SPLIT.carbs);
        expect(split.fat).toBeGreaterThan(BASELINE_SPLIT.fat);
    });

    it('always returns a split summing to 1', () => {
        const cases = [
            [],
            deriveGuidance([dietItem('Low-carb eating')]),
            deriveGuidance([dietItem('More protein to preserve lean mass')]),
            deriveGuidance([
                dietItem('Low-carb eating'),
                dietItem('Cut refined carbohydrates'),
                dietItem('Mediterranean pattern'),
            ]),
        ];
        for (const guidance of cases) {
            const split = applyGuidance(guidance);
            expect(split.protein + split.carbs + split.fat).toBeCloseTo(1, 10);
        }
    });

    it('cannot be driven out of a safe band by piling on advice', () => {
        // Three directives all pushing carbohydrate down. Unclamped this goes below zero,
        // and a negative gram target is not advice, it is a bug on someone's dashboard.
        const guidance = deriveGuidance([
            dietItem('Low-carb eating'),
            dietItem('Cut refined carbohydrates'),
            dietItem('Mediterranean pattern'),
            dietItem('Increase protein intake'),
        ]);
        const split = applyGuidance(guidance);

        expect(split.carbs).toBeGreaterThan(0.15);
        expect(split.protein).toBeLessThan(0.40);
        expect(split.fat).toBeLessThan(0.50);
    });
});

describe('computeTargets', () => {
    it('computes from Mifflin-St Jeor and an activity factor', () => {
        const result = computeTargets({ user: USER });

        // 10(80) + 6.25(180) - 5(40) + 5 = 1730 BMR, x1.55 moderate = 2681.5 -> 2675 (25s)
        expect(result.basis.method).toBe('mifflin_st_jeor');
        expect(result.basis.bmr).toBe(1730);
        expect(result.basis.activityFactor).toBe(1.55);
        expect(result.targets.calories).toBe(2675);
    });

    it('uses the 1-5 fitness level when exerciseFrequency was never answered', () => {
        const result = computeTargets({
            user: { ...USER, healthAssessment: { lifestyle: { fitnessLevel: '5' } } },
        });
        expect(result.basis.activity).toBe('very_active');
    });

    it('falls back to sedentary rather than guessing when neither was answered', () => {
        const result = computeTargets({ user: { ...USER, healthAssessment: {} } });
        expect(result.basis.activity).toBe('sedentary');
    });

    it('macro grams reconstruct the calorie target', () => {
        const { targets } = computeTargets({ user: USER });
        const fromMacros = targets.protein * KCAL_PER_GRAM.protein
            + targets.carbs * KCAL_PER_GRAM.carbs
            + targets.fat * KCAL_PER_GRAM.fat;
        // Rounding each macro to whole grams costs a few kcal; more than 1% apart would
        // mean the split and the total disagree on the same screen.
        expect(Math.abs(fromMacros - targets.calories) / targets.calories).toBeLessThan(0.01);
    });

    it('honours a calorie target the person set, but still applies the plan to the split', () => {
        const dietItems = [dietItem('Cut refined carbohydrates')];
        const withPlan = computeTargets({ user: USER, dietItems, calorieOverride: 2000 });
        const without = computeTargets({ user: USER, calorieOverride: 2000 });

        expect(withPlan.targets.calories).toBe(2000);
        expect(withPlan.basis.method).toBe('user');
        // Same calories, different shape — the advice is doing something.
        expect(withPlan.targets.carbs).toBeLessThan(without.targets.carbs);
        expect(withPlan.targets.fat).toBeGreaterThan(without.targets.fat);
    });

    it('returns null rather than inventing a target when the profile is too thin', () => {
        // Showing a stranger's calorie figure as though it were theirs is worse than
        // asking for a height.
        expect(computeTargets({ user: { gender: 'Female' } })).toBeNull();
        expect(computeTargets({ user: { ...USER, weight: null } })).toBeNull();
        expect(computeTargets({ user: { ...USER, dob: '' } })).toBeNull();
    });

    it('still computes from an override alone when the profile is too thin', () => {
        const result = computeTargets({ user: { gender: 'Other' }, calorieOverride: 1800 });
        expect(result.targets.calories).toBe(1800);
        expect(result.targets.water).toBeNull();
    });

    it('does not treat an unrecorded sex as male', () => {
        const male = computeTargets({ user: { ...USER, gender: 'Male' } });
        const unrecorded = computeTargets({ user: { ...USER, gender: null } });
        expect(unrecorded.basis.bmr).toBeLessThan(male.basis.bmr);
    });
});

describe('ageFromDob', () => {
    it('handles a birthday that has not happened yet this year', () => {
        const now = new Date();
        const tomorrow = new Date(now.getFullYear() - 30, now.getMonth(), now.getDate() + 1);
        expect(ageFromDob(tomorrow.toISOString())).toBe(29);
    });

    it('returns null for missing or unparseable dates', () => {
        expect(ageFromDob('')).toBeNull();
        expect(ageFromDob('not a date')).toBeNull();
        expect(ageFromDob(undefined)).toBeNull();
    });
});

describe('explain', () => {
    it('names the arithmetic behind a computed target', () => {
        const { basis } = computeTargets({ user: USER });
        expect(explain(basis)).toContain('1730');
        expect(explain(basis)).toContain('moderate');
    });

    it('says so when the person set the number themselves', () => {
        const { basis } = computeTargets({ user: USER, calorieOverride: 2200 });
        expect(explain(basis)).toContain('yourself');
    });

    it('does not throw when there is no basis', () => {
        expect(explain(null)).toMatch(/not enough/i);
    });
});
