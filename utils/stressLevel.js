/**
 * Whether a stress reading is calmer or more stressed than this person's usual.
 *
 * The bracelet's stress score is the vendor's own number on a scale it does not publish, so
 * a fixed "80 is stressed" would be a meaning nobody documented — and healthy people sit at
 * very different levels on it. So the colour is decided against **the person's own usual**:
 * the median of their previous days' averages. Chosen 2026-10-08 over fixed bands.
 *
 * A deterministic table in the series with `medicationCatalogue.js`, `bloodPressure.js` and
 * the rest, for the series' reason: a threshold every screen and the portal
 * computes for itself is one they eventually disagree about.
 *
 * Four rules:
 *
 * 1. **No usual, no colour.** Until `MIN_DAYS` earlier days exist the level is null and the
 *    screens say they are still learning — a colour over two days of data is a guess.
 * 2. **"Near" is ±15%, never narrower than 5 points.** 15% of a usual 12 is under two points,
 *    which is sensor noise, and would paint half of a calm day red.
 * 3. **Red is relative and says so.** The label is "More stressed than usual", never
 *    "Stressed": a person whose usual is high is not told they are in a stressed state by a
 *    number that knows nothing about them. The colour is never the only signal — red and
 *    green are the pair colour-blind readers lose, so every colour travels with its label.
 * 4. **Not a score pillar, not an alert.** See `metricsController.stressCard`.
 */

/** Days of history the usual is taken over, and how many it needs before it exists. */
const BASELINE_DAYS = 28;
const MIN_DAYS = 5;
const BAND = 0.15;
const MIN_POINTS = 5;

/** `colour` is light-mode hex, drawn through `tone()` on the phone like every server colour. */
const LEVELS = {
    below: { key: 'below', label: 'Calmer than usual', short: 'Calm', colour: '#10B981' },
    usual: { key: 'usual', label: 'About your usual', short: 'Usual', colour: null },
    above: { key: 'above', label: 'More stressed than usual', short: 'Stressed', colour: '#EF4444' },
};

const median = (values) => {
    const s = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** The usual from earlier days' averages, or null below `MIN_DAYS`. */
const baselineOf = (dayAverages = []) => {
    const values = dayAverages.filter((v) => Number.isFinite(v));
    return values.length >= MIN_DAYS ? Math.round(median(values)) : null;
};

/** Where one value sits against the usual, or null with no usual or no value. */
const levelFor = (value, baseline) => {
    if (!Number.isFinite(value) || !Number.isFinite(baseline)) return null;
    const band = Math.max(baseline * BAND, MIN_POINTS);
    const delta = value - baseline;
    if (delta > band) return LEVELS.above;
    if (delta < -band) return LEVELS.below;
    return LEVELS.usual;
};

/**
 * How somebody says they feel, beside what the bracelet says. Five steps, worded as feelings
 * rather than numbers, because a 1–10 slider asks people to calibrate a scale in their head.
 */
const FEELINGS = [
    { value: 1, key: 'calm', label: 'Calm' },
    { value: 2, key: 'okay', label: 'Okay' },
    { value: 3, key: 'tense', label: 'Tense' },
    { value: 4, key: 'stressed', label: 'Stressed' },
    { value: 5, key: 'overwhelmed', label: 'Overwhelmed' },
];
const feelingFor = (value) => FEELINGS.find((f) => f.value === Number(value)) ?? null;

module.exports = {
    BASELINE_DAYS, MIN_DAYS, BAND, MIN_POINTS, LEVELS, FEELINGS,
    baselineOf, levelFor, feelingFor,
};
