/**
 * The arithmetic behind every prediction in the app.
 *
 * **This is a deterministic table's cousin, not a model**, and it is the fifth thing in this
 * codebase built that way — after `medicationCatalogue.js`, `bloodPressure.js`,
 * `nutritionSafety.js` and `reviewSla.js`. The argument is the same one every time: a
 * language model asked "what will this person's blood pressure be next week" will answer
 * fluently, differently on each call, and with no way to assert in a test that it did not
 * hallucinate a trend out of four readings. A weighted regression over the person's own rows
 * is reproducible, cheap, explainable line by line, and can be checked afterwards against
 * what actually happened — which `predictionController.resolve` does.
 *
 * Claude still writes the prose (`utils/predictionEngine.js`), exactly as it writes the
 * interaction check's summary while `runRules` owns the verdict. The numbers on the screen
 * come from here and the merge in `predictionEngine.mergeNarrative` makes that a guarantee
 * rather than a request in a prompt.
 *
 * ── Six rules, each of which is a way the naive version is wrong ──────────────────────
 *
 * 1. **Below `MIN_OBSERVATIONS` there is no prediction at all.** Two points define a line
 *    through themselves and imply a trend that does not exist. The design already draws this
 *    state — "We don't have enough data for blood pressure. Please log at least 3 entries
 *    first" — so the screen for it exists and `null` is what routes someone to it.
 * 2. **A prediction is an interval, never a point.** Everything here returns `low`/`high`
 *    around `point`, and the design prints the interval ("80-90 pts", "70/130±10"). A bare
 *    number on a health screen reads as a measurement of the future.
 * 3. **Recency is weighted, and the half-life is in days rather than in samples.** Someone
 *    who logs daily for a fortnight and then twice a month must not have March counted as
 *    heavily as yesterday, and counting by sample index gets that backwards.
 * 4. **The horizon is capped against the span the data actually covers.** Three weeks of
 *    weigh-ins cannot say anything about next year. `EXTRAPOLATION_LIMIT` turns a request
 *    for an unsupportable horizon into a refusal that names the reason, not into a wider
 *    interval that still looks like an answer.
 * 5. **Confidence is computed, never asserted.** It falls out of residual scatter, sample
 *    count, how far past the data the horizon reaches, and how stale the last observation is.
 *    The design prints "98% confidence level" as a chip; that chip has to mean something.
 * 6. **A flat series is flat.** When the move a slope implies *over the horizon being asked
 *    about* is smaller than the scatter the series already has, it is reported as zero. So
 *    the app does not tell someone their weight is climbing because a regression through
 *    bathroom-scale noise happened to tilt upward — and the same drift can still be a real
 *    trend over a year, which a fixed per-day threshold could not express.
 * 7. **The level is anchored on the most recent reading, the fit supplies only the slope.**
 *    A series that changed regime — flat for a fortnight then a sharp climb — fits a line
 *    whose level at the anchor sits below every recent point. Drawn as it comes out, that is
 *    "rising" printed beside a number *lower* than what the person last measured, which reads
 *    as a bug whatever the arithmetic says. Half the level comes from the fit and half from
 *    the last observation, and the interval is measured about the blended line, so a fit and
 *    a last reading that disagree widen the interval rather than being quietly reconciled.
 */

/** Fewer than this and there is no prediction. The design's empty state says "at least 3". */
const MIN_OBSERVATIONS = 3;

/**
 * Recency half-life. An observation this many days old counts half as much as today's.
 *
 * Fourteen because the trackers this reads are daily ones: a fortnight is long enough that a
 * month of steady data still shapes the line, short enough that last week dominates it.
 */
const RECENCY_HALF_LIFE_DAYS = 14;

/**
 * How far past the observed span a forecast may reach, as a multiple of that span.
 *
 * 0.75 rather than 1: predicting three weeks ahead from four weeks of data is already a
 * stretch, and the failure mode of being generous here is a confident-looking answer about a
 * year nobody has any evidence for.
 */
const EXTRAPOLATION_LIMIT = 0.75;

/**
 * Interval half-width, in residual standard deviations.
 *
 * 1.65 is the two-sided 90% normal quantile. Deliberately not 1.96/95%: these residuals are
 * not normal and the sample is small, so quoting a 95% interval would be a precision claim
 * the arithmetic cannot support. The interval is widened further with the horizon below.
 */
const INTERVAL_Z = 1.65;

/**
 * A slope counts as a trend only when the move it implies over the requested horizon exceeds
 * this share of the series' own residual scatter. Half: a projected move smaller than half
 * the noise the series already carries is not something anyone could measure.
 */
const FLAT_MOVE_RATIO = 0.5;

/**
 * How much of the level comes from the most recent reading rather than from the fitted
 * intercept. See rule 7 — half, so neither a single mistyped weigh-in nor a stale regime can
 * own the answer on its own.
 */
const LEVEL_ANCHOR = 0.5;

/** An observation older than this contributes, but costs confidence. */
const STALE_AFTER_DAYS = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, dp = 2) => {
    const f = 10 ** dp;
    return Math.round(v * f) / f;
};

/** Days between two dates, fractional. */
const daysBetween = (a, b) => (new Date(b).getTime() - new Date(a).getTime()) / DAY_MS;

/**
 * Fit `value = intercept + slope · day` by weighted least squares.
 *
 * Weights are `0.5 ^ (age / half-life)`, so the fit answers "where is this person now and
 * where are they heading" rather than "what is the average of everything ever recorded".
 */
const fit = (points, anchorMs) => {
    let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;

    for (const p of points) {
        const x = (p.t - anchorMs) / DAY_MS;              // days relative to the last reading
        const w = 0.5 ** (Math.abs(x) / RECENCY_HALF_LIFE_DAYS);
        sw += w; swx += w * x; swy += w * p.v;
        swxx += w * x * x; swxy += w * x * p.v;
    }

    const denom = sw * swxx - swx * swx;
    // Every observation on the same day: no slope is recoverable, only a level.
    if (!Number.isFinite(denom) || Math.abs(denom) < 1e-9) {
        return { slope: 0, intercept: swy / sw, degenerate: true };
    }

    return {
        slope: (sw * swxy - swx * swy) / denom,
        intercept: (swy * swxx - swx * swxy) / denom,
        degenerate: false,
    };
};

/**
 * Weighted residual standard deviation about a line.
 *
 * Called with the **blended** level rather than the raw intercept, so a fit that disagrees
 * with the person's most recent reading is reported as more uncertain, which is what it is.
 */
const residualSd = (points, anchorMs, { slope, intercept }) => {
    let sw = 0, sse = 0;
    for (const p of points) {
        const x = (p.t - anchorMs) / DAY_MS;
        const w = 0.5 ** (Math.abs(x) / RECENCY_HALF_LIFE_DAYS);
        const r = p.v - (intercept + slope * x);
        sw += w; sse += w * r * r;
    }
    // n-2 rather than n: two parameters were spent fitting the line. With exactly three
    // points that is a single degree of freedom, which is honest — the interval comes out
    // wide, as it should.
    const dof = Math.max(1, points.length - 2);
    return Math.sqrt((sse / sw) * (points.length / dof));
};

/**
 * Normalise whatever a gatherer produced into sorted `{ t, v }`.
 *
 * Nulls are dropped rather than interpolated. A day nobody weighed themselves is not a
 * weight, and filling it in with a straight line is how a fortnight's honest gap becomes
 * "evidence" — the same argument `nutritionInsight` makes about dividing by days logged.
 */
const normalise = (observations) => observations
    .map((o) => ({
        t: new Date(o.at ?? o.day).getTime(),
        v: typeof o.value === 'number' ? o.value : null,
    }))
    .filter((o) => Number.isFinite(o.t) && Number.isFinite(o.v))
    .sort((a, b) => a.t - b.t);

/**
 * How much to trust this, 0–1.
 *
 * Four multiplicative penalties, because they compound in reality: a noisy series measured
 * five times, projected a long way, from data a fortnight old is not "somewhat" uncertain.
 */
const confidenceOf = ({ points, sd, spread, horizonDays, spanDays, staleDays }) => {
    // Scatter relative to the range the series actually covers. A series that moves 20 units
    // with 2 units of noise is far more forecastable than one that moves 2 with 2.
    const noise = spread > 0 ? clamp(1 - (sd / spread), 0, 1) : 0.35;

    // Sample size. Saturates around a month of daily data — more than that adds little.
    const size = clamp((points - MIN_OBSERVATIONS + 1) / 28, 0, 1);

    // Extrapolation. Predicting inside the observed span is nearly free; the penalty grows
    // as the horizon approaches EXTRAPOLATION_LIMIT × span.
    const reach = spanDays > 0 ? clamp(1 - (horizonDays / (spanDays * EXTRAPOLATION_LIMIT)), 0, 1) : 0;

    // Staleness. Predicting from data that stopped ten days ago is predicting from a guess
    // about the ten days nobody recorded.
    const fresh = clamp(1 - Math.max(0, staleDays - 2) / (STALE_AFTER_DAYS * 2), 0.2, 1);

    // Weighted geometric-ish blend, then floored: a real prediction is never reported as
    // 4% confident, it is reported as absent. Anything this weak has already been refused.
    const raw = (0.40 * noise) + (0.25 * size) + (0.25 * reach) + (0.10 * fresh);
    return clamp(round(0.25 + 0.72 * raw, 3), 0.25, 0.97);
};

/**
 * Forecast one series forward.
 *
 * @param {{at?: string|Date, day?: string, value: number|null}[]} observations
 * @param {object}  options
 * @param {number}  options.horizonDays   how far ahead, in days
 * @param {number}  [options.decimals]    rounding for the reported figures
 * @param {[number, number]} [options.bounds]  physical limits to clamp into, e.g. [0, 100]
 * @param {Date}    [options.now]         injected in tests
 *
 * @returns {null | {
 *   point: number, low: number, high: number, margin: number,
 *   confidence: number, direction: 'rising'|'falling'|'flat',
 *   slopePerDay: number, changePct: number|null,
 *   basis: { points: number, spanDays: number, firstAt: string, lastAt: string,
 *            lastValue: number, staleDays: number, sd: number },
 *   horizonDays: number, targetDate: string,
 * }}
 *   `null` when the series cannot support a prediction. The caller turns that into the
 *   design's "not enough data yet" screen — never into a zero, and never into a wider
 *   interval that pretends the answer exists.
 */
const forecast = (observations, {
    horizonDays,
    decimals = 1,
    bounds = null,
    now = new Date(),
} = {}) => {
    const points = normalise(observations);
    if (points.length < MIN_OBSERVATIONS) return null;

    const first = points[0];
    const last = points[points.length - 1];
    const spanDays = (last.t - first.t) / DAY_MS;

    // Every reading on one day is a level with no trend in it. Refused rather than answered
    // with a flat line, because "your weight will be exactly what it was" is not a forecast.
    if (spanDays < 1) return null;

    const maxHorizon = spanDays * EXTRAPOLATION_LIMIT;
    if (horizonDays > maxHorizon) return null;

    const model = fit(points, last.t);

    // Rule 7: the fit supplies the gradient, the person's last reading anchors the position.
    const level = LEVEL_ANCHOR * last.v + (1 - LEVEL_ANCHOR) * model.intercept;
    const sd = residualSd(points, last.t, { slope: model.slope, intercept: level });

    const values = points.map((p) => p.v);
    const spread = Math.max(...values) - Math.min(...values);

    // Rule 6: a move smaller than the noise, over the horizon actually asked about, is flat.
    const slope = Math.abs(model.slope) * horizonDays < sd * FLAT_MOVE_RATIO ? 0 : model.slope;

    const staleDays = Math.max(0, daysBetween(last.t, now));

    // The interval widens with the horizon: uncertainty about where the line is *now* and
    // uncertainty about its gradient both project forward. sqrt rather than linear so a
    // fortnight ahead is not drawn as four times as uncertain as a week.
    const widening = Math.sqrt(1 + (horizonDays / Math.max(1, spanDays)));
    let margin = INTERVAL_Z * sd * widening;

    // A series with no scatter at all (three identical weigh-ins) would otherwise quote a
    // zero-width interval, which is the one thing a forecast must never do. The floor widens
    // with the horizon too — a noiseless series is still less knowable next month than
    // tomorrow, and a flat floor would draw both as equally certain.
    const floor = Math.max(Math.abs(last.v) * 0.01, 10 ** -decimals) * widening;
    margin = Math.max(margin, floor);

    let point = level + slope * horizonDays;
    let low = point - margin;
    let high = point + margin;

    if (bounds) {
        const [lo, hi] = bounds;
        point = clamp(point, lo, hi);
        low = clamp(low, lo, hi);
        high = clamp(high, lo, hi);
    }

    const changePct = last.v !== 0 ? round(((point - last.v) / Math.abs(last.v)) * 100, 1) : null;

    return {
        point: round(point, decimals),
        low: round(low, decimals),
        high: round(high, decimals),
        margin: round(margin, decimals),
        confidence: confidenceOf({
            points: points.length, sd, spread, horizonDays, spanDays, staleDays,
        }),
        direction: slope > 0 ? 'rising' : slope < 0 ? 'falling' : 'flat',
        slopePerDay: round(slope, 4),
        changePct,
        basis: {
            points: points.length,
            spanDays: round(spanDays, 1),
            firstAt: new Date(first.t).toISOString(),
            lastAt: new Date(last.t).toISOString(),
            lastValue: round(last.v, decimals),
            staleDays: round(staleDays, 1),
            sd: round(sd, decimals + 1),
        },
        horizonDays,
        targetDate: new Date(now.getTime() + horizonDays * DAY_MS).toISOString(),
    };
};

/**
 * Why a series could not be forecast, in words the app can show.
 *
 * Separate from `forecast` returning null on purpose: the caller needs to render *which*
 * wall it hit, and a boolean cannot say "you have enough readings, they are just all from
 * the same afternoon". The design's empty-state modal prints this sentence.
 */
const explainRefusal = (observations, horizonDays) => {
    const points = normalise(observations);

    if (points.length < MIN_OBSERVATIONS) {
        const need = MIN_OBSERVATIONS - points.length;
        return {
            reason: 'too_few',
            need: MIN_OBSERVATIONS,
            have: points.length,
            message: points.length === 0
                ? `We have nothing recorded yet. Log at least ${MIN_OBSERVATIONS} entries and we can predict this.`
                : `Please log ${need} more ${need === 1 ? 'entry' : 'entries'} first so we can predict your metric.`,
        };
    }

    const spanDays = (points[points.length - 1].t - points[0].t) / DAY_MS;
    if (spanDays < 1) {
        return {
            reason: 'no_span',
            need: MIN_OBSERVATIONS,
            have: points.length,
            message: 'All of your entries are from the same day. Log again tomorrow and we can look for a trend.',
        };
    }

    return {
        reason: 'horizon_too_far',
        need: MIN_OBSERVATIONS,
        have: points.length,
        maxHorizonDays: Math.floor(spanDays * EXTRAPOLATION_LIMIT),
        message: `We only have ${Math.round(spanDays)} days of history, which is not enough to look `
            + `${horizonDays} days ahead. Keep logging, or pick a shorter horizon.`,
    };
};

/** The longest horizon this series can support, in days. Zero when it supports none. */
const maxHorizonFor = (observations) => {
    const points = normalise(observations);
    if (points.length < MIN_OBSERVATIONS) return 0;
    const spanDays = (points[points.length - 1].t - points[0].t) / DAY_MS;
    if (spanDays < 1) return 0;
    return Math.floor(spanDays * EXTRAPOLATION_LIMIT);
};

/**
 * The per-day path from today to the horizon, for the design's forecast chart and its
 * direction calendar.
 *
 * Each day carries the interval as well as the point, so the chart can draw the fan the
 * design shades in green or red rather than a single confident line.
 */
const project = (observations, { horizonDays, decimals = 1, bounds = null, now = new Date() } = {}) => {
    const head = forecast(observations, { horizonDays, decimals, bounds, now });
    if (!head) return null;

    const days = [];
    for (let d = 1; d <= horizonDays; d += 1) {
        const step = forecast(observations, { horizonDays: d, decimals, bounds, now });
        if (!step) break;
        days.push({
            day: new Date(now.getTime() + d * DAY_MS).toISOString().slice(0, 10),
            value: step.point,
            low: step.low,
            high: step.high,
        });
    }

    return { ...head, days };
};

module.exports = {
    forecast,
    project,
    explainRefusal,
    maxHorizonFor,
    MIN_OBSERVATIONS,
    EXTRAPOLATION_LIMIT,
    RECENCY_HALF_LIFE_DAYS,
    INTERVAL_Z,
    STALE_AFTER_DAYS,
    FLAT_MOVE_RATIO,
    LEVEL_ANCHOR,
    // Exported for the tests, which assert the fit in isolation.
    _fit: fit,
    _normalise: normalise,
    _confidenceOf: confidenceOf,
};
