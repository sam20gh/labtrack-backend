/**
 * Miovix Age — the lifestyle half.
 *
 * **A deterministic table, not a model** — the eleventh, beside `utils/biologicalAge.js`
 * which owns the lab half. It sits to that file as `activityScore.js` and `sleepScore.js`
 * sit to `labtrackScore.js`: a separate table with its own argument, imported by the module
 * that composes them.
 *
 * ## What this is, and what it is not
 *
 * The lab half runs Levine PhenoAge, which is published, peer-reviewed and validated against
 * NHANES mortality follow-up. **This half has no paper behind it**, and pretending otherwise
 * would be the dishonest part of the whole feature.
 *
 * What it does is what Whoop's Healthspan does and describes itself as doing: take published
 * all-cause-mortality hazard ratios for individual behaviours and measurements, express each
 * as a distance from an age- and sex-matched typical value, correct for the fact that several
 * of them are measuring the same underlying thing, and convert the total into years. Every
 * `beta` below cites where it came from. None of them was fitted here, and the *composite*
 * has never been validated against anything — which is a real criticism of Whoop's version
 * and applies equally to this one.
 *
 * That is why `source` travels with every result, why the two halves are blended rather than
 * merged, and why `app/age/how.tsx` is not an optional screen. A person is entitled to know
 * which of the two numbers they are looking at.
 *
 * ## Why the conversion constant is PhenoAge's
 *
 * A log-hazard becomes an age by dividing by the rate at which log-hazard rises with age —
 * the Gompertz slope. Using PhenoAge's own `AGE_SLOPE` rather than a separately sourced
 * figure means a year means the same thing in both halves, which is the only thing that
 * makes blending them honest rather than a weighted average of two different scales.
 * `__tests__/biologicalAge.test.js` asserts the two constants have not drifted apart.
 *
 * ## The rules
 *
 * 1. **Null, never zero.** A contributor with no data is absent, not scored at 0. A watch
 *    that was not worn is not a resting heart rate of zero, and a week nobody logged is not
 *    a week of no steps. Below `MIN_DOMAINS` there is no lifestyle age at all — not a vaguer
 *    one, none.
 * 2. **Every term is bounded.** A single implausible reading — a VO2 max of 5, a resting
 *    heart rate of 200 from a watch on a table — must not be able to age somebody by
 *    decades. `clampTerm` is what stops one bad row dominating the sum.
 * 3. **Corroborating evidence is not independent evidence.** VO2 max, resting heart rate,
 *    steps and vigorous minutes are four views of one person's fitness. Summing them counts
 *    the same fact four times, which is what `OVERLAP` exists to prevent, and it is the
 *    correction Whoop names explicitly in its own description.
 * 4. **Blood pressure is staged by `bloodPressure.classify`, never by thresholds written
 *    here.** The same delegation `predictionMetrics.blood_pressure.band` makes, for the same
 *    reason: a forecast or an age that read a reading more leniently than the log screen
 *    does would break a guarantee this codebase has already paid for.
 * 5. **HRV is deliberately not a contributor.** The evidence for it as an independent
 *    mortality predictor is weak, the numbers are not comparable between devices, and Whoop
 *    does not include it in its nine either. It belongs on the screen as context, not in the
 *    arithmetic.
 */
const bloodPressure = require('./bloodPressure');

/**
 * Log-hazard per year of age. PhenoAge's `AGE_SLOPE`, deliberately — see the header.
 *
 * Duplicated rather than imported because `biologicalAge.js` imports this file, and a mutual
 * import is a load-order problem waiting to happen. The test that pins them together is what
 * keeps the duplication honest.
 */
const GOMPERTZ_SLOPE = 0.090165;

/**
 * ## Two anchors per contributor, and why one is not enough
 *
 * A biological age is a comparison **against your peers**, not against a guideline. The
 * first draft of this file had one anchor per contributor and it was the guideline — 7,000
 * steps, 60 minutes of strength work, a BMI of 23 — so a person sitting on the population
 * median for every single measure came out **six years older than they are**. That is not a
 * biological age. It is a distance-from-ideal score wearing years, and Miovix already has
 * one of those with a 0–100 scale and an honest name.
 *
 * So every contributor carries two:
 *
 * - **`median`** — the age- and sex-matched typical value. The arithmetic is centred on it,
 *   by subtracting the log-hazard *of the median* from the log-hazard of the person. The
 *   median person therefore scores exactly zero on every contributor and their biological
 *   age equals their chronological age, which is the only calibration under which the number
 *   means what its name says.
 * - **`target`** — the guideline. It moves nothing here; it is what the lever list will
 *   point at, because "reach 8,000 steps" is advice and "reach the median 5,500" is not.
 *
 * Keeping the published `lnHR` functions anchored wherever their literature anchors them and
 * subtracting the median afterwards means no coefficient had to be re-derived to centre the
 * model. It also means the uncomfortable case is handled honestly rather than by fudging a
 * curve: a BMI of 27 is close to the Western adult median, so it scores near zero here, and
 * the app says so rather than pretending the median person is unwell.
 */

/**
 * The most any single contributor may move the answer, in log-hazard.
 *
 * 0.6 is about six and a half years. The cap is there for a figure nobody believes — a watch
 * left on a desk reporting a resting heart rate of 200 — and **not** for a figure that is
 * merely bad. That distinction is the whole calibration: the first draft capped at 0.35 and
 * a BMI of 32 hit it, which is a perfectly ordinary reading, so three genuinely different
 * people all came out at exactly the same age. A cap that binds on realistic values stops
 * being a guard and starts being the model.
 */
const TERM_CAP = 0.6;

/**
 * How much a second, third or fourth measurement of the same underlying thing is worth.
 *
 * Within a domain, terms are ranked by magnitude and the *n*th is worth `OVERLAP ** n` of
 * itself — full, half, a quarter, an eighth. Ranked by magnitude rather than by value so the
 * dominant signal survives whichever direction it points.
 *
 * Geometric rather than a flat discount because the fitness domain holds five contributors,
 * and a flat half meant the fourth and fifth measurements of one person's fitness still
 * carried real weight. VO2 max, resting heart rate, steps, vigorous minutes and strength
 * minutes are five views of one thing; by the fifth there is almost no independent
 * information left, and a schedule that keeps paying for it is counting the same fact five
 * times. This is the correction Whoop names explicitly in its own description of Healthspan.
 *
 * Halving is a judgement, not a derivation, and it errs in the conservative direction: more
 * shrinkage can only ever move an answer *towards* the person's chronological age.
 */
const OVERLAP = 0.5;

/** Domains with fewer than this many contributors holding data produce no lifestyle age. */
const MIN_DOMAINS = 2;

/** A contributor needs this many days of the window before it is scored at all. */
const MIN_DAYS = { fitness: 7, sleep: 7, body: 1, vitals: 3 };

/** The window the behavioural half is measured over. Whoop uses six months; so does this. */
const WINDOW_DAYS = 180;

/** Same bound the lab half uses, for the same reason. */
const MAX_DEVIATION_YEARS = 20;

const clampTerm = (lnHR) => Math.max(-TERM_CAP, Math.min(TERM_CAP, lnHR));

const isMale = (sex) => String(sex || '').trim().toLowerCase() === 'male';

/**
 * Age- and sex-matched median cardiorespiratory fitness, ml/kg/min.
 *
 * A linear approximation of the ACSM 50th-percentile tables, which are published in decade
 * bands. Approximated rather than tabulated because a step change at every birthday decade
 * would move somebody's biological age by a year overnight for turning 40, which is an
 * artefact of the table's resolution and not a fact about them.
 */
const vo2Reference = (age, sex) => (isMale(sex)
    ? 46.5 - 0.29 * (age - 25)
    : 38.0 - 0.25 * (age - 25));

/**
 * The contributors, each with the evidence its coefficient came from.
 *
 * `lnHR(value, ctx)` returns a log-hazard relative to a typical person of the same age and
 * sex — negative is protective. `modifiable` and `route` are what the lever list reads: a
 * contributor nobody can act on, or one with nowhere to go, is the dead end `PILLAR_ROUTE`
 * exists to prevent on the score screen.
 */
const CONTRIBUTORS = [
    {
        key: 'vo2max',
        label: 'Cardio fitness',
        domain: 'fitness',
        unit: 'ml/kg/min',
        modifiable: 'behaviour',
        route: '/activity',
        betterWhen: 'rising',
        /**
         * 1 SD higher cardiorespiratory fitness → HR 0.77 for all-cause mortality
         * (Mandsager et al., JACC 2018). SD ≈ 7 ml/kg/min, so ln(0.77)/7 per unit.
         */
        beta: Math.log(0.77) / 7,
        // Already anchored on the 50th percentile, so centring on the median is a no-op here.
        median: (ctx) => vo2Reference(ctx.age, ctx.sex),
        target: (ctx) => vo2Reference(ctx.age, ctx.sex) + 7,
        plausible: [10, 90],
        lnHR(value, ctx) { return this.beta * (value - vo2Reference(ctx.age, ctx.sex)); },
    },
    {
        key: 'resting_hr',
        label: 'Resting heart rate',
        domain: 'fitness',
        unit: 'bpm',
        modifiable: 'behaviour',
        route: '/metrics',
        betterWhen: 'falling',
        /** ≈ 16% higher all-cause mortality per 10 bpm (pooled cohort estimates). */
        beta: Math.log(1.16) / 10,
        median: () => 70,
        target: () => 60,
        plausible: [30, 140],
        /**
         * Credit below the reference is floored at a quarter of the cap.
         *
         * The relationship flattens at the low end — an endurance athlete's 42 is not four
         * times the benefit of a 55 — and an unfloored linear term would hand large credit
         * to a bradycardia that can be a finding rather than a fitness marker.
         */
        lnHR(value) {
            const raw = this.beta * (value - 60);
            return raw < 0 ? Math.max(raw, -TERM_CAP / 4) : raw;
        },
    },
    {
        key: 'steps',
        label: 'Daily steps',
        domain: 'fitness',
        unit: 'steps/day',
        modifiable: 'behaviour',
        route: '/activity',
        betterWhen: 'rising',
        /**
         * Paluch et al., Lancet Public Health 2022 — 15 cohorts. Adjusted HR against the
         * lowest quartile: 0.60 / 0.55 / 0.47. Logarithmic rather than linear because the
         * benefit is front-loaded, and capped at the plateau the meta-analysis reports:
         * roughly 6–8k for adults over 60, 8–10k below.
         */
        beta: Math.log(0.47) / Math.log(10000 / 3500),
        median: () => 5500,
        target: (ctx) => (ctx.age >= 60 ? 8000 : 10000),
        plausible: [100, 60000],
        lnHR(value, ctx) {
            const plateau = ctx.age >= 60 ? 8000 : 10000;
            return this.beta * Math.log(Math.min(value, plateau) / 7000);
        },
    },
    {
        key: 'vigorous_minutes',
        label: 'Hard effort',
        domain: 'fitness',
        unit: 'min/week',
        modifiable: 'behaviour',
        route: '/activity',
        betterWhen: 'rising',
        /**
         * Meeting the WHO vigorous guideline (75 min/week) against none, with the benefit
         * plateauing around twice the guideline. Expressed per minute up to that plateau.
         */
        beta: Math.log(0.80) / 75,
        median: () => 15,
        target: () => 75,
        plausible: [0, 2000],
        lnHR(value) { return this.beta * (Math.min(value, 150) - 75); },
    },
    {
        key: 'strength_minutes',
        label: 'Strength work',
        domain: 'fitness',
        unit: 'min/week',
        modifiable: 'behaviour',
        route: '/activity',
        betterWhen: 'rising',
        /**
         * Muscle-strengthening activity carries an association independent of cardio
         * (Momma et al., BJSM 2022 — roughly HR 0.85 at 30–60 min/week, with the benefit
         * flattening and reversing beyond that, so it is capped rather than extrapolated).
         */
        beta: Math.log(0.85) / 60,
        // Zero, and that is not a rounding of a small number: most adults do no
        // muscle-strengthening activity at all. Charging everybody for the population's own
        // habit is how the first draft aged a median person by six years.
        median: () => 0,
        target: () => 60,
        plausible: [0, 1000],
        lnHR(value) { return this.beta * (Math.min(value, 120) - 60); },
    },
    {
        key: 'sleep_duration',
        label: 'Sleep duration',
        domain: 'sleep',
        unit: 'h/night',
        modifiable: 'behaviour',
        route: '/sleep',
        betterWhen: null,
        /**
         * U-shaped and **asymmetric**, which is the part a linear term gets wrong: short
         * sleep carries HR 1.14 and long sleep HR 1.34 (updated dose-response meta-analysis),
         * so more is not better and the two arms are not mirror images. Seven to eight hours
         * is the flat bottom, and a person inside it scores nothing rather than being ranked
         * within it.
         *
         * `betterWhen: null` for the same reason `weight` carries it in the prediction
         * registry: there is no direction to congratulate.
         */
        // Inside the flat 7–8 band, so the centring subtracts zero and the published
        // U-shape is used exactly as the meta-analysis reports it.
        median: () => 7.2,
        target: () => 7.5,
        plausible: [2, 14],
        lnHR(value) {
            if (value < 7) return Math.log(1.14) * (7 - value);
            if (value > 8) return Math.log(1.34) * (value - 8);
            return 0;
        },
    },
    {
        key: 'sleep_consistency',
        label: 'Sleep consistency',
        domain: 'sleep',
        unit: 'h variation',
        modifiable: 'behaviour',
        route: '/sleep/schedule',
        betterWhen: 'falling',
        /**
         * Sleep regularity predicts mortality at least as well as duration does, and the two
         * are only loosely correlated — which is why it is a second contributor rather than
         * a correction to the first. Weighted modestly: the evidence is newer and thinner
         * than the duration literature, and this is the direction to be wrong in.
         */
        beta: 0.10,
        median: () => 1.0,
        target: () => 0.5,
        plausible: [0, 8],
        lnHR(value) { return this.beta * Math.max(0, value - 0.5); },
    },
    {
        key: 'bmi',
        label: 'Body mass index',
        domain: 'body',
        unit: 'kg/m²',
        modifiable: 'behaviour',
        route: '/metrics/log/weight',
        /**
         * Deliberately null, and for the reason `weight` carries it in the prediction
         * registry: colouring this green or red would make the app take a view on somebody's
         * body. The term is U-shaped, so there is no single good direction anyway.
         */
        betterWhen: null,
        // The Western adult median, which sits above the clinical optimum. Centring here
        // means a BMI of 27 scores near zero — the app reports a comparison with peers and
        // does not pretend the median person is unwell. `target` is where a lever points.
        median: () => 27,
        target: () => 23,
        plausible: [12, 70],
        /** ≈ HR 1.29 per 5 kg/m² above 25 (prospective pooling); the low arm is shallower. */
        lnHR(value) {
            if (value > 25) return (Math.log(1.29) / 5) * (value - 25);
            if (value < 20) return 0.045 * (20 - value);
            return 0;
        },
    },
    {
        key: 'blood_pressure',
        label: 'Blood pressure',
        domain: 'vitals',
        unit: 'mmHg',
        modifiable: 'clinical',
        route: '/metrics/log/blood_pressure',
        betterWhen: 'falling',
        plausible: null,
        median: () => ({ systolic: 122, diastolic: 78 }),
        target: () => ({ systolic: 115, diastolic: 75 }),
        /**
         * **Staged by `bloodPressure.classify`, never by thresholds written here.** A ladder
         * on the category rather than a slope on the numbers, so a reading this file ages
         * somebody for is exactly a reading the log screen already called stage 1.
         */
        ladder: { normal: 0, elevated: 0.10, stage_1: 0.22, stage_2: 0.42, crisis: 0.42 },
        format: (v) => `${Math.round(v.systolic)}/${Math.round(v.diastolic)}`,
        lnHR(value) {
            const c = bloodPressure.classify(value?.systolic, value?.diastolic);
            // NaN rather than 0 for a pair the table cannot stage. Scoring it as `normal`
            // would let an unreadable reading both count towards coverage and quietly
            // certify a blood pressure nobody classified.
            return this.ladder[c?.key] ?? NaN;
        },
    },
];

const CONTRIBUTOR_BY_KEY = Object.fromEntries(CONTRIBUTORS.map((c) => [c.key, c]));

/**
 * Apply the overlap correction within each domain.
 *
 * Ranked by magnitude rather than by value, so the dominant signal survives whichever
 * direction it points: a person who is unfit by every measure and a person who is fit by
 * every measure are both spared having one fact counted four times.
 */
const correctOverlap = (terms) => {
    const byDomain = new Map();
    for (const t of terms) {
        if (!byDomain.has(t.domain)) byDomain.set(t.domain, []);
        byDomain.get(t.domain).push(t);
    }

    let total = 0;
    const adjusted = [];
    for (const group of byDomain.values()) {
        const ranked = [...group].sort((a, b) => Math.abs(b.lnHR) - Math.abs(a.lnHR));
        ranked.forEach((t, i) => {
            const weight = Number((OVERLAP ** i).toFixed(4));
            total += t.lnHR * weight;
            adjusted.push({ ...t, weight });
        });
    }
    return { total, adjusted };
};

const refusal = (reason, message, extra = {}) => ({ ok: false, reason, message, ...extra });

/**
 * The lifestyle age for one person.
 *
 * @param {number} chronologicalAge years
 * @param {string|null} sex `User.gender`
 * @param {Object} inputs contributor key → { value, days } — `days` is how many days of the
 *   window that figure was measured over, and a contributor below `MIN_DAYS` is dropped
 *   rather than scored on two readings.
 */
const lifestyleAge = ({
    chronologicalAge, sex = null, inputs = {}, windowDays = WINDOW_DAYS,
} = {}) => {
    if (!Number.isFinite(chronologicalAge)) {
        return refusal('no_age', 'We need your date of birth before we can work this out.');
    }

    const ctx = { age: chronologicalAge, sex };
    const terms = [];
    const skipped = [];

    for (const c of CONTRIBUTORS) {
        const input = inputs[c.key];
        if (!input || input.value === null || input.value === undefined) {
            skipped.push({ key: c.key, label: c.label, reason: 'no_data', route: c.route });
            continue;
        }

        const days = Number.isFinite(input.days) ? input.days : 0;
        if (days < (MIN_DAYS[c.domain] ?? 1)) {
            skipped.push({
                key: c.key, label: c.label, reason: 'too_few_days', route: c.route,
                have: days, need: MIN_DAYS[c.domain] ?? 1,
            });
            continue;
        }

        // A reading outside the plausible band is a broken sensor, not a finding. Dropped
        // rather than clamped: clamping a 200 bpm resting heart rate to the cap still ages
        // somebody by four years for a watch left on a desk.
        if (c.plausible && (input.value < c.plausible[0] || input.value > c.plausible[1])) {
            skipped.push({ key: c.key, label: c.label, reason: 'implausible', route: c.route });
            continue;
        }

        // Centred on the population median: see "Two anchors per contributor" above. The
        // median person scores zero, so their biological age is their chronological age.
        const raw = c.lnHR(input.value, ctx) - c.lnHR(c.median(ctx), ctx);
        if (!Number.isFinite(raw)) {
            skipped.push({ key: c.key, label: c.label, reason: 'not_computable', route: c.route });
            continue;
        }

        terms.push({
            key: c.key,
            label: c.label,
            domain: c.domain,
            unit: c.unit,
            value: input.value,
            display: c.format ? c.format(input.value) : input.value,
            days,
            medianDisplay: c.format ? c.format(c.median(ctx)) : Number(c.median(ctx).toFixed(1)),
            targetDisplay: c.format ? c.format(c.target(ctx)) : Number(c.target(ctx).toFixed(1)),
            modifiable: c.modifiable,
            route: c.route,
            betterWhen: c.betterWhen,
            lnHR: clampTerm(raw),
            capped: Math.abs(raw) > TERM_CAP,
        });
    }

    const domains = new Set(terms.map((t) => t.domain));
    if (domains.size < MIN_DOMAINS) {
        return refusal(
            'insufficient_coverage',
            domains.size === 0
                ? 'Connect a watch or log a few days of activity and sleep, and we can work this out.'
                : 'We can see one part of your week so far. A few days of another — sleep, '
                  + 'activity, or a weigh-in — and we can work this out.',
            {
                have: domains.size,
                need: MIN_DOMAINS,
                domains: [...domains],
                skipped,
            },
        );
    }

    const { total, adjusted } = correctOverlap(terms);
    const shift = total / GOMPERTZ_SLOPE;

    const bounded = Math.max(-MAX_DEVIATION_YEARS, Math.min(MAX_DEVIATION_YEARS, shift));
    const value = chronologicalAge + bounded;

    return {
        ok: true,
        source: 'lifestyle',
        method: 'hazard_aggregate',
        value: Number(value.toFixed(1)),
        chronologicalAge: Number(chronologicalAge.toFixed(1)),
        delta: Number(bounded.toFixed(1)),
        clamped: Math.abs(shift) > MAX_DEVIATION_YEARS,
        /**
         * The window the caller actually gathered over, not the default.
         *
         * It used to report `WINDOW_DAYS` unconditionally, which made the thirty-day
         * recompute behind the provisional pace describe itself as six months of evidence —
         * in the one place where the difference between the two windows *is* the measurement.
         */
        windowDays,
        coverage: {
            scored: terms.length,
            total: CONTRIBUTORS.length,
            domains: [...domains],
        },
        /**
         * Each contributor in years, after the overlap correction, ranked worst first.
         *
         * `weight` is shown rather than folded in silently: a person looking at why their
         * steps are worth less than their VO2 max is owed the reason, and the reason is that
         * the two are measuring the same thing.
         */
        contributions: adjusted
            .map((t) => ({
                key: t.key,
                label: t.label,
                domain: t.domain,
                value: t.value,
                /** What a row prints. Blood pressure is a pair, so a raw value is unusable. */
                display: t.display,
                unit: t.unit,
                /** What a typical person of this age and sex measures. Centres the maths. */
                median: t.medianDisplay,
                /** The guideline. Moves nothing here; it is what a lever points at. */
                target: t.targetDisplay,
                days: t.days,
                weight: t.weight,
                modifiable: t.modifiable,
                route: t.route,
                betterWhen: t.betterWhen,
                capped: t.capped,
                years: Number(((t.lnHR * t.weight) / GOMPERTZ_SLOPE).toFixed(2)),
            }))
            .sort((a, b) => b.years - a.years),
        /** What was not scored, and why — so a screen can say what would improve the answer. */
        skipped,
    };
};

module.exports = {
    CONTRIBUTORS,
    CONTRIBUTOR_BY_KEY,
    lifestyleAge,
    vo2Reference,
    GOMPERTZ_SLOPE,
    TERM_CAP,
    OVERLAP,
    MIN_DOMAINS,
    MIN_DAYS,
    WINDOW_DAYS,
    MAX_DEVIATION_YEARS,
    _correctOverlap: correctOverlap,
    _clampTerm: clampTerm,
};
