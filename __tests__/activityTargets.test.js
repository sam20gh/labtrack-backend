/**
 * Activity tracker ↔ health plan.
 *
 * The tracker's reason to exist is that it pushes people towards the exercise advice on
 * their plan. These lock in the link: guidance is derived from PlanItems on every read, a
 * regenerated interpretation moves the targets with it, and a person with no exercise
 * advice is never shown a failing score for advice that was never given.
 *
 * The sibling of `nutritionTargets.test.js`, deliberately — the two features hold the same
 * line and should fail the same way when someone breaks it.
 */
const mongoose = require('mongoose');
const ActivityPlan = require('../models/ActivityPlan');
const ActivitySession = require('../models/ActivitySession');
const PlanItem = require('../models/PlanItem');
const User = require('../models/userModel');
const { _syncGuidance } = require('../controllers/activityController');
const {
    computeTargets, deriveGuidance, explain, CAPS, FLOORS,
} = require('../utils/activityTargets');
const { scoreSession, scoreWindow, bandFor } = require('../utils/activityScore');
const { recomputeDay } = require('../utils/healthSync');

const makeUser = () => User.create({
    username: `u${new mongoose.Types.ObjectId()}`,
    email: `${new mongoose.Types.ObjectId()}@example.com`,
    supabaseId: String(new mongoose.Types.ObjectId()),
    dob: new Date(new Date().getFullYear() - 44, 3, 2).toISOString(),
    gender: 'Male',
    height: 178,
    weight: 84,
    healthAssessment: { lifestyle: { exerciseFrequency: 'Light' } },
});

const exerciseItem = (userId, title, description = 'Because of your results.') => PlanItem.create({
    userId,
    type: 'lifestyle',
    condition: 'exercise',
    title,
    description,
    dueDate: new Date(),
});

describe('syncGuidance — the plan drives the targets', () => {
    it('creates a plan from the exercise advice on the health plan', async () => {
        const user = await makeUser();
        await exerciseItem(user._id, 'Build up to 150 minutes of moderate aerobic activity each week');
        await exerciseItem(user._id, 'Add resistance training twice a week to preserve muscle mass');

        const plan = await _syncGuidance(user._id, null, user.toObject());

        expect(plan).not.toBeNull();
        const keys = plan.guidance.map((g) => g.key);
        expect(keys).toContain('more_aerobic');
        expect(keys).toContain('resistance');
        // The advice has to move something the person can see, or it is decoration
        expect(plan.targets.minutes).toBeGreaterThan(plan.basis.baseMinutes);
        expect(plan.targets.sessions).toBeGreaterThan(plan.basis.baseSessions);
    });

    it('reads "build up to 150 minutes" as both a volume increase and a gradual one', async () => {
        const user = await makeUser();
        await exerciseItem(user._id, 'Build up to 150 minutes of moderate aerobic activity each week');

        const plan = await _syncGuidance(user._id, null, user.toObject());
        const keys = plan.guidance.map((g) => g.key).sort();

        // One directive matching two rules is correct here rather than a false positive:
        // the sentence says both "do more" and "do not jump straight there", and the two
        // shifts partially offset — which is exactly what "build up to" asks for. A rule
        // set where each directive could match only once would have to pick one meaning
        // and drop the other.
        expect(keys).toEqual(['build_gradually', 'more_aerobic']);

        // The two shifts multiply out below 1.0, which on its own would set a target
        // *lower* than where the person already is — directly beneath a sentence telling
        // them to increase. Advice to do more never yields a target to do less.
        expect(plan.targets.minutes).toBeGreaterThanOrEqual(plan.basis.baseMinutes);

        // ...but the gradual half still damps it, so it lands under the volume rule alone
        const volumeOnly = computeTargets({
            user: user.toObject(),
            exerciseItems: [{ _id: new mongoose.Types.ObjectId(), title: 'Increase aerobic exercise' }],
        });
        expect(plan.targets.minutes).toBeLessThan(volumeOnly.targets.minutes);
    });

    it('does not move the targets when the guidance has not changed', async () => {
        const user = await makeUser();
        await exerciseItem(user._id, 'Build up to 150 minutes of moderate aerobic activity each week');

        const first = await _syncGuidance(user._id, null, user.toObject());
        const before = { ...first.targets.toObject() };
        const syncedAt = first.guidanceSyncedAt;

        const again = await _syncGuidance(user._id, await ActivityPlan.findOne({ userId: user._id }), user.toObject());

        // A weekly goal that drifts every time the screen opens is a goal nobody trusts
        expect(again.targets.minutes).toBe(before.minutes);
        expect(again.targets.sessions).toBe(before.sessions);
        expect(again.guidanceSyncedAt).toEqual(syncedAt);
    });

    it('moves the targets when the interpretation changes its advice', async () => {
        const user = await makeUser();
        const gentle = await exerciseItem(user._id, 'Start slow and build up gradually with short walks');

        const first = await _syncGuidance(user._id, null, user.toObject());
        const gentleMinutes = first.targets.minutes;

        await PlanItem.deleteOne({ _id: gentle._id });
        await exerciseItem(user._id, 'Increase physical activity towards 150 minutes of aerobic exercise weekly');

        const second = await _syncGuidance(
            user._id,
            await ActivityPlan.findOne({ userId: user._id }),
            user.toObject()
        );

        expect(second.targets.minutes).toBeGreaterThan(gentleMinutes);
        expect(second.guidance.map((g) => g.key)).toContain('more_aerobic');
    });

    it('carries advice through even when no rule matches it', async () => {
        const user = await makeUser();
        await exerciseItem(user._id, 'Try tai chi with a qualified instructor');

        const plan = await _syncGuidance(user._id, null, user.toObject());

        // A missing rule costs a target shift, never the advice itself
        expect(plan.guidance).toHaveLength(1);
        expect(plan.guidance[0].key).toBe('other');
        expect(plan.guidance[0].directive).toBe('Try tai chi with a qualified instructor');
        expect(plan.targets.minutes).toBe(plan.basis.baseMinutes);
    });

    it('ignores dismissed and completed plan items', async () => {
        const user = await makeUser();
        const item = await exerciseItem(user._id, 'Increase aerobic exercise');
        await PlanItem.updateOne({ _id: item._id }, { $set: { status: 'dismissed' } });

        const plan = await _syncGuidance(user._id, null, user.toObject());
        expect(plan.guidance).toHaveLength(0);
    });
});

describe('computeTargets', () => {
    it('starts someone sedentary somewhere they can actually reach', () => {
        const gentle = computeTargets({ selfRatedLevel: 1 });
        const athletic = computeTargets({ selfRatedLevel: 5 });

        // Handing a sedentary person 150 minutes on day one is a goal card that reads as
        // failure from the moment it appears
        expect(gentle.targets.minutes).toBeLessThan(athletic.targets.minutes);
        expect(gentle.targets.minutes).toBeGreaterThanOrEqual(FLOORS.minutes);
    });

    it('a caution changes what to do, not how much', () => {
        const items = [{ _id: new mongoose.Types.ObjectId(), title: 'Keep to low-impact exercise while that knee settles' }];
        const result = computeTargets({ exerciseItems: items, selfRatedLevel: 3 });
        const base = computeTargets({ selfRatedLevel: 3 });

        expect(result.targets.minutes).toBe(base.targets.minutes);
        const guidance = result.guidance.find((g) => g.key === 'low_impact');
        expect(guidance.avoid).toContain('jogging');
        expect(guidance.favour).toContain('swimming');
    });

    it('caps compounding advice so the target stays reachable', () => {
        const items = [
            'Increase your physical activity',
            'Add resistance training',
            'Break up long periods of sitting',
            'Support weight loss with more exercise',
            'Work on flexibility and balance',
        ].map((title) => ({ _id: new mongoose.Types.ObjectId(), title }));

        const result = computeTargets({ exerciseItems: items, selfRatedLevel: 5 });

        expect(result.targets.minutes).toBeLessThanOrEqual(CAPS.minutes);
        expect(result.targets.sessions).toBeLessThanOrEqual(CAPS.sessions);
    });

    it('keeps a target the person set for themselves', () => {
        const items = [{ _id: new mongoose.Types.ObjectId(), title: 'Increase aerobic exercise' }];
        const result = computeTargets({
            exerciseItems: items,
            selfRatedLevel: 3,
            overrides: { minutes: 90 },
        });

        expect(result.targets.minutes).toBe(90);
        expect(result.basis.method).toBe('user');
        // Overriding one target must not discard the plan-derived value of another
        expect(result.targets.sessions).toBeGreaterThan(0);
    });

    it('rounds minutes to something a person would write down', () => {
        for (const level of [1, 2, 3, 4, 5]) {
            const { targets } = computeTargets({ selfRatedLevel: level });
            expect(targets.minutes % 5).toBe(0);
        }
    });

    it('says plainly when the advice did not move the numbers', () => {
        const items = [{ _id: new mongoose.Types.ObjectId(), title: 'Try tai chi' }];
        const result = computeTargets({ exerciseItems: items });
        const text = explain(result);

        expect(text).toContain('did not change these numbers');
    });
});

describe('activity score', () => {
    it('is null, not zero, when there is no plan to measure against', () => {
        const series = [{ day: '2026-08-20', sessions: 1, exerciseMin: 30 }];
        const result = scoreWindow({ series, days: 7 });

        // Nobody has failed at a target nobody set
        expect(result.value).toBeNull();
        expect(result.progress).toBeNull();
    });

    it('is deterministic', () => {
        const series = [
            { day: '2026-08-18', sessions: 1, exerciseMin: 30, activeKcal: 240, distanceM: 4000 },
            { day: '2026-08-19', sessions: 0, exerciseMin: 0 },
            { day: '2026-08-20', sessions: 2, exerciseMin: 75, activeKcal: 500, distanceM: 9000 },
        ];
        const targets = { sessions: 5, minutes: 150 };

        expect(scoreWindow({ series, targets, days: 7 }).value)
            .toBe(scoreWindow({ series, targets, days: 7 }).value);
    });

    it('rewards meeting a modest plan the same as meeting an ambitious one', () => {
        const week = (min) => Array.from({ length: 7 }, (_, i) => ({
            day: `2026-08-1${i}`, sessions: 1, exerciseMin: min / 7,
        }));

        const gentle = scoreWindow({ series: week(75), targets: { sessions: 7, minutes: 75 }, days: 7 });
        const athletic = scoreWindow({ series: week(210), targets: { sessions: 7, minutes: 210 }, days: 7 });

        // The score measures doing what was asked, not being fit
        expect(gentle.value).toBe(athletic.value);
    });

    it('separates consistency from volume', () => {
        const targets = { sessions: 5, minutes: 150 };
        const spread = Array.from({ length: 7 }, (_, i) => ({ day: `d${i}`, sessions: 1, exerciseMin: 30 }));
        const crammed = [
            { day: 'd0', sessions: 7, exerciseMin: 210 },
            ...Array.from({ length: 6 }, (_, i) => ({ day: `d${i + 1}`, sessions: 0, exerciseMin: 0 })),
        ];

        expect(scoreWindow({ series: spread, targets, days: 7 }).value)
            .toBeGreaterThan(scoreWindow({ series: crammed, targets, days: 7 }).value);
    });

    it('bands carry no clinical words', () => {
        expect(bandFor(95).label).toBe('On track');
        expect(bandFor(10).label).toBe('Behind plan');
        expect(bandFor(null)).toBeNull();
    });
});

describe('session points', () => {
    it('grow with duration and stop', () => {
        expect(scoreSession({ durationSec: 120 })).toBe(0);
        expect(scoreSession({ durationSec: 10 * 60 })).toBe(1);
        expect(scoreSession({ durationSec: 30 * 60 })).toBe(3);
        expect(scoreSession({ durationSec: 3 * 3600 })).toBe(4);
        // A three-hour session is not worth a fortnight of consistency
        expect(scoreSession({ durationSec: 3 * 3600, effort: 5 })).toBe(5);
    });

    it('only bonuses effort the person rated themselves', () => {
        expect(scoreSession({ durationSec: 30 * 60 })).toBe(3);
        expect(scoreSession({ durationSec: 30 * 60, effort: 5 })).toBe(4);
    });

    it('is derived on recompute, so rating effort later updates it', async () => {
        const user = await makeUser();
        const session = await ActivitySession.create({
            userId: user._id,
            type: 'jogging',
            startedAt: new Date('2026-08-20T09:00:00Z'),
            day: '2026-08-20',
            durationSec: 30 * 60,
            source: 'healthkit',
            externalId: 'HK-SCORE-1',
        });

        await recomputeDay(user._id, '2026-08-20');
        expect((await ActivitySession.findById(session._id)).scoreDelta).toBe(3);

        await ActivitySession.updateOne({ _id: session._id }, { $set: { effort: 5 } });
        await recomputeDay(user._id, '2026-08-20');

        expect((await ActivitySession.findById(session._id)).scoreDelta).toBe(4);
    });
});
