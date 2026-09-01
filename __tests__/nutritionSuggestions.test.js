/**
 * The two deterministic halves of the suggestion feature.
 *
 * `nutritionSafety` is the one that matters. A prompt asks a model not to suggest peanuts to
 * someone with a peanut allergy and it will usually comply; "usually" is not a property you
 * can assert, so the screen exists in code and these tests are what make it a guarantee —
 * the same role `medicationInteractions.test.js` plays for the rule table there.
 *
 * `nutritionInsight` is tested for one rule, restated in several shapes: a day with nothing
 * logged is absent, never zero.
 */
const { screen, tokensForAllergy, PREFERENCE_EXCLUSIONS } = require('../utils/nutritionSafety');
const { summariseWindow, goalProgress, weekdayProfile } = require('../utils/nutritionInsight');
const { signatureFor } = require('../utils/nutritionRecommender');

const suggestion = (name, ingredients = [], extra = {}) => ({
    name, ingredients, why: 'Because.', tags: [], calories: 400, protein: 20, carbs: 40, fat: 12, ...extra,
});

describe('the allergen screen', () => {
    it('drops a suggestion whose ingredients contain a declared allergen', () => {
        const { kept, dropped } = screen(
            [
                suggestion('Satay chicken skewers', ['chicken thigh', 'peanut butter', 'lime']),
                suggestion('Grilled chicken salad', ['chicken breast', 'romaine', 'olive oil']),
            ],
            { allergies: ['Peanut allergy'] }
        );

        expect(kept.map((s) => s.name)).toEqual(['Grilled chicken salad']);
        expect(dropped[0].reason).toMatch(/peanut/i);
    });

    it('catches an allergen named only in the dish title', () => {
        const { kept } = screen(
            [suggestion('Almond and apricot porridge', ['oats', 'apricot', 'milk'])],
            { allergies: ['tree nuts'] }
        );
        expect(kept).toHaveLength(0);
    });

    it('drops rather than flags — nothing unsafe is ever returned with a warning', () => {
        const { kept, dropped } = screen(
            [suggestion('Prawn linguine', ['prawns', 'linguine', 'garlic'])],
            { allergies: ['shellfish'] }
        );
        expect(kept).toEqual([]);
        expect(dropped).toHaveLength(1);
    });

    it('reads the everyday wording the health assessment actually collects', () => {
        // Free text, because that is what the questionnaire stores
        for (const written of ['lactose intolerant', 'Dairy', 'milk allergy', 'cheese']) {
            const { kept } = screen(
                [suggestion('Four cheese gnocchi', ['gnocchi', 'cheddar', 'cream'])],
                { allergies: [written] }
            );
            expect(kept).toHaveLength(0);
        }
    });

    it('falls back to the person\'s own words for an allergen it has no group for', () => {
        expect(tokensForAllergy('kiwi allergy')).toContain('kiwi');
        const { kept } = screen(
            [suggestion('Kiwi and mint fruit salad', ['kiwi', 'mint', 'lime'])],
            { allergies: ['kiwi allergy'] }
        );
        expect(kept).toHaveLength(0);
    });

    it('does not fire on a token buried inside an unrelated word', () => {
        // "ham" inside "chamomile" is the failure a bare includes() would produce
        const { kept } = screen(
            [suggestion('Chamomile poached pears', ['pears', 'chamomile', 'honey'])],
            { dietaryPreferences: ['halal'] }
        );
        expect(kept).toHaveLength(1);
    });

    it('can only remove — it never rewrites or reorders what survives', () => {
        const input = [
            suggestion('A', ['rice']),
            suggestion('B', ['pork belly']),
            suggestion('C', ['lentils']),
        ];
        const { kept } = screen(input, { dietaryPreferences: ['vegetarian'] });
        expect(kept).toEqual([input[0], input[2]]);
    });

    it('returns everything when the person declared nothing', () => {
        const input = [suggestion('Steak frites', ['sirloin', 'chips'])];
        expect(screen(input, {}).kept).toEqual(input);
        expect(screen(input, null).kept).toEqual(input);
    });
});

describe('dietary preferences', () => {
    it.each([
        ['vegan', 'Halloumi salad', ['halloumi', 'tomato']],
        ['vegetarian', 'Chicken pho', ['chicken', 'rice noodles']],
        ['pescatarian', 'Beef stir fry', ['beef', 'peppers']],
        ['gluten_free', 'Sourdough toast with avocado', ['bread', 'avocado']],
        ['dairy_free', 'Mushroom risotto', ['arborio rice', 'parmesan']],
        ['halal', 'Bacon and egg muffin', ['bacon', 'egg', 'muffin']],
    ])('%s excludes %s', (preference, name, ingredients) => {
        const { kept } = screen([suggestion(name, ingredients)], { dietaryPreferences: [preference] });
        expect(kept).toHaveLength(0);
    });

    it('lets a pescatarian keep fish', () => {
        const { kept } = screen(
            [suggestion('Baked cod with greens', ['cod', 'spinach', 'olive oil'])],
            { dietaryPreferences: ['pescatarian'] }
        );
        expect(kept).toHaveLength(1);
    });

    it('has an exclusion list for every preference the setup screen offers', () => {
        // The frontend's DIETARY_PREFERENCES. A preference with no rule silently permits
        // everything, which is worse than not offering it.
        for (const id of ['vegetarian', 'vegan', 'pescatarian', 'halal', 'kosher',
            'gluten_free', 'dairy_free', 'low_fodmap']) {
            expect(PREFERENCE_EXCLUSIONS[id]?.length).toBeGreaterThan(0);
        }
    });
});

describe('the cache signature', () => {
    const base = {
        day: '2026-09-01',
        mealType: 'dinner',
        remaining: 900,
        plan: { guidance: [{ key: 'fibre', directive: 'Eat more fibre' }], targets: { calories: 2000 } },
    };

    it('holds still across a small change in what is left', () => {
        // 900 and 960 kcal do not deserve two different sets of six meals
        expect(signatureFor({ ...base, remaining: 960 })).toBe(signatureFor(base));
    });

    it('changes when the plan\'s advice changes', () => {
        const moved = { ...base, plan: { ...base.plan, guidance: [{ key: 'sodium', directive: 'Cut salt' }] } };
        expect(signatureFor(moved)).not.toBe(signatureFor(base));
    });

    it('changes when an allergy is added, so a stale set cannot outlive a new constraint', () => {
        const declared = { ...base, plan: { ...base.plan, allergies: ['peanut'] } };
        expect(signatureFor(declared)).not.toBe(signatureFor(base));
    });

    it('changes for a different meal slot and a different day', () => {
        expect(signatureFor({ ...base, mealType: 'breakfast' })).not.toBe(signatureFor(base));
        expect(signatureFor({ ...base, day: '2026-09-02' })).not.toBe(signatureFor(base));
    });
});

describe('insight arithmetic', () => {
    const meal = (day, calories, extra = {}) => ({
        day, calories, protein: 30, carbs: 50, fat: 15, fibre: 8, ...extra,
    });

    it('averages over days that were logged, not over the calendar window', () => {
        // Two days out of thirty, 2,000 kcal each. The average day is 2,000 — not 133.
        const out = summariseWindow([meal('2026-08-01', 2000), meal('2026-08-15', 2000)], null, 30);
        expect(out.loggedDays).toBe(2);
        expect(out.averages.calories).toBe(2000);
    });

    it('returns null averages rather than zeros when nothing was logged', () => {
        const out = summariseWindow([], { calories: 2000 }, 30);
        expect(out.averages).toBeNull();
        expect(out.averageCalories).toBeNull();
        expect(out.days).toEqual([]);
    });

    it('leaves a weekday nothing was ever logged on as a gap', () => {
        // 2026-08-03 is a Monday
        const profile = weekdayProfile([{ day: '2026-08-03', totals: { calories: 1800, protein: 0, fat: 0, carbs: 0 } }]);
        expect(profile[0]).toMatchObject({ label: 'Mon', days: 1, calories: 1800 });
        expect(profile[1]).toMatchObject({ label: 'Tue', days: 0, calories: null });
    });

    it('scores goal progress against the average day, never the running total', () => {
        // Four days at 30g protein against a 100g daily target is 30% of a day, not 120%
        const averages = { protein: 30, carbs: 50, fat: 15 };
        const [protein] = goalProgress(averages, { protein: 100 });
        expect(protein.ratio).toBeCloseTo(0.3);
        expect(protein.reached).toBe(false);
    });

    it('reports a macro with no target as null rather than reached', () => {
        const [protein] = goalProgress({ protein: 120 }, {});
        expect(protein.target).toBeNull();
        expect(protein.ratio).toBeNull();
        expect(protein.reached).toBeNull();
    });

    it('counts a macro within a tenth of its target as reached', () => {
        expect(goalProgress({ protein: 92 }, { protein: 100 })[0].reached).toBe(true);
        expect(goalProgress({ protein: 85 }, { protein: 100 })[0].reached).toBe(false);
    });
});
