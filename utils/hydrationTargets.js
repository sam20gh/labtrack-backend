/**
 * The daily water target, and what a day's intake is called.
 *
 * Derived, not typed. A fixed "8 glasses" is wrong for most people in both directions, and a
 * target the person sets themselves is a target nobody calibrates. This computes one from
 * body mass and what the activity tracker actually recorded, the same way
 * `nutritionTargets.js` derives calories rather than asking.
 *
 * **The number is a guide, not a prescription.** Fluid needs move with climate, illness,
 * pregnancy and several medications, and a few conditions make a high intake actively unsafe.
 * `CAUTION_NOTE` says so, `capFor` refuses to draw a target above a sane ceiling, and nothing
 * here is allowed to tell someone to drink more when their record says otherwise.
 */

/**
 * Millilitres per kilogram of body mass.
 *
 * 33 ml/kg is the common adult guide and lands a 70 kg person around 2.3 l, which is where
 * the usual "about two litres" advice comes from. It is applied to body mass rather than a
 * flat figure because a 50 kg and a 110 kg person do not need the same amount, and giving
 * them the same target makes it meaningless for both.
 */
const ML_PER_KG = 33;

/** When no weight is on record. Not a guess about the person — a stated default. */
const DEFAULT_TARGET_ML = 2000;

/**
 * Extra fluid per minute of recorded exercise.
 *
 * Roughly half a litre an hour of activity, which is the conservative end of the usual sweat
 * replacement range. Deliberately conservative: this is added automatically from the tracker,
 * and a target that jumps by a litre because someone logged a long walk is one they stop
 * believing.
 */
const ML_PER_EXERCISE_MIN = 8;

/**
 * Ceilings, and why there is one.
 *
 * Water intoxication is real and the people most likely to chase a number on a screen are
 * exactly the people who should not. The cap is well above any normal requirement, so it
 * never binds for an ordinary person — it exists so that no combination of a heavy body mass
 * and a long training day can make this app display a genuinely dangerous target.
 */
const CAPS = { daily: 4000 };
const FLOORS = { daily: 1200 };

const clampTarget = (ml) => Math.max(FLOORS.daily, Math.min(CAPS.daily, Math.round(ml / 50) * 50));

/**
 * Compute today's target.
 *
 * @param {object} args
 * @param {number} [args.weightKg]      the measured weight, where one exists
 * @param {number} [args.exerciseMin]   minutes the activity tracker recorded today
 * @returns {{ ml: number, basis: string[], note: string }}
 */
const computeTarget = ({ weightKg, exerciseMin = 0 } = {}) => {
    const basis = [];

    let ml;
    if (Number.isFinite(weightKg) && weightKg > 0) {
        ml = weightKg * ML_PER_KG;
        basis.push(`${Math.round(ml)} ml from your body weight`);
    } else {
        ml = DEFAULT_TARGET_ML;
        basis.push('a general adult guide, because we have no weight on record');
    }

    if (Number.isFinite(exerciseMin) && exerciseMin > 0) {
        const extra = exerciseMin * ML_PER_EXERCISE_MIN;
        ml += extra;
        basis.push(`${Math.round(extra)} ml for ${Math.round(exerciseMin)} minutes of activity`);
    }

    const capped = clampTarget(ml);
    return {
        ml: capped,
        basis,
        note: capped === CAPS.daily ? CAUTION_NOTE : GUIDE_NOTE,
    };
};

const GUIDE_NOTE =
    'A guide, not a prescription. What you need moves with the weather, illness and some '
    + 'medicines — thirst and pale urine are better signals than a number.';

const CAUTION_NOTE =
    'This is the highest daily target this app will suggest. Drinking well beyond your thirst '
    + 'is not safer, and some heart and kidney conditions require a fluid limit — follow your '
    + 'clinician over this number if the two disagree.';

/**
 * The design's five-level hydration ladder.
 *
 * Ordered best first. The labels describe **the day's intake against the day's target**, not
 * the person's physiology: this app cannot measure hydration, only what someone logged, and a
 * label like "Dehydrated" has to be read as "you logged well under your target" or it is a
 * clinical claim made from a tally.
 */
const LEVELS = [
    { key: 'optimal', label: 'Optimal', min: 90, blurb: 'You met your target today.' },
    { key: 'slightly_low', label: 'Slightly low', min: 70, blurb: 'A little under your target.' },
    { key: 'low', label: 'Low', min: 45, blurb: 'Well under your target today.' },
    { key: 'very_low', label: 'Very low', min: 20, blurb: 'Most of your target is still to go.' },
    { key: 'minimal', label: 'Barely any', min: 0, blurb: 'Almost nothing logged today.' },
];

/**
 * Where a day sits on the ladder.
 *
 * Returns null — not `minimal` — when nothing at all was logged. A day with no entries is a
 * day the person did not use the tracker, and calling that "barely any" tells someone they
 * were dangerously dehydrated on a day they simply did not open the app. Same distinction
 * `alignment: 'unassessed'` and `medicationSchedule.adherence` both make.
 */
const levelFor = (consumedMl, targetMl, { logs = 0 } = {}) => {
    if (!logs || !Number.isFinite(targetMl) || targetMl <= 0) return null;
    const pct = (consumedMl / targetMl) * 100;
    const hit = LEVELS.find((l) => pct >= l.min) || LEVELS[LEVELS.length - 1];
    return { ...hit, percent: Math.round(pct) };
};

/**
 * The hydration score for the window, 0-100.
 *
 * Attainment against the person's own target, averaged over the days they logged, and capped
 * at 100 so drinking four litres on a two-litre target does not bank credit against a dry
 * week. Days with no logs are excluded rather than scored zero — see `levelFor`.
 */
const score = (days = []) => {
    const logged = days.filter((d) => d.logs > 0 && Number.isFinite(d.targetMl) && d.targetMl > 0);
    if (!logged.length) return null;

    const total = logged.reduce((s, d) => s + Math.min(100, (d.consumedMl / d.targetMl) * 100), 0);
    return Math.round(total / logged.length);
};

/** Container presets from the design's Log Water screen. */
const CONTAINERS = [
    { key: 'small', label: 'Small', ml: 200 },
    { key: 'medium', label: 'Medium', ml: 350 },
    { key: 'large', label: 'Large', ml: 700 },
];

/**
 * Drink types, and what each one counts for.
 *
 * Coffee and tea count in full. The idea that caffeine is dehydrating enough to subtract is a
 * persistent myth — at normal intakes the fluid more than covers the mild diuresis — and
 * discounting them would make the tracker disagree with every current guideline. `other`
 * exists so a person is not forced to file a soft drink as water.
 */
const DRINK_TYPES = [
    { key: 'water', label: 'Water', factor: 1 },
    { key: 'coffee', label: 'Coffee', factor: 1 },
    { key: 'tea', label: 'Tea', factor: 1 },
    { key: 'other', label: 'Other', factor: 1 },
];

const LOG_LIMITS = { ml: [10, 3000] };

module.exports = {
    computeTarget,
    levelFor,
    score,
    LEVELS,
    CONTAINERS,
    DRINK_TYPES,
    CAPS,
    FLOORS,
    LOG_LIMITS,
    ML_PER_KG,
    ML_PER_EXERCISE_MIN,
    DEFAULT_TARGET_ML,
    GUIDE_NOTE,
    CAUTION_NOTE,
};
