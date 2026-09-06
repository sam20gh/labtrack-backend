/**
 * The achievement catalogue.
 *
 * **A deterministic table, not a model** — the sixth in the series with
 * `medicationCatalogue.js`, `bloodPressure.js`, `nutritionSafety.js`, `reviewSla.js` and
 * `predictionForecast.js`, and the argument is the same one every time. A badge is a claim
 * that somebody did a specific thing a specific number of times. That has to be assertable
 * in a test and identical on two devices; a language model asked "does this person deserve
 * the sleep badge" answers fluently, differently on each call, and cannot be audited when
 * it awards one nobody earned or withholds one somebody did.
 *
 * ## Every achievement measures effort, never health
 *
 * This is the rule the whole feature turns on, and it is the easiest one to break by adding
 * a single "reasonable" entry.
 *
 * There is no badge for a blood pressure in range, a BMI under 25, a resting heart rate
 * under 60, or a LabTrack score above 80. Not because those are hard to compute — they are
 * the easiest things here to compute — but because a badge is a reward, and rewarding a
 * measurement rewards the people whose bodies already cooperate. A person managing
 * hypertension, or on a medication that moves their weight, would open this screen and find
 * a locked grid explaining that their illness has cost them points. That is the opposite of
 * what a health app should do with a scoreboard.
 *
 * So every threshold below counts an **action**: a session recorded, a meal logged, a dose
 * taken, a report uploaded, a day the app was used. Those are things anyone can do,
 * regardless of what their results say. The score already tells people how they are; this
 * tells them what they have done, and the two must not be confused.
 *
 * `__tests__/achievements.test.js` asserts that no metric in this file reads a clinical
 * value, and that is the assertion to keep working rather than the prose above.
 *
 * ## Levels
 *
 * Each entry carries ascending thresholds against one metric. Crossing the first unlocks
 * the badge; each later one raises its level, which is what the design's "LEVEL 1" chip and
 * "Level 2 — Next Milestone" bar read. Thresholds must ascend, and the first must be small
 * enough that somebody reaches it in their first week — a grid where nothing is reachable
 * is a grid nobody opens twice.
 *
 * ## Adding one
 *
 * An entry needs a `metric` that `achievementEngine.measure()` produces, a `shape`/`glyph`/
 * `tone` triple the app can draw (`components/achievements/badgeArt.ts` holds the sets), and
 * `points`. A metric nothing measures is a badge that can never unlock; a glyph the app does
 * not have renders as nothing. The tests enforce both.
 */

/**
 * What a badge is worth.
 *
 * Points exist for the leaderboard and for one number on the profile. They are scaled by how
 * much sustained effort an achievement represents, not by how healthy it is — see above.
 */
const POINTS = { small: 25, medium: 50, large: 100, epic: 250 };

/**
 * The badge artwork the app can actually draw.
 *
 * These names are the contract with `labtrack-frontend/components/achievements/badgeArt.ts`,
 * which holds the paths themselves — ported out of `Design/achievment.svg`. They live here
 * rather than only there because this file is what chooses them, and a `shape` the app has no
 * path for renders as **nothing**: no error, no fallback, an empty square in the grid. The
 * suite checks every entry below against these lists so that failure is a red test rather
 * than a blank badge somebody reports six weeks later.
 *
 * Adding artwork means regenerating `badgeArt.ts` from the export and adding the name here.
 * `BadgeMedal` also falls back rather than drawing nothing, so a server ahead of an app build
 * shows a plain badge instead of a hole.
 */
const DRAWABLE_SHAPES = ['hexagon', 'shield', 'rosette', 'octagon', 'star', 'crest', 'square'];
const DRAWABLE_GLYPHS = [
    'heart', 'lock', 'leaf', 'carb', 'pill', 'sleep',
    'vitals', 'cross', 'bag', 'steps', 'rank', 'water',
];

/**
 * Categories, their tone, and the tracker each one sends a person to.
 *
 * `route` is not decoration: a badge somebody is told about and cannot open the tracker for
 * is the dead end `PILLAR_ROUTE` exists to prevent on the score screen. Every category needs
 * one.
 */
const CATEGORIES = {
    activity: { label: 'Activity', tone: 'amber', route: '/activity' },
    sleep: { label: 'Sleep', tone: 'violet', route: '/(tabs)' },
    nutrition: { label: 'Nutrition', tone: 'green', route: '/nutrition' },
    hydration: { label: 'Hydration', tone: 'violet', route: '/metrics' },
    medication: { label: 'Medication', tone: 'violet', route: '/medications' },
    vitals: { label: 'Vitals', tone: 'rose', route: '/metrics' },
    insight: { label: 'Insight', tone: 'rose', route: '/score' },
    care: { label: 'Care', tone: 'green', route: '/myplans' },
    milestone: { label: 'Milestones', tone: 'amber', route: '/achievements' },
};

/**
 * The catalogue.
 *
 * `name` is the badge's own name and is allowed personality. `plainName` is the ≤34-character
 * label the grid draws under it — the same cap `medicationCatalogue.plainName` carries, and
 * for the same reason: a name that wraps to three lines turns a 3-column grid into a ragged
 * list.
 *
 * `how` is written as an instruction with a `{n}` placeholder for the level's threshold, so
 * "Log 1,000 steps" and "Log 100,000 steps" are one string rather than four. **No health
 * claims in it** — "Log your heart rate for 30 days" is a description of an action; "Keep
 * your heart rate healthy for 30 days" is a promise this app cannot keep.
 */
const ACHIEVEMENTS = [
    /* --- Activity ---------------------------------------------------- */
    {
        key: 'first_steps',
        name: 'First Steps',
        plainName: 'First Steps',
        category: 'activity',
        shape: 'octagon', glyph: 'steps',
        metric: 'stepsTotal',
        unit: 'steps',
        levels: [1000, 25000, 250000, 1000000],
        points: POINTS.small,
        how: 'Record {n} steps',
        blurb: 'Every step your phone or watch reports counts towards this one.',
    },
    {
        key: 'jogging_king',
        name: 'Jogging King',
        plainName: 'Jogging King',
        category: 'activity',
        shape: 'star', glyph: 'steps',
        metric: 'distanceKm',
        unit: 'km',
        levels: [5, 50, 250, 1000],
        points: POINTS.medium,
        how: 'Cover {n} km across your recorded sessions',
        blurb: 'Walks, runs and rides all add up here.',
    },
    {
        key: 'fitness_star',
        name: 'Fitness Star',
        plainName: 'Fitness Star',
        category: 'activity',
        shape: 'shield', glyph: 'bag',
        metric: 'activitySessions',
        unit: 'sessions',
        levels: [1, 10, 50, 200],
        points: POINTS.medium,
        how: 'Finish {n} activity sessions',
        blurb: 'A session is anything your watch or the activity tracker records.',
    },

    /* --- Sleep -------------------------------------------------------- */
    {
        key: 'dream_catcher',
        name: 'Dream Catcher',
        plainName: 'Dream Catcher',
        category: 'sleep',
        shape: 'square', glyph: 'sleep',
        metric: 'sleepNights',
        unit: 'nights',
        levels: [1, 14, 60, 200],
        points: POINTS.medium,
        how: 'Record {n} nights of sleep',
        blurb: 'Nights your watch reported, however long or short they were.',
    },
    {
        key: 'rested',
        name: 'Well Rested',
        plainName: 'Well Rested',
        category: 'sleep',
        shape: 'hexagon', glyph: 'sleep',
        metric: 'sleepStreak',
        unit: 'nights in a row',
        levels: [3, 7, 30, 100],
        points: POINTS.large,
        how: 'Record sleep {n} nights in a row',
        blurb: 'Your longest unbroken run of recorded nights.',
    },

    /* --- Nutrition ---------------------------------------------------- */
    {
        key: 'nutrition_pro',
        name: 'Nutrition Pro',
        plainName: 'Nutrition Pro',
        category: 'nutrition',
        shape: 'crest', glyph: 'leaf',
        metric: 'mealsLogged',
        unit: 'meals',
        levels: [1, 25, 200, 1000],
        points: POINTS.medium,
        how: 'Log {n} meals',
        blurb: 'Photographed, described or entered by hand — all three count.',
    },
    {
        key: 'food_photographer',
        name: 'Food Photographer',
        plainName: 'Food Photographer',
        category: 'nutrition',
        shape: 'rosette', glyph: 'carb',
        metric: 'mealPhotos',
        unit: 'photos',
        levels: [1, 20, 100, 500],
        points: POINTS.small,
        how: 'Photograph {n} meals',
        blurb: 'Photos land in your meal gallery as well as your day.',
    },
    {
        key: 'carb_fan',
        name: 'Carb Fan',
        plainName: 'Carb Fan',
        category: 'nutrition',
        shape: 'hexagon', glyph: 'carb',
        metric: 'nutritionStreak',
        unit: 'days in a row',
        levels: [3, 14, 60, 180],
        points: POINTS.large,
        how: 'Log a meal {n} days in a row',
        blurb: 'Your longest unbroken run of days with at least one meal logged.',
    },

    /* --- Hydration ---------------------------------------------------- */
    {
        key: 'hydro_homie',
        name: 'Hydro Homie',
        plainName: 'Hydro Homie',
        category: 'hydration',
        shape: 'square', glyph: 'water',
        metric: 'hydrationLogs',
        unit: 'drinks',
        levels: [5, 50, 300, 1500],
        points: POINTS.small,
        how: 'Log {n} drinks',
        blurb: 'Water, coffee and tea all count in full.',
    },
    {
        key: 'target_met',
        name: 'On Target',
        plainName: 'On Target',
        category: 'hydration',
        shape: 'star', glyph: 'water',
        metric: 'hydrationDaysMet',
        unit: 'days',
        levels: [1, 10, 60, 200],
        points: POINTS.medium,
        how: 'Reach your hydration target on {n} days',
        blurb: 'Your target comes from your body mass and what you have been doing.',
    },

    /* --- Medication --------------------------------------------------- */
    {
        key: 'med_explorer',
        name: 'Med Explorer',
        plainName: 'Med Explorer',
        category: 'medication',
        shape: 'rosette', glyph: 'pill',
        metric: 'medicationsTracked',
        unit: 'medicines',
        levels: [1, 3, 6, 12],
        points: POINTS.small,
        how: 'Add {n} medicines to your list',
        blurb: 'Adding a medicine is what lets the interaction check see it.',
    },
    {
        key: 'never_missed',
        name: 'Never Missed',
        plainName: 'Never Missed',
        category: 'medication',
        shape: 'shield', glyph: 'pill',
        metric: 'dosesTaken',
        unit: 'doses',
        levels: [10, 100, 500, 2000],
        points: POINTS.large,
        how: 'Record {n} doses as taken',
        blurb: 'Only doses that have come due are counted.',
    },

    /* --- Vitals ------------------------------------------------------- */
    {
        key: 'heart_champ',
        name: 'Heart Champ',
        plainName: 'Heart Champ',
        category: 'vitals',
        shape: 'square', glyph: 'heart',
        metric: 'heartDays',
        unit: 'days',
        levels: [1, 30, 100, 365],
        points: POINTS.medium,
        how: 'Record your heart rate on {n} days',
        blurb: 'One reading on a day is enough for that day to count.',
    },
    {
        key: 'pressure_watch',
        name: 'Pressure Watch',
        plainName: 'Pressure Watch',
        category: 'vitals',
        shape: 'octagon', glyph: 'vitals',
        metric: 'bloodPressureLogs',
        unit: 'readings',
        levels: [1, 10, 50, 200],
        points: POINTS.medium,
        how: 'Log {n} blood pressure readings',
        blurb: 'A single reading is never a diagnosis — a run of them is worth a lot to your clinician.',
    },
    {
        key: 'weight_master',
        name: 'Weight Master',
        plainName: 'Weight Master',
        category: 'vitals',
        shape: 'crest', glyph: 'vitals',
        metric: 'weightLogs',
        unit: 'weigh-ins',
        levels: [1, 10, 50, 200],
        points: POINTS.small,
        how: 'Record {n} weigh-ins',
        blurb: 'What you weigh is yours; how often you check is the achievement.',
    },

    /* --- Insight ------------------------------------------------------ */
    {
        key: 'lab_rat',
        name: 'Lab Rat',
        plainName: 'Lab Rat',
        category: 'insight',
        shape: 'hexagon', glyph: 'cross',
        metric: 'reportsUploaded',
        unit: 'reports',
        levels: [1, 3, 8, 20],
        points: POINTS.large,
        how: 'Upload {n} test reports',
        blurb: 'Each report you upload gives your analysis more to work with.',
    },
    {
        key: 'asklepios',
        name: 'Asklepios',
        plainName: 'Asklepios',
        category: 'insight',
        shape: 'star', glyph: 'cross',
        metric: 'markersTracked',
        unit: 'markers',
        levels: [5, 25, 60, 120],
        points: POINTS.large,
        how: 'Have {n} different markers on record',
        blurb: 'Named after the physician, because reading your own results is the point.',
    },
    {
        key: 'future_self',
        name: 'Future Self',
        plainName: 'Future Self',
        category: 'insight',
        shape: 'rosette', glyph: 'vitals',
        metric: 'predictionsRun',
        unit: 'forecasts',
        levels: [1, 5, 20, 60],
        points: POINTS.medium,
        how: 'Run {n} health forecasts',
        blurb: 'Each forecast is checked against what actually happened.',
    },

    /* --- Care --------------------------------------------------------- */
    {
        key: 'plan_keeper',
        name: 'Plan Keeper',
        plainName: 'Plan Keeper',
        category: 'care',
        shape: 'shield', glyph: 'rank',
        metric: 'planItemsDone',
        unit: 'plan items',
        levels: [1, 5, 15, 40],
        points: POINTS.large,
        how: 'Complete {n} items on your health plan',
        blurb: 'Screenings and consultations your plan asked for, marked done.',
    },
    {
        key: 'call_doctor',
        name: 'Call Doctor',
        plainName: 'Call Doctor',
        category: 'care',
        shape: 'square', glyph: 'cross',
        metric: 'appointmentsBooked',
        unit: 'appointments',
        levels: [1, 3, 10, 25],
        points: POINTS.medium,
        how: 'Request {n} consultations',
        blurb: 'Booking time with a professional is a health action like any other.',
    },
    {
        key: 'curious_mind',
        name: 'Curious Mind',
        plainName: 'Curious Mind',
        category: 'care',
        shape: 'octagon', glyph: 'rank',
        metric: 'assistantMessages',
        unit: 'questions',
        levels: [1, 20, 100, 400],
        points: POINTS.small,
        how: 'Ask LabTrack AI {n} questions',
        blurb: 'It answers with your own records in front of it.',
    },

    /* --- Milestones --------------------------------------------------- */
    {
        key: 'streak_holder',
        name: 'Streak Holder',
        plainName: 'Streak Holder',
        category: 'milestone',
        shape: 'star', glyph: 'rank',
        metric: 'activeDayStreak',
        unit: 'days in a row',
        levels: [3, 14, 60, 365],
        points: POINTS.epic,
        how: 'Record something {n} days in a row',
        blurb: 'Anything counts — a meal, a glass of water, a dose, a walk.',
    },
    {
        key: 'all_rounder',
        name: 'All Rounder',
        plainName: 'All Rounder',
        category: 'milestone',
        shape: 'rosette', glyph: 'rank',
        metric: 'trackersUsed',
        unit: 'trackers',
        levels: [2, 4, 6, 8],
        points: POINTS.large,
        how: 'Use {n} different trackers',
        blurb: 'Breadth is what makes your analysis able to connect one thing to another.',
    },
    {
        key: 'long_hauler',
        name: 'Long Hauler',
        plainName: 'Long Hauler',
        category: 'milestone',
        shape: 'crest', glyph: 'heart',
        metric: 'daysSinceJoining',
        unit: 'days',
        levels: [7, 30, 180, 365],
        points: POINTS.medium,
        how: 'Be with LabTrack for {n} days',
        blurb: 'The one badge that only needs you to still be here.',
    },
];

/** Fast lookup, built once. */
const BY_KEY = new Map(ACHIEVEMENTS.map((a) => [a.key, a]));

/** Every metric name the catalogue reads. `achievementEngine` must produce all of them. */
const REQUIRED_METRICS = [...new Set(ACHIEVEMENTS.map((a) => a.metric))];

/** The most points anybody could hold, used to render "4,841 of 8,200". */
const MAX_POINTS = ACHIEVEMENTS.reduce((sum, a) => sum + a.points * a.levels.length, 0);

/**
 * Grade one achievement against a measured value.
 *
 * `level` is how many thresholds have been crossed — 0 means locked. `next` is the threshold
 * still to reach, or null at the top. `progress` is the fraction of the way to `next`,
 * measured **from the previous threshold**, not from zero: someone at 260 of a 250→1,000 step
 * is 1% of the way through that level, and drawing them at 26% would show a bar that barely
 * moves for the next 740 units and then jumps.
 */
const grade = (achievement, value) => {
    const measured = Number.isFinite(value) ? value : 0;
    const levels = achievement.levels;

    let level = 0;
    while (level < levels.length && measured >= levels[level]) level += 1;

    const floor = level === 0 ? 0 : levels[level - 1];
    const next = level < levels.length ? levels[level] : null;
    const progress = next === null
        ? 1
        : Math.max(0, Math.min(1, (measured - floor) / (next - floor)));

    return {
        key: achievement.key,
        level,
        maxLevel: levels.length,
        unlocked: level > 0,
        value: measured,
        /** The threshold this level was won at — what the detail screen prints beside "Earned". */
        threshold: level > 0 ? levels[level - 1] : null,
        next,
        progress,
        points: achievement.points * level,
        /** The instruction for what is still to be done, or for level 1 while locked. */
        how: instruction(achievement, next ?? levels[levels.length - 1]),
    };
};

/** `how` with its `{n}` filled in and thousands separated. */
const instruction = (achievement, n) =>
    achievement.how.replace('{n}', Number(n).toLocaleString('en-GB'));

/** The public shape of one catalogue entry — what the clients render. */
const describe = (achievement) => ({
    key: achievement.key,
    name: achievement.name,
    plainName: achievement.plainName,
    category: achievement.category,
    categoryLabel: CATEGORIES[achievement.category].label,
    route: CATEGORIES[achievement.category].route,
    shape: achievement.shape,
    glyph: achievement.glyph,
    tone: CATEGORIES[achievement.category].tone,
    unit: achievement.unit,
    levels: achievement.levels,
    points: achievement.points,
    blurb: achievement.blurb,
});

module.exports = {
    ACHIEVEMENTS,
    DRAWABLE_SHAPES,
    DRAWABLE_GLYPHS,
    CATEGORIES,
    POINTS,
    MAX_POINTS,
    REQUIRED_METRICS,
    BY_KEY,
    grade,
    describe,
    instruction,
};
