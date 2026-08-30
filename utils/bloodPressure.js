/**
 * Blood-pressure classification.
 *
 * **A deterministic table, not a model**, for the same reason `medicationCatalogue.js` is one:
 * you cannot assert that a model will always catch a hypertensive crisis, and there is no way
 * to know afterwards which reading was the one it missed. The categories are the ACC/AHA 2017
 * thresholds, which is what a clinician reading this record would expect the words to mean.
 *
 * Four rules hold this file together, and each of them is a way the naive version is wrong.
 *
 * 1. **The worse of the two numbers decides the category.** 135/75 is Stage 1 on its systolic
 *    alone, and 118/92 is Stage 1 on its diastolic alone. Classifying on systolic and
 *    mentioning diastolic as a footnote — which is what a single-number gauge invites —
 *    files half of real hypertension as normal.
 * 2. **Crisis is not a colour.** Above 180/120 the response is "seek medical care now", not a
 *    red chip on a dashboard. `isCrisis` is separate from the category so a caller cannot
 *    render it as one more band on the same ladder.
 * 3. **One reading is not a diagnosis, and this file never claims otherwise.** Hypertension
 *    is diagnosed from repeated readings taken properly, so every label here describes *the
 *    reading*, and `SAFETY_NOTE` travels with it. The same discipline the medication checker
 *    applies when it refuses to say "safe".
 * 4. **Low is a category too.** A person whose pressure has dropped to 85/55 is not "normal
 *    or better", but a table with a floor of Normal has nowhere to put them, so they get the
 *    healthiest label on the screen.
 */

/**
 * The categories, worst first so the first match wins.
 *
 * `systolic` and `diastolic` are the *minimums* for the band. `match: 'either'` means a
 * reading qualifies on one number alone — that is the OR rule above, and it is what makes
 * 118/92 a Stage 1 reading rather than a normal one.
 */
const CATEGORIES = [
    {
        key: 'crisis',
        label: 'Hypertensive crisis',
        systolic: 181,
        diastolic: 121,
        match: 'either',
        summary: 'This reading is high enough to need medical attention now.',
        colour: '#DC2626',
    },
    {
        key: 'stage_2',
        label: 'Hypertension stage 2',
        systolic: 140,
        diastolic: 90,
        match: 'either',
        summary: 'This reading is in the stage 2 range. Worth speaking to a clinician about.',
        colour: '#F43F5E',
    },
    {
        key: 'stage_1',
        label: 'Hypertension stage 1',
        systolic: 130,
        diastolic: 80,
        match: 'either',
        summary: 'This reading is in the stage 1 range. Worth mentioning at your next appointment.',
        colour: '#FB923C',
    },
    {
        key: 'elevated',
        label: 'Elevated',
        systolic: 120,
        diastolic: 0,
        // Elevated is the one band that is systolic-only: 120-129 *with* a diastolic under 80.
        // A reading of 125/85 is stage 1 and is caught above before it reaches here.
        match: 'systolic',
        summary: 'Slightly above the normal range. Often responds to everyday changes.',
        colour: '#FBBF24',
    },
    {
        key: 'normal',
        label: 'Normal',
        systolic: 90,
        diastolic: 60,
        match: 'both',
        summary: 'This reading is in the normal range.',
        colour: '#10B981',
    },
    {
        key: 'low',
        label: 'Low',
        systolic: 0,
        diastolic: 0,
        match: 'both',
        summary: 'This reading is on the low side. Worth mentioning if you feel faint or dizzy.',
        colour: '#60A5FA',
    },
];

/**
 * What a single reading is called.
 *
 * Returns null for a reading that is not a pair of plausible numbers rather than guessing:
 * a transposed entry (80/120) or a typo is better refused than filed under a category that
 * will sit in someone's record.
 */
const classify = (systolic, diastolic) => {
    if (!isPlausible(systolic, diastolic)) return null;

    const hit = CATEGORIES.find((c) => {
        if (c.match === 'either') return systolic >= c.systolic || diastolic >= c.diastolic;
        if (c.match === 'systolic') return systolic >= c.systolic;
        return systolic >= c.systolic && diastolic >= c.diastolic;
    }) || CATEGORIES[CATEGORIES.length - 1];

    return {
        key: hit.key,
        label: hit.label,
        summary: hit.summary,
        colour: hit.colour,
        /** Kept separate from the category so it cannot be rendered as one more band. */
        isCrisis: hit.key === 'crisis',
        /**
         * Which number put them in this band. The design shows systolic and diastolic as two
         * figures, and someone whose systolic is fine needs to know it was the other one.
         */
        driver: driverFor(systolic, diastolic, hit),
    };
};

const driverFor = (systolic, diastolic, category) => {
    if (category.match !== 'either') return null;
    const bySystolic = systolic >= category.systolic;
    const byDiastolic = diastolic >= category.diastolic;
    if (bySystolic && byDiastolic) return 'both';
    return bySystolic ? 'systolic' : 'diastolic';
};

/**
 * Bounds on what will be accepted as a reading.
 *
 * Deliberately wide — these reject nonsense and typos, not unusual physiology. A real crisis
 * reading of 220/130 has to get through, because refusing it would silently drop exactly the
 * measurement this feature most needs to record.
 */
const LIMITS = { systolic: [60, 260], diastolic: [30, 200] };

const isPlausible = (systolic, diastolic) =>
    Number.isFinite(systolic) && Number.isFinite(diastolic)
    && systolic >= LIMITS.systolic[0] && systolic <= LIMITS.systolic[1]
    && diastolic >= LIMITS.diastolic[0] && diastolic <= LIMITS.diastolic[1]
    // Systolic is the pressure during the beat, so it is always the higher of the two. A
    // pair the other way round is a transposed entry, not a person.
    && systolic > diastolic;

/**
 * Travels with every classified reading, on every screen.
 *
 * Hypertension is diagnosed from repeated readings taken under the right conditions, not from
 * one measurement on a phone after someone climbed the stairs. Saying so is the difference
 * between a tracker and something that reads as a diagnosis.
 */
const SAFETY_NOTE =
    'One reading is not a diagnosis. Blood pressure moves through the day and with activity, '
    + 'caffeine and stress — a clinician reads a pattern of readings, not a single number.';

const CRISIS_NOTE =
    'If you have chest pain, breathlessness, weakness, difficulty speaking or vision changes, '
    + 'seek emergency care now rather than waiting to repeat the reading.';

/**
 * Summarise a window of readings.
 *
 * The **mean** is reported rather than the newest, because that is what a pattern looks like
 * and the newest reading is the one most likely to be a one-off. The **worst** category seen
 * is reported alongside it, because a fortnight averaging out to normal with one crisis
 * reading in it is not a normal fortnight, and an average is exactly the operation that would
 * hide it.
 */
const summarise = (readings = []) => {
    const valid = readings.filter((r) => isPlausible(r.systolic, r.diastolic));
    if (!valid.length) return null;

    const mean = (key) => Math.round(valid.reduce((s, r) => s + r[key], 0) / valid.length);
    const meanSystolic = mean('systolic');
    const meanDiastolic = mean('diastolic');

    const ranked = valid
        .map((r) => ({ ...r, category: classify(r.systolic, r.diastolic) }))
        .filter((r) => r.category);

    const order = CATEGORIES.map((c) => c.key);
    const worst = ranked.reduce((acc, r) =>
        (acc === null || order.indexOf(r.category.key) < order.indexOf(acc.category.key) ? r : acc), null);

    const pulses = valid.map((r) => r.pulse).filter(Number.isFinite);

    return {
        readings: valid.length,
        mean: {
            systolic: meanSystolic,
            diastolic: meanDiastolic,
            category: classify(meanSystolic, meanDiastolic),
        },
        worst: worst ? { systolic: worst.systolic, diastolic: worst.diastolic, category: worst.category, at: worst.measuredAt } : null,
        /** Any crisis-range reading in the window, however good the average looks. */
        hadCrisis: ranked.some((r) => r.category.isCrisis),
        meanPulse: pulses.length ? Math.round(pulses.reduce((a, b) => a + b, 0) / pulses.length) : null,
        note: SAFETY_NOTE,
    };
};

/**
 * A blood-pressure score, 0-100, for the `vitals` pillar.
 *
 * Scored off the *mean* reading and, like every other pillar, returns null rather than zero
 * when there is nothing to score. The curve is deliberately gentle between normal and stage 1
 * and steep after it: the difference between 118 and 122 systolic is noise, and the difference
 * between 150 and 180 is not.
 */
const score = (summary) => {
    if (!summary?.mean?.category) return null;

    const BY_CATEGORY = {
        normal: 100,
        low: 70,
        elevated: 78,
        stage_1: 55,
        stage_2: 28,
        crisis: 5,
    };
    let value = BY_CATEGORY[summary.mean.category.key] ?? null;

    // A crisis reading inside the window caps the score regardless of the average, for the
    // same reason `summarise` reports the worst alongside the mean.
    if (summary.hadCrisis) value = Math.min(value ?? 100, BY_CATEGORY.crisis);

    return value;
};

module.exports = {
    classify,
    summarise,
    score,
    isPlausible,
    CATEGORIES,
    LIMITS,
    SAFETY_NOTE,
    CRISIS_NOTE,
};
