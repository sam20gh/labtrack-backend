/**
 * The LabTrack score, and the one guarantee that matters: measurement beats self-report.
 *
 * The previous score read `healthAssessment.lifestyle` and nothing else, so a person could
 * connect a watch, log a month of meals and take every dose without the number moving. These
 * tests are the proof that it moves — and, just as importantly, that a reported answer is
 * *discarded* rather than averaged in once there is something measured to replace it.
 *
 * The other thing under test is the null discipline the whole codebase runs on: a pillar with
 * no data scores `null` and drops out of the mean. It never scores 0, because 0 tells someone
 * they failed at something nobody measured.
 */
const {
    computeScore, diffScores, bandFor, BANDS, MIN_PILLARS,
    _scoreActivity, _scoreSleep, _scoreNutrition, _scoreMedication,
    _scoreVitals, _scoreBody, _scoreMind, _reportedWeightFactor,
} = require('../utils/labtrackScore');

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

/** An assessment claiming excellent health, answered recently so decay is not the reason. */
const CLAIMS_EXCELLENT = {
    completedAt: daysAgo(2),
    lifestyle: { fitnessLevel: 'Advanced', sleepQuality: 5, stressLevel: 'Low' },
};

/** Thirty days of a watch reporting poor sleep and a high resting heart rate. */
const poorMetrics = (n = 20) =>
    Array.from({ length: n }, (_, i) => ({
        day: `2026-08-${String(i + 1).padStart(2, '0')}`,
        sleep: { score: 45, asleepMin: 320 },
        heart: { restingBpm: 82 },
    }));

/** A month of barely any activity, against a normal weekly target. */
const sparseActivity = () =>
    Array.from({ length: 30 }, (_, i) => ({
        day: `d${i}`,
        sessions: i % 10 === 0 ? 1 : 0,
        exerciseMin: i % 10 === 0 ? 20 : null,
    }));

const TARGETS = { sessions: 4, minutes: 150 };

describe('observed beats reported', () => {
    it('uses the questionnaire when nothing has been measured', () => {
        const score = computeScore({
            biomarkers: [{ flag: 'normal' }, { flag: 'normal' }],
            planItems: [{ status: 'pending', dueDate: daysAgo(-30) }],
            body: { heightCm: 180, weightKg: 75, weightSource: 'reported' },
            assessment: CLAIMS_EXCELLENT,
        });

        const activity = score.pillars.find((p) => p.key === 'activity');
        expect(activity.source).toBe('reported');
        expect(activity.value).toBeGreaterThan(70);
        expect(score.coverage.reported).toBeGreaterThan(0);
    });

    it('discards the questionnaire entirely once the same thing is measured', () => {
        const score = computeScore({
            windowDays: 30,
            biomarkers: [{ flag: 'normal' }, { flag: 'normal' }],
            dailyMetrics: poorMetrics(),
            activitySeries: sparseActivity(),
            activityTargets: TARGETS,
            body: { heightCm: 180, weightKg: 75, weightSource: 'observed' },
            assessment: CLAIMS_EXCELLENT,
            moodHistory: [{ mood: 'Okay', date: new Date() }],
        });

        const sleep = score.pillars.find((p) => p.key === 'sleep');
        const activity = score.pillars.find((p) => p.key === 'activity');

        // Not blended with the 5/5 and "Advanced" the person claimed — replaced by them.
        expect(sleep.source).toBe('observed');
        expect(sleep.value).toBe(45);
        expect(activity.source).toBe('observed');
        expect(activity.value).toBeLessThan(50);
        expect(score.coverage.reported).toBe(0);
    });

    it('scores the same person lower once their trackers contradict their answers', () => {
        const base = {
            biomarkers: [{ flag: 'normal' }, { flag: 'normal' }],
            planItems: [{ status: 'pending', dueDate: daysAgo(-30) }],
            body: { heightCm: 180, weightKg: 75, weightSource: 'reported' },
            assessment: CLAIMS_EXCELLENT,
        };
        const claimed = computeScore(base);
        const measured = computeScore({
            ...base,
            windowDays: 30,
            dailyMetrics: poorMetrics(),
            activitySeries: sparseActivity(),
            activityTargets: TARGETS,
        });

        expect(measured.value).toBeLessThan(claimed.value);
    });

    it('weights a stale questionnaire answer below a fresh one', () => {
        expect(_reportedWeightFactor(daysAgo(1)))
            .toBeGreaterThan(_reportedWeightFactor(daysAgo(240)));
    });

    it('never lets a reported pillar outweigh an observed one', () => {
        // A reported pillar tops out at half its base weight even when answered today.
        expect(_reportedWeightFactor(new Date())).toBeLessThanOrEqual(0.5);
    });
});

describe('null, never zero', () => {
    it('does not score a pillar with no data', () => {
        const p = _scoreVitals({ metrics: [] });
        expect(p.value).toBeNull();
        expect(p.source).toBe('none');
    });

    it('returns null for medication when no dose has come due', () => {
        const p = _scoreMedication({
            doses: [{ status: 'scheduled', scheduledFor: daysAgo(-1) }],
            activeMedicationCount: 1,
            activeCount: 1,
        });
        expect(p.value).toBeNull();
    });

    it('does not score unassessed meals as failures', () => {
        const meals = Array.from({ length: 20 }, (_, i) => ({
            day: `d${i % 10}`, calories: 500, analysis: { alignment: 'unassessed' },
        }));
        const p = _scoreNutrition({ meals, days: 30 });
        expect(p.value).toBeNull();
        expect(p.detail).toMatch(/no dietary guidance/i);
    });

    it('refuses to score a sleep window of one or two nights', () => {
        const p = _scoreSleep({ metrics: [{ sleep: { score: 90, asleepMin: 480 } }], days: 30 });
        expect(p.value).toBeNull();
    });

    it('withholds the whole score below the pillar minimum', () => {
        const score = computeScore({ biomarkers: [{ flag: 'normal' }] });
        expect(score.value).toBeNull();
        expect(score.band).toBeNull();
        expect(score.coverage.scored).toBeLessThan(MIN_PILLARS);
    });
});

describe('pillars', () => {
    it('scores activity against the person plan, not raw volume', () => {
        const modest = _scoreActivity({
            series: Array.from({ length: 7 }, () => ({ sessions: 1, exerciseMin: 11 })),
            targets: { sessions: 7, minutes: 75 },
            days: 7,
        });
        const athlete = _scoreActivity({
            series: Array.from({ length: 7 }, () => ({ sessions: 1, exerciseMin: 30 })),
            targets: { sessions: 7, minutes: 210 },
            days: 7,
        });
        // Both hit their own target; neither is rewarded for being fitter than the other.
        expect(Math.abs(modest.value - athlete.value)).toBeLessThanOrEqual(5);
    });

    it('will not score activity when nobody set a target', () => {
        const p = _scoreActivity({
            series: [{ sessions: 2, exerciseMin: 60 }], targets: null, days: 7,
        });
        expect(p.value).toBeNull();
        expect(p.detail).toMatch(/goal/i);
    });

    it('treats a recent mood check-in as observed and an onboarding answer as reported', () => {
        const logged = _scoreMind({
            moodHistory: [{ mood: 'Good', date: new Date() }], since: daysAgo(30),
        });
        expect(logged.source).toBe('observed');

        const claimed = _scoreMind({
            moodHistory: [], since: daysAgo(30), reported: { stressLevel: 'High' },
        });
        expect(claimed.source).toBe('reported');
    });

    it('marks a device-sourced weight observed and an onboarding weight reported', () => {
        expect(_scoreBody({ heightCm: 180, weightKg: 75, weightSource: 'observed' }).source)
            .toBe('observed');
        expect(_scoreBody({ heightCm: 180, weightKg: 75, weightSource: 'reported' }).source)
            .toBe('reported');
    });

    it('scores BMI as a curve, not a cliff', () => {
        const under = _scoreBody({ heightCm: 180, weightKg: 80.9 });   // BMI 24.97
        const over = _scoreBody({ heightCm: 180, weightKg: 81.1 });    // BMI 25.03
        expect(Math.abs(under.value - over.value)).toBeLessThanOrEqual(1);
    });
});

describe('bands and deltas', () => {
    it('covers the whole 0-100 range with no gaps', () => {
        for (let n = 0; n <= 100; n++) expect(bandFor(n)).not.toBeNull();
    });

    it('has no band that claims a person is healthy below the kit threshold', () => {
        expect(bandFor(70).key).not.toBe('healthy');
        expect(bandFor(71).key).toBe('healthy');
    });

    it('names which pillars moved rather than only the total', () => {
        const before = {
            value: 70, computedAt: daysAgo(7),
            pillars: [{ key: 'sleep', label: 'Sleep', value: 80 }, { key: 'activity', label: 'Activity', value: 40 }],
        };
        const after = {
            value: 70, computedAt: new Date(),
            pillars: [{ key: 'sleep', label: 'Sleep', value: 55 }, { key: 'activity', label: 'Activity', value: 70 }],
        };
        const change = diffScores(after, before);

        // The total did not move; the two pillars underneath it moved a lot in opposite
        // directions, and that is the whole reason the trend stores pillars.
        expect(change.delta).toBe(0);
        expect(change.declined.map((d) => d.key)).toContain('sleep');
        expect(change.improved.map((d) => d.key)).toContain('activity');
    });
});

describe('the score says when it is still guesswork', () => {
    it('tells the person the number is based on their answers when nothing is measured', () => {
        const score = computeScore({
            biomarkers: [],
            body: { heightCm: 180, weightKg: 75, weightSource: 'reported' },
            assessment: CLAIMS_EXCELLENT,
        });
        expect(score.coverage.observed).toBe(0);
        expect(score.coverage.observedWeight).toBe(0);
        expect(score.headline).toMatch(/answers/i);
    });

    it('still warns when several pillars are observed but the weight is mostly reported', () => {
        // Two observed pillars, but the heavy ones (activity, sleep, nutrition) are all
        // questionnaire answers — a count of observed pillars would call this measured.
        const score = computeScore({
            planItems: [{ status: 'pending', dueDate: daysAgo(-30) }],
            body: { heightCm: 180, weightKg: 75, weightSource: 'reported' },
            assessment: CLAIMS_EXCELLENT,
            moodHistory: [],
        });
        expect(score.coverage.observed).toBeGreaterThan(0);
        expect(score.coverage.observedWeight).toBeLessThan(50);
        expect(score.headline).toMatch(/answers/i);
    });

    it('reports what share of the score came from measurement', () => {
        const score = computeScore({
            windowDays: 30,
            biomarkers: [{ flag: 'normal' }, { flag: 'normal' }],
            dailyMetrics: poorMetrics(),
            activitySeries: sparseActivity(),
            activityTargets: TARGETS,
            body: { heightCm: 180, weightKg: 75, weightSource: 'observed' },
            assessment: CLAIMS_EXCELLENT,
            moodHistory: [{ mood: 'Okay', date: new Date() }],
        });
        expect(score.coverage.observedWeight).toBe(100);
    });
});
