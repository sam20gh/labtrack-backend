/**
 * Active energy for a GPS-tracked session — an estimate, and labelled as one on screen.
 *
 * Priced per moving interval from `trackMetrics.computeTrack().segments`, so a run with a
 * fast middle kilometre costs what that kilometre cost rather than the average of the run.
 * `labtrack-frontend/lib/run/energy.ts` is the port and the shared fixtures pin both.
 *
 * On foot: the ACSM metabolic equations (ml O2/kg/min, speed S in m/min, grade G):
 *   walking  VO2 = 0.1·S + 1.8·S·G + 3.5
 *   running  VO2 = 0.2·S + 0.9·S·G + 3.5
 * with the 3.5 resting term **removed**, because `activeKcal` means active, and 5 kcal per
 * litre of O2. Grade is clamped to [0, 0.15]: the equations are not valid downhill, and a
 * grade from two noisy altitudes over a few metres is mostly noise past that.
 *
 * On a bike: Compendium METs by speed, minus the resting MET for the same reason.
 *
 * Two rules:
 *
 * 1. **No body mass, no number.** `null`, never a default 70 kg. A calorie figure that is
 *    really a guess about somebody's body is the thing this app refuses to print elsewhere;
 *    the screen asks for a weight instead.
 * 2. **An untracked type gets `null`**, not a running estimate. There is no equation here
 *    for a kitesurfing session, and pretending otherwise is inventing data.
 */

const FOOT_TYPES = new Set(['walking', 'jogging', 'hiking']);
const BIKE_TYPES = new Set(['biking']);

/** Above this a person on foot is running, below it walking (≈ 8 km/h). */
const RUN_THRESHOLD_MS = 2.2;
const MAX_GRADE = 0.15;
const KCAL_PER_LITRE_O2 = 5;

/** [upper bound km/h, MET]. Compendium of Physical Activities, general cycling. */
const BIKE_METS = [
    [16, 4],
    [19, 6.8],
    [22.5, 8],
    [25.5, 10],
    [30.5, 12],
    [Infinity, 15.8],
];

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

const gradeOf = (seg) => {
    if (!finite(seg.climbM) || !(seg.distanceM > 0)) return 0;
    return Math.max(0, Math.min(MAX_GRADE, seg.climbM / seg.distanceM));
};

/** Net (active) kcal for one moving interval on foot. */
const footKcal = (seg, kg) => {
    const S = seg.speed * 60; // m/min
    const G = gradeOf(seg);
    const net = seg.speed >= RUN_THRESHOLD_MS
        ? 0.2 * S + 0.9 * S * G
        : 0.1 * S + 1.8 * S * G;
    return (net * kg / 1000) * KCAL_PER_LITRE_O2 * (seg.durationSec / 60);
};

const bikeKcal = (seg, kg) => {
    const kmh = seg.speed * 3.6;
    const met = BIKE_METS.find(([upper]) => kmh < upper)[1];
    return (met - 1) * kg * (seg.durationSec / 3600);
};

/**
 * @param segments  `computeTrack(...).segments`
 * @param type      a `normaliseType` value
 * @param weightKg  body mass, or null
 * @returns whole kcal, or null (see the two rules above)
 */
const activeKcal = (segments, { type, weightKg }) => {
    if (!finite(weightKg) || weightKg <= 0) return null;
    const price = FOOT_TYPES.has(type) ? footKcal : BIKE_TYPES.has(type) ? bikeKcal : null;
    if (!price) return null;
    const total = (segments || []).reduce((sum, seg) => sum + price(seg, weightKg), 0);
    return Math.round(total);
};

module.exports = { activeKcal, RUN_THRESHOLD_MS, MAX_GRADE, BIKE_METS };
