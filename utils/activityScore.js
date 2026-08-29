/**
 * The activity score, and the per-session points the design shows as "+3".
 *
 * Server-side and deterministic. The same sessions must produce the same number on every
 * call and on every device — a score computed on the client means two phones disagree about
 * a person's own number, and this one also feeds the `lifestyle` pillar of the health score
 * in `lib/healthScore.ts`.
 *
 * It measures **goal attainment against the person's own plan**, not raw volume. Someone
 * whose plan says to build up gradually and who hits their 75 minutes should score the same
 * as an athlete hitting 210 — otherwise the number rewards being fit rather than doing what
 * was asked, which is the opposite of what this feature is for.
 */

/**
 * Points for one session.
 *
 * Duration-driven with a small bonus for effort the person recorded. Capped at 5, because
 * the design shows small integers and because a three-hour session should not be worth a
 * fortnight of consistency — frequency is the behaviour worth reinforcing.
 */
const scoreSession = ({ durationSec = 0, effort } = {}) => {
    const minutes = durationSec / 60;
    if (minutes < 5) return 0;

    let points = 1;
    if (minutes >= 15) points = 2;
    if (minutes >= 30) points = 3;
    if (minutes >= 60) points = 4;

    // Only ever a bonus, and only when the person rated it themselves. Inferring effort
    // from pace would mean the score moved when nobody did anything differently.
    if (Number.isFinite(effort) && effort >= 4) points += 1;

    return Math.min(5, points);
};

/**
 * The weekly score, 0–100.
 *
 * Three components, all measured against the person's targets. Components without a target
 * are dropped and the rest renormalised, so someone with no distance goal still scores out
 * of 100 rather than being capped.
 */
const WEIGHTS = { sessions: 0.4, minutes: 0.4, consistency: 0.2 };

/**
 * Consistency is the share of days in the window carrying any activity.
 *
 * Deliberately separate from volume. Five sessions in one day and five spread across the
 * week meet the same session target and are not the same behaviour, and the guidance this
 * feature exists to serve is almost always written as "most days of the week".
 */
const consistencyScore = (series = []) => {
    if (!series.length) return null;
    const active = series.filter((p) => (p.sessions || 0) > 0).length;
    // Seven active days out of seven is full marks; the ratio is taken against the
    // guideline of most days rather than every day, so a rest day is not a penalty.
    return Math.min(100, Math.round((active / series.length) / 0.7 * 100));
};

const ratioScore = (done, target) => {
    if (!Number.isFinite(target) || target <= 0) return null;
    if (!Number.isFinite(done) || done <= 0) return 0;
    return Math.min(100, Math.round((done / target) * 100));
};

/**
 * Score a window against the plan.
 *
 * @param {object} args
 * @param {Array}  args.series   the per-day rollups the summary already built
 * @param {object} [args.targets] `ActivityPlan.targets`; without it there is no score
 * @param {number} [args.days]   length of the window, for scaling a weekly target
 * @returns {{value: number|null, components: object, progress: object|null}}
 */
const scoreWindow = ({ series = [], targets, days } = {}) => {
    const window = Number.isFinite(days) ? days : series.length;

    const done = {
        sessions: series.reduce((s, p) => s + (p.sessions || 0), 0),
        minutes: series.reduce((s, p) => s + (p.exerciseMin || 0), 0),
        distanceKm: series.reduce((s, p) => s + (p.distanceM || 0), 0) / 1000,
        calories: series.reduce((s, p) => s + (p.activeKcal || 0), 0),
    };

    if (!targets) {
        // No plan yet. Returning null rather than zero is the same call `MealLog`'s
        // `unassessed` alignment makes: nobody has failed at a target nobody set.
        return { value: null, components: {}, progress: null, done };
    }

    // Targets are weekly. A 30-day window is measured against four and a bit weeks of them.
    const scale = window / 7;
    const scaled = {
        sessions: targets.sessions * scale,
        minutes: targets.minutes * scale,
        distanceKm: Number.isFinite(targets.distanceKm) ? targets.distanceKm * scale : null,
        calories: Number.isFinite(targets.calories) ? targets.calories * scale : null,
    };

    const components = {
        sessions: ratioScore(done.sessions, scaled.sessions),
        minutes: ratioScore(done.minutes, scaled.minutes),
        consistency: consistencyScore(series),
    };

    const parts = Object.entries(components)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => ({ value: v, weight: WEIGHTS[k] }));

    if (!parts.length) return { value: null, components, progress: null, done };

    const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
    const value = Math.round(parts.reduce((s, p) => s + p.value * p.weight, 0) / totalWeight);

    const progress = {
        sessions: { done: done.sessions, target: Math.round(scaled.sessions) },
        minutes: { done: done.minutes, target: Math.round(scaled.minutes) },
        distanceKm: scaled.distanceKm === null ? null : {
            done: Math.round(done.distanceKm * 10) / 10,
            target: Math.round(scaled.distanceKm * 10) / 10,
        },
        calories: scaled.calories === null ? null : {
            done: Math.round(done.calories),
            target: Math.round(scaled.calories),
        },
    };

    return { value: Math.max(0, Math.min(100, value)), components, progress, done };
};

/** The band a score reads in. No clinical words: this is engagement, not a diagnosis. */
const BANDS = [
    { key: 'ahead', label: 'Ahead of plan', min: 100, max: Infinity },
    { key: 'on_track', label: 'On track', min: 80, max: 99 },
    { key: 'building', label: 'Building', min: 45, max: 79 },
    { key: 'behind', label: 'Behind plan', min: 0, max: 44 },
];

const bandFor = (score) => {
    if (!Number.isFinite(score)) return null;
    return BANDS.find((b) => score >= b.min && score <= b.max) || null;
};

module.exports = { scoreSession, scoreWindow, bandFor, BANDS, WEIGHTS, _consistencyScore: consistencyScore };
