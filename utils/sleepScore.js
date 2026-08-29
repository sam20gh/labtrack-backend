/**
 * The sleep score, and the bands it is read through.
 *
 * Pure arithmetic, no model call. A number a person sees every morning has to be
 * reproducible and explainable: when someone asks why last night scored 61, `explain()`
 * answers from the same arithmetic that produced it.
 *
 * **On the bottom band's name.** The design labels the 0–39 band "Insomniac". That does not
 * ship. Insomnia is a clinical diagnosis with criteria this number does not test — it is
 * hours slept, weighted by how much of the time in bed was actually asleep. Labelling
 * someone with it inside an app that also produces clinician-reviewed interpretations puts a
 * diagnosis on a dashboard, which is exactly the line the symptom checker's finding score
 * is careful not to cross. The band is "Needs attention".
 */

/** Fallback goal when the person has not set one. Mid-point of the usual adult range. */
const DEFAULT_GOAL_MINUTES = 8 * 60;

/**
 * How the score is weighted.
 *
 * Duration dominates because it is the thing the person can act on and the thing every
 * source reports. Efficiency and stage balance refine it, and both are skipped rather than
 * penalised when the source did not report them — a watch that gives only a total should
 * not score worse than one that gives stages.
 */
const WEIGHTS = { duration: 0.6, efficiency: 0.25, stages: 0.15 };

/**
 * Duration component.
 *
 * Full marks from 95% of goal upward, tapering to zero at half the goal. Sleeping well past
 * the goal is not scored as better than meeting it — more sleep is not linearly healthier,
 * and a score that rewards oversleeping would coach the wrong behaviour — but it is not
 * penalised either, because a long night after a short one is recovery, not a failure.
 */
const durationScore = (asleepMin, goalMinutes) => {
    if (!Number.isFinite(asleepMin) || asleepMin <= 0) return 0;
    const ratio = asleepMin / goalMinutes;
    if (ratio >= 0.95) return 100;
    if (ratio <= 0.5) return 0;
    return Math.round(((ratio - 0.5) / 0.45) * 100);
};

/** Efficiency component. 85% asleep-in-bed is the usual floor for undisturbed sleep. */
const efficiencyScore = (efficiency) => {
    if (!Number.isFinite(efficiency)) return null;
    if (efficiency >= 90) return 100;
    if (efficiency <= 60) return 0;
    return Math.round(((efficiency - 60) / 30) * 100);
};

/**
 * Stage-balance component.
 *
 * Scores how close deep and REM sit to the broad adult proportions — roughly 13–23% deep
 * and 20–25% REM. Deliberately generous: stage detection from a wrist accelerometer is an
 * estimate, and scoring it tightly would present that estimate as more precise than it is.
 */
const stageScore = (stages, asleepMin) => {
    if (!Number.isFinite(asleepMin) || asleepMin <= 0) return null;
    const deep = stages?.deepMin;
    const rem = stages?.remMin;
    if (!Number.isFinite(deep) || !Number.isFinite(rem)) return null;

    const band = (value, lo, hi) => {
        const share = value / asleepMin;
        if (share >= lo && share <= hi) return 100;
        const distance = share < lo ? lo - share : share - hi;
        return Math.max(0, Math.round(100 - (distance / lo) * 100));
    };

    return Math.round((band(deep, 0.13, 0.23) + band(rem, 0.20, 0.25)) / 2);
};

/**
 * Score one night, 0–100.
 *
 * Components that could not be computed are dropped and the remaining weights renormalised,
 * so a source reporting only a total still produces a score out of 100 rather than one
 * capped at 60.
 */
const scoreNight = ({ asleepMin, efficiency, stages, goalMinutes } = {}) => {
    const goal = Number.isFinite(goalMinutes) && goalMinutes > 0 ? goalMinutes : DEFAULT_GOAL_MINUTES;

    const parts = [
        { value: durationScore(asleepMin, goal), weight: WEIGHTS.duration },
        { value: efficiencyScore(efficiency), weight: WEIGHTS.efficiency },
        { value: stageScore(stages, asleepMin), weight: WEIGHTS.stages },
    ].filter((p) => p.value !== null);

    if (!parts.length) return null;

    const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
    const score = parts.reduce((s, p) => s + p.value * p.weight, 0) / totalWeight;
    return Math.max(0, Math.min(100, Math.round(score)));
};

/**
 * The band a score falls in.
 *
 * `key` is what code branches on; `label` is what a person reads. See the note at the top
 * of this file on why the bottom band is not called what the design calls it.
 */
const BANDS = [
    { key: 'good', label: 'Good', min: 70, max: 100 },
    { key: 'suboptimal', label: 'Suboptimal', min: 40, max: 69 },
    { key: 'attention', label: 'Needs attention', min: 0, max: 39 },
];

const bandFor = (score) => {
    if (!Number.isFinite(score)) return null;
    return BANDS.find((b) => score >= b.min && score <= b.max) || null;
};

/** Why the score is what it is, for the explainer sheet. Reads from the same arithmetic. */
const explain = ({ asleepMin, efficiency, stages, goalMinutes } = {}) => {
    const goal = Number.isFinite(goalMinutes) && goalMinutes > 0 ? goalMinutes : DEFAULT_GOAL_MINUTES;
    const lines = [];

    const hours = (m) => `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m`;

    if (Number.isFinite(asleepMin)) {
        lines.push(`You slept ${hours(asleepMin)} against a goal of ${hours(goal)}.`);
    }
    if (Number.isFinite(efficiency)) {
        lines.push(`You were asleep for ${efficiency}% of the time you were in bed.`);
    }
    if (Number.isFinite(stages?.deepMin) && Number.isFinite(stages?.remMin)) {
        lines.push(`Deep sleep ${hours(stages.deepMin)}, REM ${hours(stages.remMin)}.`);
    } else {
        lines.push('Your source did not report sleep stages for this night, so the score is based on duration.');
    }

    return lines.join(' ');
};

module.exports = {
    scoreNight,
    bandFor,
    explain,
    BANDS,
    DEFAULT_GOAL_MINUTES,
    WEIGHTS,
    _durationScore: durationScore,
    _efficiencyScore: efficiencyScore,
    _stageScore: stageScore,
};
