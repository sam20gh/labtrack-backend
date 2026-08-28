/**
 * Turns a person's profile and their plan's diet advice into daily nutrition targets.
 *
 * Pure functions, no database and no model call — the numbers a tracker shows every day
 * must be reproducible and explainable. When a user asks "why 2,125?", `explain()` answers
 * from the same arithmetic that produced it.
 *
 * The macro split is the part that carries the plan. A calorie target is the same number
 * whatever the advice says; "shift towards a Mediterranean pattern and cut refined
 * carbohydrates" only becomes visible if it moves carbohydrate down and fat up. That is
 * what `applyGuidance` does, and it is why the tracker cannot just ask the user for a
 * number and stop there.
 */

/** Mifflin-St Jeor. The published constants; do not round them into the formula. */
const bmr = ({ weightKg, heightCm, age, sex }) => {
    const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
    // Mifflin-St Jeor is defined for male/female only. Anyone else, or unrecorded, gets the
    // midpoint of the two constants rather than being silently treated as male.
    if (sex === 'Male') return base + 5;
    if (sex === 'Female') return base - 161;
    return base - 78;
};

/**
 * Activity multipliers, keyed off whichever field the health assessment actually filled.
 *
 * `exerciseFrequency` is a labelled enum and `fitnessLevel` is the 1-5 scale from the
 * fitness-level screen, stored as a string. Both are optional, and a person who skipped
 * the assessment gets `sedentary` — under-estimating a target is recoverable, over-
 * estimating it quietly tells someone to eat more than they need.
 */
const ACTIVITY_FACTORS = {
    sedentary: 1.2,
    light: 1.375,
    moderate: 1.55,
    active: 1.725,
    very_active: 1.9,
};

const FREQUENCY_TO_ACTIVITY = {
    none: 'sedentary',
    light: 'light',
    moderate: 'moderate',
    active: 'active',
    'very active': 'very_active',
};

const FITNESS_LEVEL_TO_ACTIVITY = ['sedentary', 'sedentary', 'light', 'moderate', 'active', 'very_active'];

const activityKeyFor = (lifestyle = {}) => {
    const freq = String(lifestyle.exerciseFrequency || '').toLowerCase();
    if (FREQUENCY_TO_ACTIVITY[freq]) return FREQUENCY_TO_ACTIVITY[freq];

    const level = Number(lifestyle.fitnessLevel);
    if (Number.isInteger(level) && level >= 1 && level <= 5) return FITNESS_LEVEL_TO_ACTIVITY[level];

    return 'sedentary';
};

/**
 * Baseline macro split as a fraction of energy, before the plan's advice is applied.
 * Broadly the WHO/EFSA acceptable ranges, sitting mid-band.
 */
const BASELINE_SPLIT = { protein: 0.20, carbs: 0.50, fat: 0.30 };

/**
 * Keyword → macro shift, applied when the plan's diet guidance mentions it.
 *
 * Keyword matching, not a model call, on purpose: this runs on every target recalculation
 * and the shift it produces has to be stable. An LLM asked the same question twice would
 * move the target by a few grams each time, and a target that drifts on its own is a
 * target nobody trusts.
 *
 * Each shift is expressed as deltas that sum to zero, so the calorie total is unchanged —
 * the advice changes the *shape* of the day, not its size.
 */
const GUIDANCE_SHIFTS = [
    {
        key: 'mediterranean',
        kind: 'pattern',
        label: 'Mediterranean',
        match: /mediterranean/i,
        shift: { protein: 0.00, carbs: -0.05, fat: +0.05 },
        emphasise: ['olive oil', 'oily fish', 'legumes', 'vegetables', 'nuts', 'wholegrains'],
        reduce: ['red meat', 'processed meat', 'butter', 'refined grains'],
    },
    {
        key: 'refined_carbs',
        kind: 'reduce',
        label: 'Fewer refined carbs',
        match: /refined (carb|grain|sugar)|white (bread|rice|pasta)|added sugar|simple carb/i,
        shift: { protein: +0.02, carbs: -0.07, fat: +0.05 },
        emphasise: ['wholegrains', 'legumes', 'vegetables'],
        reduce: ['white bread', 'white rice', 'pastries', 'sugary drinks', 'confectionery'],
    },
    {
        key: 'low_carb',
        kind: 'pattern',
        label: 'Lower carbohydrate',
        match: /low[- ]carb|reduce.*carbohydrate|ketogenic/i,
        shift: { protein: +0.05, carbs: -0.15, fat: +0.10 },
        emphasise: ['non-starchy vegetables', 'eggs', 'fish', 'nuts'],
        reduce: ['bread', 'rice', 'pasta', 'potatoes', 'sugar'],
    },
    {
        key: 'higher_protein',
        kind: 'emphasise',
        label: 'More protein',
        match: /more protein|increase protein|protein intake|preserve (muscle|lean mass)/i,
        shift: { protein: +0.08, carbs: -0.05, fat: -0.03 },
        emphasise: ['fish', 'poultry', 'legumes', 'dairy', 'eggs'],
        reduce: [],
    },
    {
        key: 'lower_saturated_fat',
        kind: 'reduce',
        label: 'Less saturated fat',
        match: /saturated fat|cholesterol|ldl/i,
        shift: { protein: +0.03, carbs: +0.02, fat: -0.05 },
        emphasise: ['oily fish', 'olive oil', 'oats', 'legumes'],
        reduce: ['butter', 'fatty red meat', 'fried food', 'full-fat dairy'],
    },
    {
        key: 'lower_sodium',
        kind: 'reduce',
        label: 'Less salt',
        match: /sodium|salt intake|reduce salt|blood pressure/i,
        shift: { protein: 0, carbs: 0, fat: 0 },
        emphasise: ['fresh food', 'herbs and spices'],
        reduce: ['processed meat', 'ready meals', 'tinned soup', 'salty snacks'],
    },
    {
        key: 'more_fibre',
        kind: 'emphasise',
        label: 'More fibre',
        match: /fibre|fiber|wholegrain|whole grain/i,
        shift: { protein: 0, carbs: 0, fat: 0 },
        emphasise: ['wholegrains', 'legumes', 'fruit', 'vegetables'],
        reduce: [],
    },
    {
        key: 'less_alcohol',
        kind: 'reduce',
        label: 'Less alcohol',
        match: /alcohol/i,
        shift: { protein: 0, carbs: 0, fat: 0 },
        emphasise: [],
        reduce: ['beer', 'wine', 'spirits'],
    },
];

/**
 * Read the plan's diet advice and return the directives it implies.
 *
 * @param {{title?: string, description?: string, _id?: any}[]} dietItems
 *        PlanItems with `type: 'lifestyle'` and `condition: 'diet'`.
 */
const deriveGuidance = (dietItems = []) => {
    const guidance = [];
    const seen = new Set();

    for (const item of dietItems) {
        const text = `${item.title || ''} ${item.description || ''}`;
        const matched = GUIDANCE_SHIFTS.filter((g) => g.match.test(text));

        // Advice we have no shift for is still shown to the person and still goes into the
        // meal-analysis prompt. Dropping it because no regex matched would mean the tracker
        // silently ignores part of their plan.
        if (matched.length === 0) {
            guidance.push({
                planItemId: item._id,
                key: 'other',
                kind: 'other',
                label: item.title,
                directive: item.title,
                rationale: item.description,
                emphasise: [],
                reduce: [],
            });
            continue;
        }

        for (const g of matched) {
            if (seen.has(g.key)) continue;
            seen.add(g.key);
            guidance.push({
                planItemId: item._id,
                key: g.key,
                kind: g.kind,
                label: g.label,
                directive: item.title,
                rationale: item.description,
                emphasise: g.emphasise,
                reduce: g.reduce,
            });
        }
    }

    return guidance;
};

/** Sum the shifts of every matched directive, clamped to safe macro bounds. */
const applyGuidance = (guidance = []) => {
    const split = { ...BASELINE_SPLIT };

    for (const g of guidance) {
        const def = GUIDANCE_SHIFTS.find((s) => s.key === g.key);
        if (!def) continue;
        split.protein += def.shift.protein;
        split.carbs += def.shift.carbs;
        split.fat += def.shift.fat;
    }

    // Bounds first, then renormalise — two directives that both push carbohydrate down can
    // otherwise drive it negative, and a target of -4% carbs is not advice, it is a bug.
    const BOUNDS = { protein: [0.10, 0.35], carbs: [0.20, 0.60], fat: [0.20, 0.45] };
    for (const macro of Object.keys(split)) {
        const [lo, hi] = BOUNDS[macro];
        split[macro] = Math.min(hi, Math.max(lo, split[macro]));
    }

    const total = split.protein + split.carbs + split.fat;
    for (const macro of Object.keys(split)) split[macro] /= total;

    return split;
};

/** Energy per gram, for converting the split into grams. */
const KCAL_PER_GRAM = { protein: 4, carbs: 4, fat: 9 };

/**
 * Compute daily targets.
 *
 * @param {object} args
 * @param {object} args.user       the User document (needs dob, gender, height, weight)
 * @param {Array}  args.dietItems  PlanItems of type 'lifestyle' with condition 'diet'
 * @param {number} [args.calorieOverride]  a target the person set themselves; when present
 *                                         it replaces the computed figure but the macro
 *                                         split still follows the plan
 * @returns {{targets: object, guidance: Array, basis: object}|null}
 *          null when the profile lacks the height/weight/age the formula needs
 */
const computeTargets = ({ user, dietItems = [], calorieOverride } = {}) => {
    const guidance = deriveGuidance(dietItems);
    const split = applyGuidance(guidance);

    const weightKg = Number(user?.weight);
    const heightCm = Number(user?.height);
    const age = ageFromDob(user?.dob);

    let calories = Number(calorieOverride);
    let basis;

    if (Number.isFinite(calories) && calories > 0) {
        basis = { method: 'user', calories: Math.round(calories) };
    } else if (weightKg > 0 && heightCm > 0 && age !== null) {
        const restingRate = bmr({ weightKg, heightCm, age, sex: user.gender });
        const activityKey = activityKeyFor(user?.healthAssessment?.lifestyle);
        const factor = ACTIVITY_FACTORS[activityKey];
        calories = restingRate * factor;
        basis = {
            method: 'mifflin_st_jeor',
            bmr: Math.round(restingRate),
            activity: activityKey,
            activityFactor: factor,
            calories: Math.round(calories),
        };
    } else {
        // No override and not enough profile to compute one. Returning null rather than a
        // default lets the caller ask for the missing detail instead of showing a stranger's
        // calorie target as though it were theirs.
        return null;
    }

    calories = Math.round(calories / 25) * 25; // a target reads as a target, not a reading

    const grams = {};
    for (const macro of ['protein', 'carbs', 'fat']) {
        grams[macro] = Math.round((calories * split[macro]) / KCAL_PER_GRAM[macro]);
    }

    return {
        targets: {
            calories,
            protein: grams.protein,
            carbs: grams.carbs,
            fat: grams.fat,
            // 30ml/kg is the usual adult maintenance estimate; omitted when weight is not known
            water: weightKg > 0 ? Math.round((weightKg * 30) / 50) * 50 : null,
        },
        split,
        guidance,
        basis,
    };
};

/** Age in whole years, or null when `dob` is missing or unparseable. */
const ageFromDob = (dob) => {
    if (!dob) return null;
    const born = new Date(dob);
    if (Number.isNaN(born.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - born.getFullYear();
    const m = now.getMonth() - born.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < born.getDate())) age -= 1;
    return age >= 0 && age < 130 ? age : null;
};

/** One sentence explaining where the calorie target came from, for the setup screen. */
const explain = (basis) => {
    if (!basis) return 'Not enough profile detail to estimate a target yet.';
    if (basis.method === 'user') return `You set this target yourself (${basis.calories} kcal).`;
    return `Estimated from your height, weight and age (${basis.bmr} kcal at rest) `
        + `adjusted for ${basis.activity.replace('_', ' ')} activity (×${basis.activityFactor}).`;
};

module.exports = {
    computeTargets,
    deriveGuidance,
    applyGuidance,
    explain,
    ageFromDob,
    BASELINE_SPLIT,
    GUIDANCE_SHIFTS,
    ACTIVITY_FACTORS,
    KCAL_PER_GRAM,
};
