/**
 * The LabTrack score.
 *
 * The kit calls it the "turing score" and explains it as "a comprehensive health & wellness
 * score ... based on your **active data**". That last phrase is the whole design, and it is
 * what the previous implementation got wrong.
 *
 * `lib/healthScore.ts` computed the score on the client from a `lifestyle` pillar that read
 * `healthAssessment.lifestyle` — the answers someone typed once during onboarding. So a
 * person who has since synced a watch, logged three weeks of meals and taken every dose was
 * still being scored on what they claimed about themselves months ago, and nothing they did
 * afterwards moved the number. A tracker whose numbers do not move the score is a tracker
 * nobody keeps using.
 *
 * Two rules hold this file together.
 *
 * 1. **Observed beats reported, always.** Every pillar declares a `source`: `observed` when
 *    it was measured (a watch, a logged meal, a recorded dose, a lab report), `reported`
 *    when it came from the questionnaire. Where both exist the observed value is used and
 *    the reported one is discarded outright — not averaged with it. Averaging a measurement
 *    against a self-assessment lets an optimistic onboarding answer prop up a bad week,
 *    which is precisely the failure being fixed.
 *
 * 2. **Reported answers decay; measurements do not get a free pass either.** A questionnaire
 *    answer is evidence about the day it was given, so its weight falls off over
 *    `REPORTED_HALF_LIFE_DAYS` and it is always worth less than a measurement of the same
 *    thing. Observed pillars are scored over an explicit window and a stale window scores
 *    null rather than carrying an old number forward.
 *
 * Server-side and deterministic, for the reason `activityScore.js` already states: a score
 * computed on the client means two phones disagree about a person's own number. It also has
 * to be server-side because a trend chart needs snapshots, and because the interpretation
 * engine and the plan generator both read it.
 *
 * Nothing here is a clinical instrument. It summarises the records LabTrack holds, and
 * `SCORE_DISCLAIMER` says so wherever the number is shown.
 */

const { scoreWindow: scoreActivityWindow } = require('./activityScore');
const { adherence: doseAdherence } = require('./medicationSchedule');

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
const DAY_MS = 24 * 60 * 60 * 1000;

const SCORE_DISCLAIMER =
    'Your score summarises the records in LabTrack — it is not a diagnosis. Always discuss results with a clinician.';

/**
 * The bands, and the words on them.
 *
 * The kit labels these Healthy / Suboptimal / Critical. "Critical" is not used here for the
 * same reason `sleepScore.js` refuses the kit's bottom label: this is an engagement summary
 * over someone's own records, and a person who has simply not logged anything for a fortnight
 * must not be told they are in a critical state by a number that does not know anything about
 * them. The thresholds are the kit's.
 */
const BANDS = [
    { key: 'healthy', label: 'Healthy', min: 71, max: 100 },
    { key: 'suboptimal', label: 'Suboptimal', min: 40, max: 70 },
    { key: 'attention', label: 'Needs attention', min: 0, max: 39 },
];

const bandFor = (score) => {
    if (!Number.isFinite(score)) return null;
    return BANDS.find((b) => score >= b.min && score <= b.max) || null;
};

/**
 * How long a questionnaire answer stays worth anything.
 *
 * At the half-life a reported pillar carries half the weight it started with; by roughly a
 * year it is contributing almost nothing. This is what makes the score migrate off the
 * questionnaire on its own as someone uses the app, without blanking the score on day one
 * for a person who has answered the assessment and not yet connected anything.
 */
const REPORTED_HALF_LIFE_DAYS = 120;

/**
 * A reported pillar is never worth more than this share of its observed equivalent, however
 * fresh it is. Someone saying they sleep well and a watch measuring six broken hours are not
 * two opinions of equal standing.
 */
const REPORTED_CEILING = 0.5;

const reportedWeightFactor = (answeredAt) => {
    if (!answeredAt) return REPORTED_CEILING * 0.5;
    const age = (Date.now() - new Date(answeredAt).getTime()) / DAY_MS;
    if (!Number.isFinite(age) || age < 0) return REPORTED_CEILING;
    return REPORTED_CEILING * Math.pow(0.5, age / REPORTED_HALF_LIFE_DAYS);
};

/**
 * Base weights, before provenance is applied.
 *
 * Ordered by how much the number tells you about the person rather than by how much data
 * each one represents. Measured biomarkers outrank everything; behaviour the person can
 * change this week (activity, sleep, nutrition, medication) sits in the middle and carries
 * most of the total between them, because those are the four things this release added and
 * the only ones a score is any use for nudging.
 */
const WEIGHTS = {
    biomarkers: 3,
    activity: 2,
    sleep: 2,
    nutrition: 1.75,
    medication: 1.75,
    vitals: 1.5,
    body: 1.5,
    plan: 1.25,
    mind: 1,
};

/** Every pillar, in the order the breakdown screen lists them. */
const PILLAR_KEYS = Object.keys(WEIGHTS);

const pillar = (key, label, value, detail, source, extra = {}) => ({
    key,
    label,
    value: value === null || value === undefined ? null : clamp(value),
    band: Number.isFinite(value) ? bandFor(clamp(value))?.key ?? null : null,
    detail,
    /** `observed` | `reported` | `none` — rendered as a provenance chip on the breakdown. */
    source,
    ...extra,
});

/* ------------------------------------------------------------------ *
 * Pillars
 *
 * Every scorer returns a pillar even when it has nothing to score, so the
 * breakdown screen can list what is missing and say how to fill it. A pillar
 * with `value: null` is excluded from the weighted mean rather than counted
 * as zero — the distinction `MealLog`'s `unassessed` alignment and
 * `medicationSchedule.adherence` both make, for the same reason: nobody has
 * failed at something that has not been measured.
 * ------------------------------------------------------------------ */

/**
 * Lab markers in range, weighted so a critical flag hurts more than a borderline one.
 *
 * Unknown flags are excluded rather than scored as passes. An unevaluated analyte is absence
 * of evidence, and counting it as a pass inflates the score — the same reason the
 * uncatalogued markers in `biomarkerGlossary` are shown as "not checked" rather than fine.
 */
const FLAG_WEIGHT = { normal: 1, low: 0.55, high: 0.55, critical_low: 0, critical_high: 0 };

const scoreBiomarkers = (biomarkers = []) => {
    const evaluated = biomarkers.filter((b) => b.flag && b.flag !== 'unknown');
    if (!evaluated.length) {
        return pillar('biomarkers', 'Markers', null, 'Upload a lab report to score this.', 'none');
    }

    const total = evaluated.reduce((sum, b) => sum + (FLAG_WEIGHT[b.flag] ?? 0), 0);
    const outOfRange = evaluated.filter((b) => b.flag !== 'normal').length;

    return pillar(
        'biomarkers', 'Markers',
        (total / evaluated.length) * 100,
        outOfRange
            ? `${outOfRange} of ${evaluated.length} markers outside your range.`
            : `All ${evaluated.length} markers within your range.`,
        'observed',
        { measuredAt: newestDate(biomarkers.map((b) => b.measuredAt)) },
    );
};

/**
 * Activity, measured against the person's own plan.
 *
 * Delegates to `activityScore.scoreWindow` rather than re-deriving anything: the number on
 * the activity dashboard and the number feeding the health score have to be the same number,
 * or the app is telling someone two different things about one week of their life.
 *
 * The reported fallback is the assessment's `fitnessLevel` ladder. It is a claim about how
 * fit someone is, not about what they did this week, so it is only ever reached when no
 * sessions exist at all.
 */
const FITNESS_LEVELS = { Beginner: 35, Intermediate: 60, Advanced: 85 };

const scoreActivity = ({ series = [], targets, days, reported, answeredAt } = {}) => {
    const measured = scoreActivityWindow({ series, targets, days });
    const active = series.filter((p) => (p.sessions || 0) > 0).length;

    if (measured.value !== null) {
        return pillar(
            'activity', 'Activity', measured.value,
            `${measured.done.sessions} session${measured.done.sessions === 1 ? '' : 's'} and ` +
            `${Math.round(measured.done.minutes)} active minutes over ${days} days.`,
            'observed',
            { components: measured.components, progress: measured.progress, activeDays: active },
        );
    }

    // Sessions but no plan: nobody set a target, so there is nothing to score against.
    if (active > 0) {
        return pillar('activity', 'Activity', null,
            'Set an activity goal so your sessions can be scored.', 'none', { activeDays: active });
    }

    const claimed = ladderScore(reported?.fitnessLevel, FITNESS_LEVELS);
    if (claimed === null) {
        return pillar('activity', 'Activity', null, 'Connect a device or log a workout.', 'none');
    }
    return pillar('activity', 'Activity', claimed,
        'From the fitness level you gave. Connect a device to score this properly.',
        'reported', { answeredAt });
};

/**
 * Sleep, from the nightly scores `healthSync` already wrote.
 *
 * Reads `DailyMetrics.sleep.score` rather than recomputing from stages, so the trend on the
 * sleep screen and this pillar cannot disagree. A window with fewer than `MIN_NIGHTS` scored
 * nights is not scored: two nights is a weekend, not a sleep pattern.
 */
const MIN_NIGHTS = 3;
const SLEEP_QUALITY = { Excellent: 90, Good: 72, Fair: 50, Poor: 25 };

const scoreSleep = ({ metrics = [], days, reported, answeredAt } = {}) => {
    const nights = metrics.map((m) => m.sleep?.score).filter((n) => Number.isFinite(n));

    if (nights.length >= MIN_NIGHTS) {
        const mean = nights.reduce((a, b) => a + b, 0) / nights.length;
        const asleep = metrics.map((m) => m.sleep?.asleepMin).filter((n) => Number.isFinite(n));
        const meanHours = asleep.length
            ? (asleep.reduce((a, b) => a + b, 0) / asleep.length / 60).toFixed(1)
            : null;
        return pillar('sleep', 'Sleep', mean,
            meanHours
                ? `${meanHours}h a night across ${nights.length} nights.`
                : `Scored across ${nights.length} nights.`,
            'observed', { nights: nights.length, meanAsleepHours: meanHours });
    }

    if (nights.length) {
        return pillar('sleep', 'Sleep', null,
            `Only ${nights.length} night${nights.length === 1 ? '' : 's'} recorded — ${MIN_NIGHTS} needed.`,
            'none', { nights: nights.length });
    }

    // The assessment persists this as a 1-5 ladder; older records hold the word.
    const claimed = Number.isFinite(Number(reported?.sleepQuality))
        ? ladder1to5(Number(reported.sleepQuality))
        : ladderScore(reported?.sleepQuality, SLEEP_QUALITY);

    if (claimed === null) {
        return pillar('sleep', 'Sleep', null, 'Connect a device to track your sleep.', 'none');
    }
    return pillar('sleep', 'Sleep', claimed,
        'From the sleep answer you gave. Connect a device to score this properly.',
        'reported', { answeredAt });
};

/**
 * Nutrition, from what was actually eaten and how it sat against the person's guidance.
 *
 * Two halves. **Alignment** is the share of assessed meals the analyser called aligned, with
 * a partial worth half — that is the guidance in the plan being followed or not. **Logging**
 * is the share of days in the window carrying any meal at all, because an alignment computed
 * from three meals in a month describes three meals, not a month.
 *
 * `alignment: 'unassessed'` meals are excluded, never counted as failures: it means the
 * person's plan says nothing about diet, and scoring that as zero tells someone they failed
 * at something nobody asked of them.
 */
const scoreNutrition = ({ meals = [], days, reported, answeredAt } = {}) => {
    const assessed = meals.filter((m) => m.analysis && m.analysis.alignment !== 'unassessed');
    const loggedDays = new Set(meals.map((m) => m.day)).size;

    if (assessed.length) {
        const aligned = assessed.filter((m) => m.analysis.alignment === 'aligned').length;
        const partial = assessed.filter((m) => m.analysis.alignment === 'partial').length;
        const alignment = ((aligned + partial * 0.5) / assessed.length) * 100;
        // Capped at 100 so a fortnight of logging is full marks rather than requiring
        // a meal every single day — the guidance is "most days", as it is for activity.
        const logging = Math.min(100, (loggedDays / days) / 0.7 * 100);

        return pillar('nutrition', 'Nutrition', alignment * 0.75 + logging * 0.25,
            `${aligned} of ${assessed.length} assessed meals matched your plan.`,
            'observed', { assessed: assessed.length, aligned, partial, loggedDays });
    }

    if (loggedDays) {
        return pillar('nutrition', 'Nutrition', null,
            'Your plan has no dietary guidance yet, so meals are not scored.', 'none',
            { loggedDays });
    }

    const claimed = ladderScore(reported?.eatingHabits, EATING_HABITS);
    if (claimed === null) {
        return pillar('nutrition', 'Nutrition', null, 'Log a meal to score this.', 'none');
    }
    return pillar('nutrition', 'Nutrition', claimed,
        'From the eating habits you described. Log meals to score this properly.',
        'reported', { answeredAt });
};

const EATING_HABITS = { Excellent: 90, Healthy: 80, Good: 72, Average: 55, Balanced: 70, Poor: 30, Unhealthy: 25 };

/**
 * Medication adherence — doses taken as a share of doses that came due.
 *
 * No reported fallback exists and none should be invented. The assessment's medication list
 * is a free-text snapshot of what someone said they take; it carries no information at all
 * about whether they take it, and a pillar that guessed would be inventing a fact about
 * someone's treatment.
 *
 * Returns null rather than zero when nothing has come due, per `medicationSchedule.adherence`.
 */
const scoreMedication = ({ doses = [], activeCount = 0 } = {}) => {
    if (!activeCount) {
        return pillar('medication', 'Medication', null, 'No medications tracked.', 'none');
    }
    if (!doses.length) {
        return pillar('medication', 'Medication', null,
            'Add a schedule so doses can be tracked.', 'none', { activeCount });
    }

    const a = doseAdherence(doses);
    if (a.score === null) {
        return pillar('medication', 'Medication', null,
            'No doses have come due yet.', 'none', { activeCount });
    }

    // A skipped dose is a decision someone recorded, a missed one is a dose that went
    // unanswered. Both count against adherence, but the detail names the larger of the two
    // so the sentence matches what the person would recognise about their own week.
    return pillar('medication', 'Medication', a.score,
        a.missed >= a.skipped && a.missed > 0
            ? `${a.missed} of ${a.assessed} doses missed.`
            : a.skipped > 0
                ? `${a.skipped} of ${a.assessed} doses skipped.`
                : `All ${a.assessed} doses taken.`,
        'observed', { adherence: a, activeCount });
};

/**
 * Resting heart rate, and HRV where the device reports it.
 *
 * Uses the median resting figure across the window, not the mean: one bad night with a fever
 * drags a mean and does not describe the person. Scored as a curve around a broad healthy
 * band rather than a cliff, for the same reason `scoreBody` is — 59 and 61 bpm are the same
 * heart.
 */
const scoreVitals = ({ metrics = [] } = {}) => {
    const resting = metrics.map((m) => m.heart?.restingBpm).filter((n) => Number.isFinite(n));
    if (resting.length < MIN_NIGHTS) {
        return pillar('vitals', 'Vitals', null,
            resting.length ? 'Not enough resting heart-rate readings yet.' : 'Connect a device to track your heart rate.',
            'none');
    }

    const bpm = median(resting);
    // Full marks across 50-70. Six points per bpm outside it, which reaches zero around
    // 87 bpm resting - high, but not a figure to tell someone is a zero without hedging.
    const distance = bpm < 50 ? 50 - bpm : bpm > 70 ? bpm - 70 : 0;

    return pillar('vitals', 'Vitals', 100 - distance * 6,
        `Resting heart rate ${Math.round(bpm)} bpm.`,
        'observed', { restingBpm: Math.round(bpm), readings: resting.length });
};

/**
 * BMI, from the most recent weight LabTrack holds.
 *
 * `weightSource` decides the provenance: a weight that arrived from a scale or a health store
 * is observed, one typed during onboarding is reported and decays like any other answer.
 * Height is treated as stable — nobody's height is a stale fact — so it never carries
 * provenance of its own.
 *
 * Scored as a curve rather than a cliff: 24.9 and 25.1 are the same person and should not be
 * thirty points apart.
 */
const scoreBody = ({ heightCm, weightKg, weightSource = 'reported', weightAt } = {}) => {
    if (!heightCm || !weightKg) {
        return pillar('body', 'Body', null, 'Add your height and weight.', 'none');
    }
    const bmi = weightKg / (heightCm / 100) ** 2;
    const distance = bmi < 18.5 ? 18.5 - bmi : bmi > 25 ? bmi - 25 : 0;

    return pillar('body', 'Body', 100 - distance * 6,
        `BMI ${bmi.toFixed(1)} — ${bmiLabel(bmi)}.`,
        weightSource === 'observed' ? 'observed' : 'reported',
        { bmi: Math.round(bmi * 10) / 10, weightKg, answeredAt: weightAt });
};

const bmiLabel = (bmi) =>
    bmi < 18.5 ? 'underweight' : bmi < 25 ? 'healthy range' : bmi < 30 ? 'overweight' : 'obese';

/** Plan adherence: what share of what was due has been done rather than left to lapse. */
const scorePlan = (items = []) => {
    const actionable = items.filter((i) => i.status !== 'dismissed');
    if (!actionable.length) {
        return pillar('plan', 'Plan', null, 'No health plan yet.', 'none');
    }
    const now = Date.now();
    const completed = actionable.filter((i) => i.status === 'completed').length;
    const overdue = actionable.filter(
        (i) => i.status !== 'completed' && new Date(i.dueDate).getTime() < now,
    ).length;
    const pending = actionable.length - completed - overdue;

    // Pending items are not failures — they are not due yet — so they score at 0.75 rather
    // than dragging the pillar down for existing.
    return pillar('plan', 'Plan',
        ((completed + pending * 0.75) / actionable.length) * 100,
        overdue ? `${overdue} plan item${overdue === 1 ? '' : 's'} overdue.` : 'Plan is on track.',
        'observed', { completed, overdue, total: actionable.length });
};

/**
 * Mood, from the mood tracker.
 *
 * The only pillar where self-report *is* the measurement — there is no instrument for how
 * someone feels, and a logged mood is a reading taken on the day rather than a claim about
 * a general disposition. So a mood logged inside the window counts as observed, while the
 * onboarding mood answer is reported and decays like the rest.
 */
const MOOD = { Excellent: 100, Happy: 90, Good: 80, Okay: 60, Neutral: 60, Low: 35, Poor: 35, Sad: 30, Bad: 15, Stressed: 30, Anxious: 30 };
const STRESS = { Low: 100, Moderate: 70, High: 40, 'Very High': 15 };

const scoreMind = ({ moodHistory = [], since, reported, answeredAt } = {}) => {
    const recent = moodHistory
        .filter((m) => m?.mood && (!since || new Date(m.date || m.loggedAt || 0) >= since))
        .map((m) => MOOD[m.mood])
        .filter((n) => Number.isFinite(n));

    if (recent.length) {
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        return pillar('mind', 'Mind', mean,
            `From ${recent.length} mood check-in${recent.length === 1 ? '' : 's'}.`,
            'observed', { checkIns: recent.length });
    }

    const parts = [];
    const stress = ladderScore(reported?.stressLevel, STRESS);
    if (stress !== null) parts.push(stress);
    const olderMood = moodHistory.length ? MOOD[moodHistory[moodHistory.length - 1].mood] : null;
    if (Number.isFinite(olderMood)) parts.push(olderMood);

    if (!parts.length) {
        return pillar('mind', 'Mind', null, 'Log how you are feeling to score this.', 'none');
    }
    return pillar('mind', 'Mind', parts.reduce((a, b) => a + b, 0) / parts.length,
        'From the answers you gave. Check in with your mood to score this properly.',
        'reported', { answeredAt });
};

/* ---------------------------- small helpers ---------------------------- */

const ladderScore = (value, table) => {
    if (!value) return null;
    const hit = table[value] ?? table[String(value).trim()];
    return Number.isFinite(hit) ? hit : null;
};

/** The assessment's 1-5 ladders, mapped onto 0-100. */
const ladder1to5 = (n) => (n >= 1 && n <= 5 ? clamp(((n - 1) / 4) * 100) : null);

const median = (nums) => {
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const newestDate = (dates) => {
    const times = dates.map((d) => new Date(d).getTime()).filter((t) => Number.isFinite(t));
    return times.length ? new Date(Math.max(...times)) : null;
};

/* ------------------------------------------------------------------ *
 * Composition
 * ------------------------------------------------------------------ */

/**
 * Below this many scored pillars the mean says more about what is missing than about the
 * person. The old client score used three; this keeps that, but the pillars are now much
 * easier to fill — activity, sleep, nutrition and medication all count — so in practice a
 * person who uses any one tracker for a week clears it.
 */
const MIN_PILLARS = 3;

/** The window every observed pillar is measured over, unless a caller overrides it. */
const DEFAULT_WINDOW_DAYS = 30;

/**
 * Score one person from everything LabTrack holds about them.
 *
 * `input` is what `scoreController.gather()` assembles; every field is optional, and a
 * missing one costs its pillar rather than the score. Pure and synchronous — no database
 * access here, so the whole thing is testable from fixtures and produces the same output for
 * the same input on every call.
 */
const computeScore = (input = {}) => {
    const days = Number.isFinite(input.windowDays) ? input.windowDays : DEFAULT_WINDOW_DAYS;
    const since = new Date(Date.now() - days * DAY_MS);
    const reported = input.assessment?.lifestyle || {};
    const answeredAt = input.assessment?.completedAt || input.assessment?.updatedAt || null;

    const pillars = [
        scoreBiomarkers(input.biomarkers),
        scoreActivity({ series: input.activitySeries, targets: input.activityTargets, days, reported, answeredAt }),
        scoreSleep({ metrics: input.dailyMetrics, days, reported, answeredAt }),
        scoreNutrition({ meals: input.meals, days, reported: input.assessment, answeredAt }),
        scoreMedication({ doses: input.doses, activeCount: input.activeMedicationCount }),
        scoreVitals({ metrics: input.dailyMetrics }),
        scoreBody(input.body || {}),
        scorePlan(input.planItems),
        scoreMind({ moodHistory: input.moodHistory, since, reported, answeredAt }),
    ];

    const scored = pillars.filter((p) => p.value !== null);

    if (scored.length < MIN_PILLARS) {
        return {
            value: null,
            band: null,
            headline: 'Log a day or upload a result to unlock your score',
            pillars,
            coverage: { scored: scored.length, observed: 0, reported: 0, total: pillars.length },
            windowDays: days,
            computedAt: new Date(),
        };
    }

    // Provenance is applied here rather than inside each scorer, so there is exactly one
    // place in the codebase that decides what a questionnaire answer is worth.
    const weighted = scored.map((p) => {
        const base = WEIGHTS[p.key] ?? 1;
        const factor = p.source === 'reported' ? reportedWeightFactor(p.answeredAt || answeredAt) : 1;
        return { pillar: p, weight: base * factor };
    });

    const totalWeight = weighted.reduce((s, w) => s + w.weight, 0);
    const value = clamp(weighted.reduce((s, w) => s + w.pillar.value * w.weight, 0) / totalWeight);
    const band = bandFor(value);

    const observed = scored.filter((p) => p.source === 'observed');
    const reportedCount = scored.length - observed.length;

    const observedWeight = Math.round(
        (weighted.filter((w) => w.pillar.source === 'observed')
            .reduce((s, w) => s + w.weight, 0) / totalWeight) * 100,
    );

    return {
        value,
        band: band?.key ?? null,
        bandLabel: band?.label ?? null,
        headline: headlineFor(value, band, scored, observedWeight),
        pillars,
        coverage: {
            scored: scored.length,
            observed: observed.length,
            reported: reportedCount,
            total: pillars.length,
            /** Share of the weighted total that came from something measured. */
            observedWeight,
        },
        windowDays: days,
        computedAt: new Date(),
    };
};

/**
 * The sentence under the number.
 *
 * Leads with the weakest scored pillar, because the number alone tells nobody what to do
 * next — the same call the old client score made and the one thing about it worth keeping.
 *
 * When most of the number is still running on questionnaire answers it says so instead. The
 * test is the *weighted* share, not a count of pillars: a score can have several observed
 * pillars and still be mostly self-reported, and a person deciding whether to trust this
 * number needs to know when it is describing what they told us rather than what they did.
 */
const MOSTLY_OBSERVED = 50;

const headlineFor = (value, band, scored, observedWeight) => {
    if (observedWeight < MOSTLY_OBSERVED) {
        return 'Mostly based on your answers so far. Connect a device or log a day to make this real.';
    }
    const weakest = [...scored].sort((a, b) => a.value - b.value)[0];
    if (band?.key === 'healthy') {
        return value >= 85
            ? 'You are doing well. Keep it up.'
            : `You are doing well. ${weakest.detail}`;
    }
    return `${weakest.detail} Worth a look.`;
};

/**
 * What changed between two snapshots, for the trend card's delta chip.
 *
 * Compares pillar by pillar rather than only the total, because a flat score hiding sleep
 * falling as activity rose is the case the trend exists to surface.
 */
const diffScores = (current, previous) => {
    if (!current || !previous || current.value === null || previous.value === null) return null;

    const before = new Map(previous.pillars.map((p) => [p.key, p.value]));
    const moved = current.pillars
        .filter((p) => p.value !== null && before.get(p.key) !== null && before.has(p.key))
        .map((p) => ({ key: p.key, label: p.label, delta: p.value - before.get(p.key) }))
        .filter((d) => Math.abs(d.delta) >= 3)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    return {
        delta: current.value - previous.value,
        since: previous.computedAt,
        improved: moved.filter((m) => m.delta > 0),
        declined: moved.filter((m) => m.delta < 0),
    };
};

module.exports = {
    computeScore,
    diffScores,
    bandFor,
    bmiLabel,
    SCORE_DISCLAIMER,
    BANDS,
    WEIGHTS,
    PILLAR_KEYS,
    MIN_PILLARS,
    MOSTLY_OBSERVED,
    DEFAULT_WINDOW_DAYS,
    REPORTED_HALF_LIFE_DAYS,
    REPORTED_CEILING,
    // Exported for the unit tests, which assert each pillar in isolation.
    _scoreBiomarkers: scoreBiomarkers,
    _scoreActivity: scoreActivity,
    _scoreSleep: scoreSleep,
    _scoreNutrition: scoreNutrition,
    _scoreMedication: scoreMedication,
    _scoreVitals: scoreVitals,
    _scoreBody: scoreBody,
    _scorePlan: scorePlan,
    _scoreMind: scoreMind,
    _reportedWeightFactor: reportedWeightFactor,
};
