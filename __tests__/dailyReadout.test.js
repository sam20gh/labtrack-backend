/**
 * The daily readout — Sleep, Recovery, Effort — and the effort minutes behind it.
 *
 * What has to hold:
 *   - Effort is guideline minutes: moderate counts 1, vigorous 2, and nothing is counted twice.
 *   - The record's span is read from the data, not assumed.
 *   - Null, never zero: an unmeasured day has no effort and no recovery.
 *   - Recovery is judged against the person's own usual, and claims nothing before five days.
 *   - Night temperature only ever lowers recovery.
 *   - An urgent vital alert holds the readout's sentence.
 *   - The sentence never names a condition or says how somebody feels.
 */
const mongoose = require('mongoose');
const effort = require('../utils/effort');
const readout = require('../utils/dailyReadout');

const MIN = 60000;
const T0 = Date.parse('2026-10-12T07:00:00Z');

/** A stream of 15-minute records, each fifteen readings at one bpm. */
const streamOf = (bpms, spanMin = 15) => Object.fromEntries(
    bpms.map((bpm, i) => [String(T0 + i * spanMin * MIN), [15, 15 * bpm, bpm, bpm]]),
);

describe('effort minutes', () => {
    const maxHr = 180;

    test('reads the record span from the gaps between records', () => {
        expect(effort.recordMinutes([0, 15 * MIN, 30 * MIN])).toBe(15);
        expect(effort.recordMinutes([0, 5 * MIN, 10 * MIN, 15 * MIN])).toBe(5);
        expect(effort.recordMinutes([0])).toBe(effort.DEFAULT_RECORD_MIN);
        // An hour off the wrist is a gap, not a record length.
        expect(effort.recordMinutes([0, 15 * MIN, 30 * MIN, 200 * MIN])).toBe(15);
    });

    test('moderate counts once, vigorous twice, light not at all', () => {
        // 90 = 50% (light), 120 = 67% (moderate), 145 = 81% (vigorous)
        const day = effort.effortForDay({ blocks: streamOf([90, 120, 145]), maxHr });
        expect(day.moderateMin).toBe(15);
        expect(day.vigorousMin).toBe(15);
        expect(day.effortMin).toBe(45);
        expect(day.source).toBe('stream');
    });

    test('fills the five zones, zone 4 and 5 being what Predyqt Age reads as vigorous', () => {
        const day = effort.effortForDay({ blocks: streamOf([90, 120, 145, 170]), maxHr });
        expect(day.zoneMinutes).toEqual([15, 15, 0, 15, 15]);
    });

    test('a record with half its readings counts half its span', () => {
        const blocks = streamOf([120, 120]);
        blocks[String(T0)] = [7, 7 * 120, 120, 120];
        const day = effort.effortForDay({ blocks, maxHr });
        expect(day.moderateMin).toBe(22);
    });

    test('a worn band with nothing above light is a measured zero, not null', () => {
        const day = effort.effortForDay({ blocks: streamOf([70, 80]), maxHr });
        expect(day.effortMin).toBe(0);
    });

    test('nothing measured is null', () => {
        const day = effort.effortForDay({ blocks: null, sessions: [], maxHr });
        expect(day.effortMin).toBeNull();
        expect(day.source).toBeNull();
    });

    test('a workout the stream covered is not counted twice', () => {
        const session = {
            type: 'jogging', startedAt: new Date(T0), endedAt: new Date(T0 + 30 * MIN), durationSec: 1800,
        };
        const day = effort.effortForDay({ blocks: streamOf([145, 145]), sessions: [session], maxHr });
        expect(day.effortMin).toBe(60);
        expect(day.breakdown.bandMin).toBe(0);
        expect(day.breakdown.sessions[0]).toMatchObject({ basis: 'band', effortMin: 60 });
    });

    /**
     * 2026-10-11, the real day that found this: a 30-minute swim logged by hand, the bracelet on
     * the wrist reading 75–103 bpm throughout (42–57% of 179). The swim was dropped as "covered by
     * the stream" and the day read 4 effort minutes. The person's rating decides a workout the
     * band also saw, and the band is never the evidence in water.
     */
    describe('a swim logged by hand with the band on', () => {
        const swimStart = T0 + 120 * MIN;
        const wristInWater = Object.fromEntries(Array.from({ length: 24 }, (_, i) =>
            [String(swimStart + i * 75000), [15, 15 * 85, 75, 103]]));
        const swim = (effortRating) => ({
            _id: 'swim', type: 'swimming', startedAt: new Date(swimStart), durationSec: 1800,
            ...(effortRating ? { effort: effortRating } : {}),
        });

        test('rated Moderate, it counts 30 whatever the wrist read', () => {
            const day = effort.effortForDay({ blocks: wristInWater, sessions: [swim(3)], maxHr: 179 });
            expect(day.effortMin).toBe(30);
            expect(day.breakdown.sessions[0]).toMatchObject({ basis: 'rating', intensity: 'moderate', effortMin: 30 });
        });

        test('rated Light, it is shown and not counted — the app labels 2 "Light"', () => {
            const day = effort.effortForDay({ blocks: wristInWater, sessions: [swim(2)], maxHr: 179 });
            expect(day.effortMin).toBe(0);
            expect(day.breakdown.sessions[0]).toMatchObject({ basis: 'rating', intensity: 'light', effortMin: 0 });
        });

        test('unrated, the type decides, never the wrist underwater', () => {
            const day = effort.effortForDay({ blocks: wristInWater, sessions: [swim(null)], maxHr: 179 });
            expect(day.breakdown.sessions[0]).toMatchObject({ basis: 'type', intensity: 'moderate', effortMin: 30 });
        });

        test("the band's minutes inside the swim are not counted again outside it", () => {
            const hard = Object.fromEntries(Object.keys(wristInWater).map((k) => [k, [15, 15 * 150, 150, 150]]));
            const day = effort.effortForDay({ blocks: hard, sessions: [swim(3)], maxHr: 179 });
            expect(day.breakdown.bandMin).toBe(0);
            expect(day.effortMin).toBe(30);
        });
    });

    test('the rating scale is the log form\'s: 1–2 light, 3 moderate, 4–5 vigorous', () => {
        const at = (h) => new Date(T0 + h * 60 * MIN);
        const rated = (r, h) => ({ type: 'walking', startedAt: at(h), durationSec: 600, effort: r });
        const day = effort.effortForDay({
            sessions: [rated(1, 1), rated(2, 2), rated(3, 3), rated(4, 4), rated(5, 5)], maxHr,
        });
        expect(day.breakdown.sessions.map((x) => x.intensity))
            .toEqual(['light', 'light', 'moderate', 'vigorous', 'vigorous']);
        expect(day.effortMin).toBe(10 + 20 + 20);
    });

    test('a workout outside the stream counts by heart rate, then rating, then type', () => {
        const at = (h) => new Date(T0 + h * 60 * MIN);
        const sessions = [
            { type: 'walking', startedAt: at(5), durationSec: 1800, avgBpm: 125 },  // moderate by HR
            { type: 'walking', startedAt: at(6), durationSec: 1200, effort: 5 },    // vigorous by rating (Maximum)
            { type: 'yoga', startedAt: at(7), durationSec: 3600 },                  // not counted
            { type: 'swimming', startedAt: at(8), durationSec: 600 },               // moderate by type
        ];
        const day = effort.effortForDay({ blocks: streamOf([60]), sessions, maxHr });
        expect(day.moderateMin).toBe(40);
        expect(day.vigorousMin).toBe(20);
        expect(day.source).toBe('both');
    });

    test('without a birth date the stream is not read, and the day says why', () => {
        const day = effort.effortForDay({
            blocks: streamOf([145]),
            sessions: [{ type: 'jogging', startedAt: new Date(T0 + 600 * MIN), durationSec: 600 }],
            maxHr: null,
        });
        expect(day.vigorousMin).toBe(10);
        expect(day.zoneMinutes).toBeNull();
        expect(day.note).toBe('needs_age');
    });

    test('maximum heart rate is Tanaka, and null without an age', () => {
        expect(effort.maxHrFromAge(40)).toBe(180);
        expect(effort.maxHrFromAge(null)).toBeNull();
    });
});

/** Days before `today`, as `YYYY-MM-DD`. */
const TODAY = '2026-10-12'; // a Monday
const ago = (n, from = TODAY) => new Date(Date.parse(`${from}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);

/** Twenty usual days at HRV 50 / resting 58, then today. */
const history = (todayRow, { days = 20, hrv = 50, resting = 58, temp = null } = {}) => [
    ...Array.from({ length: days }, (_, i) => ({
        day: ago(days - i),
        heart: { hrvMs: hrv, restingBpm: resting },
        ...(temp != null ? { temperature: { wristSleepMedian: temp } } : {}),
    })),
    { day: TODAY, ...todayRow },
];

describe('recovery', () => {
    test('claims nothing before five earlier days exist', () => {
        const rows = history({ heart: { hrvMs: 50, restingBpm: 58 } }, { days: 3 });
        const r = readout.recoveryFor(rows, TODAY);
        expect(r.score).toBeNull();
        expect(r.state).toBe('learning');
        expect(r.learning).toEqual({ have: 3, need: 5 });
    });

    test('no heart signal today is no recovery at all', () => {
        expect(readout.recoveryFor(history({ sleep: { score: 80 } }), TODAY)).toBeNull();
    });

    test('a usual day with a good night reads Steady', () => {
        const r = readout.recoveryFor(history({ heart: { hrvMs: 50, restingBpm: 58 }, sleep: { score: 80 } }), TODAY);
        expect(r.state).toBe('steady');
        expect(r.score).toBeGreaterThanOrEqual(60);
    });

    test('HRV up and resting heart rate down reads Recharged', () => {
        const r = readout.recoveryFor(history({ heart: { hrvMs: 62, restingBpm: 54 }, sleep: { score: 88 } }), TODAY);
        expect(r.state).toBe('recharged');
    });

    test('HRV down and resting heart rate up reads Take it easier', () => {
        const r = readout.recoveryFor(history({ heart: { hrvMs: 36, restingBpm: 66 }, sleep: { score: 55 } }), TODAY);
        expect(r.state).toBe('low');
        expect(r.label).toBe('Take it easier');
    });

    test("today is not part of its own usual", () => {
        const rows = history({ heart: { hrvMs: 90, restingBpm: 58 } });
        const hrv = readout.recoveryFor(rows, TODAY).signals.find((s) => s.key === 'hrv');
        expect(hrv.usual).toBe(50);
    });

    test('one weighted signal is not a score', () => {
        const rows = history({ heart: { hrvMs: 50 } }).map((r) => ({ ...r, heart: { hrvMs: r.heart.hrvMs } }));
        const r = readout.recoveryFor(rows, TODAY);
        expect(r.score).toBeNull();
        expect(r.state).toBe('insufficient');
    });

    test('a warm night lowers the score and a cool one does not raise it', () => {
        const base = { heart: { hrvMs: 50, restingBpm: 58 }, sleep: { score: 80 } };
        const plain = readout.recoveryFor(history(base, { temp: 34 }), TODAY).score;
        const warm = readout.recoveryFor(history({ ...base, temperature: { wristSleepMedian: 34.9 } }, { temp: 34 }), TODAY).score;
        const cool = readout.recoveryFor(history({ ...base, temperature: { wristSleepMedian: 33.2 } }, { temp: 34 }), TODAY).score;
        expect(warm).toBeLessThan(plain);
        expect(cool).toBe(plain);
    });
});

describe('effort target', () => {
    const effortRows = (todayMin, before = []) => [
        ...before.map(([n, min]) => ({ day: ago(n), activity: { effortMin: min } })),
        { day: TODAY, activity: { effortMin: todayMin } },
    ];

    test('spreads the week over the days left, scaled by recovery', () => {
        // Monday, nothing done: 150 / 7 ≈ 21 → 20; 1.5× → 30; 0.5× → 10.
        expect(readout.effortFor(effortRows(0), TODAY, 'steady').target).toBe(20);
        expect(readout.effortFor(effortRows(0), TODAY, 'recharged').target).toBe(30);
        expect(readout.effortFor(effortRows(0), TODAY, 'low').target).toBe(10);
    });

    test('counts only this week, and today towards it', () => {
        const sunday = '2026-10-18';
        const rows = [
            { day: '2026-10-11', activity: { effortMin: 500 } }, // last week
            { day: '2026-10-14', activity: { effortMin: 40 } },
            { day: sunday, activity: { effortMin: 15 } },
        ];
        const e = readout.effortFor(rows, sunday, 'steady');
        expect(e.weekMinutes).toBe(55);
        // 110 left on the last day of the week is capped.
        expect(e.target).toBe(60);
    });

    test('a finished week still asks for some movement', () => {
        const rows = [
            { day: '2026-10-12', activity: { effortMin: 200 } },
            { day: '2026-10-13', activity: { effortMin: 0 } },
        ];
        const e = readout.effortFor(rows, '2026-10-13', 'steady');
        expect(e.targetReason).toBe('week_done');
        expect(e.target).toBeGreaterThanOrEqual(10);
    });
});

describe('the readout', () => {
    test('nothing to say about any ring is no readout', () => {
        const r = readout.buildReadout({ rows: [], today: TODAY, hour: 8 });
        expect(r.live).toBe(false);
        expect(r.sleep).toBeNull();
        expect(r.recovery).toBeNull();
        expect(r.effort.minutes).toBeNull();
    });

    test('an urgent vital alert holds the sentence', () => {
        const rows = history({ heart: { hrvMs: 62, restingBpm: 54 }, sleep: { score: 88 } });
        const r = readout.buildReadout({ rows, today: TODAY, hour: 8, urgentAlert: true });
        expect(r.recovery.held).toBe(true);
        expect(r.sentence).toMatch(/notifications/);
    });

    test('the morning names the signal that moved', () => {
        const rows = history({ heart: { hrvMs: 50, restingBpm: 64 }, sleep: { score: 85 }, activity: { effortMin: 0 } });
        const r = readout.buildReadout({ rows, today: TODAY, hour: 7 });
        expect(r.sentence).toMatch(/^You slept well, but your resting heart rate is 6 bpm above your usual\./);
    });

    test('the afternoon leads with effort', () => {
        const rows = history({ heart: { hrvMs: 50, restingBpm: 58 }, activity: { effortMin: 25 } });
        const r = readout.buildReadout({ rows, today: TODAY, hour: 18 });
        expect(r.sentence).toMatch(/^You've reached today's 20 effort minutes\./);
    });

    test('no sentence names a condition or a feeling', () => {
        const banned = /stress|insomni|diagnos|ill|sick|infection|tired|exhaust|danger|critical/i;
        const todays = [
            { heart: { hrvMs: 62, restingBpm: 54 }, sleep: { score: 88 } },
            { heart: { hrvMs: 50, restingBpm: 58 }, sleep: { score: 70 } },
            { heart: { hrvMs: 36, restingBpm: 66 }, sleep: { score: 40 } },
            { heart: { hrvMs: 36, restingBpm: 66 } },
            { sleep: { score: 50 } },
        ];
        for (const t of todays) {
            for (const hour of [6, 11, 13, 22]) {
                for (const urgentAlert of [false, true]) {
                    const { sentence } = readout.buildReadout({ rows: history(t), today: TODAY, hour, urgentAlert });
                    expect(sentence).not.toMatch(banned);
                    expect(sentence.length).toBeLessThanOrEqual(160);
                }
            }
        }
    });
});

describe('the recovery screen', () => {
    test('reasons are measurements, never causes', () => {
        const r = readout.recoveryFor(history({
            heart: { hrvMs: 36, restingBpm: 66 }, sleep: { score: 50 }, temperature: { wristSleepMedian: 34.8 },
        }, { temp: 34 }), TODAY);
        expect(readout.reasonsFor(r)).toEqual([
            'Your heart rate variability is lower than usual.',
            'Your resting heart rate is 8 bpm above your usual.',
            "Last night's sleep scored 50.",
            'Your wrist was 0.8 °C warmer than usual overnight.',
        ]);
    });

    test('a near-usual day says so', () => {
        const r = readout.recoveryFor(history({ heart: { hrvMs: 50, restingBpm: 58 }, sleep: { score: 80 } }), TODAY);
        expect(readout.reasonsFor(r)).toEqual(['Everything measured is near your usual.']);
    });

    test('the trend judges each day against its own usual, with gaps as null', () => {
        const rows = history({ heart: { hrvMs: 50, restingBpm: 58 }, sleep: { score: 80 } })
            .filter((r) => r.day !== ago(2));
        const trend = readout.recoveryTrend(rows, TODAY, 7);
        expect(trend).toHaveLength(7);
        expect(trend[6].day).toBe(TODAY);
        expect(trend[4].score).toBeNull();
        expect(trend[6].score).not.toBeNull();
    });
});

describe('fuel', () => {
    const plan = (guidance = []) => ({ targets: { calories: 2100, protein: 120 }, guidance, mealsPerDay: 3 });
    const meal = (over = {}) => ({ calories: 600, protein: 25, carbs: 70, fat: 20, eatenAt: new Date(T0), ...over });
    const dietAdvice = [{ key: 'mediterranean', kind: 'pattern', label: 'Mediterranean', directive: 'Eat more fish' }];

    test('nothing set up and nothing logged is no fuel at all', () => {
        expect(readout.fuelFor({ meals: [], plan: null, today: TODAY })).toBeNull();
    });

    test('draws the nutrition dashboard\'s own totals', () => {
        const f = readout.fuelFor({ meals: [meal(), meal({ calories: 640 })], plan: plan(), today: TODAY });
        expect(f).toMatchObject({ meals: 2, calories: 1240, target: 2100, protein: 50, proteinTarget: 120 });
    });

    test('never says "on plan" when the plan has no diet advice', () => {
        const aligned = meal({ analysis: { alignment: 'aligned' } });
        expect(readout.fuelFor({ meals: [aligned], plan: plan(), today: TODAY }).onPlan).toBeNull();
        expect(readout.fuelFor({ meals: [aligned], plan: plan(dietAdvice), today: TODAY }).onPlan)
            .toMatchObject({ assessed: 1, aligned: 1 });
    });

    test('fuel alone earns the readout, because it is the only nutrition on home', () => {
        const r = readout.buildReadout({ rows: [], today: TODAY, meals: [meal()], nutritionPlan: plan() });
        expect(r.live).toBe(true);
        expect(r.sleep).toBeNull();
    });

    describe('the allowance for a harder day than usual', () => {
        const days = (todayMod, usualMod = 20) => [
            ...Array.from({ length: 10 }, (_, i) => ({ day: ago(10 - i), activity: { effortMin: usualMod, moderateMin: usualMod, vigorousMin: 0 } })),
            { day: TODAY, activity: { effortMin: todayMod, moderateMin: todayMod, vigorousMin: 0 } },
        ];

        test('is the energy above the usual day, not all of today\'s', () => {
            // 60 moderate vs a usual 20, at 75 kg: 40 × 4.59 kcal ≈ 180.
            expect(readout.allowanceFor(days(60), TODAY, 75)).toBe(180);
        });

        test('never goes negative: a quiet day is not a reason to eat less', () => {
            expect(readout.allowanceFor(days(0), TODAY, 75)).toBeNull();
        });

        test('needs a weight and five earlier days', () => {
            expect(readout.allowanceFor(days(60), TODAY, null)).toBeNull();
            expect(readout.allowanceFor(days(60).slice(-4), TODAY, 75)).toBeNull();
        });

        test('is capped', () => {
            expect(readout.allowanceFor(days(400), TODAY, 90)).toBe(600);
        });
    });

    describe('the evening gap', () => {
        const f = (over = {}) => ({ hasGuidance: true, meals: 2, protein: 50, proteinTarget: 120, ...over });

        test('names protein short of the plan, in the evening, with two meals in', () => {
            expect(readout.fuelGapFor(f(), 19)).toBe("Today's meals have 50 g of protein; your plan's target is 120 g.");
        });

        test('says nothing in the morning, with one meal, or with no diet advice', () => {
            expect(readout.fuelGapFor(f(), 10)).toBeNull();
            expect(readout.fuelGapFor(f({ meals: 1 }), 19)).toBeNull();
            expect(readout.fuelGapFor(f({ hasGuidance: false }), 19)).toBeNull();
        });

        test('replaces the week\'s tally in the evening sentence', () => {
            const rows = history({ heart: { hrvMs: 50, restingBpm: 58 }, activity: { effortMin: 25 } });
            const r = readout.buildReadout({
                rows, today: TODAY, hour: 19, nutritionPlan: plan(dietAdvice), meals: [meal(), meal()],
            });
            expect(r.sentence).toBe("You've reached today's 20 effort minutes. Today's meals have 50 g of protein; your plan's target is 120 g.");
        });
    });

    describe('a meal before bed, on the Recovery screen', () => {
        const sleepStart = Date.parse('2026-10-11T22:30:00Z');

        test('names the latest meal within two hours, in the person\'s clock', () => {
            const meals = [
                { eatenAt: new Date(sleepStart - 150 * MIN) },
                { eatenAt: new Date(sleepStart - 50 * MIN) },
            ];
            expect(readout.lateMealFor(meals, sleepStart, -60)).toEqual({ clock: '22:40', minutesBefore: 50 });
        });

        test('ignores a meal three hours before, or after sleep began', () => {
            expect(readout.lateMealFor([{ eatenAt: new Date(sleepStart - 180 * MIN) }], sleepStart, 0)).toBeNull();
            expect(readout.lateMealFor([{ eatenAt: new Date(sleepStart + 10 * MIN) }], sleepStart, 0)).toBeNull();
        });

        test('is stated as a fact beside the signals, never as the cause', () => {
            const r = readout.recoveryFor(history({ heart: { hrvMs: 50, restingBpm: 58 }, sleep: { score: 80 } }), TODAY);
            expect(readout.reasonsFor(r, { lateMeal: { clock: '22:40', minutesBefore: 50 } })).toEqual([
                'Everything measured is near your usual.',
                'You logged a meal at 22:40, 50 minutes before your sleep began.',
            ]);
            expect(readout.reasonsFor(r, { lateMeal: { clock: '21:30', minutesBefore: 90 } })[1])
                .toBe('You logged a meal at 21:30, 1.5 hours before your sleep began.');
            expect(readout.reasonsFor(r, { lateMeal: { clock: '21:30', minutesBefore: 60 } })[1])
                .toBe('You logged a meal at 21:30, an hour before your sleep began.');
        });
    });
});

describe('wiring', () => {
    const DailyMetrics = require('../models/DailyMetrics');
    const HeartStream = require('../models/HeartStream');
    const User = require('../models/userModel');
    const { recomputeDay } = require('../utils/healthSync');
    const controller = require('../controllers/readoutController');

    const mockRes = () => {
        const res = {};
        res.status = jest.fn().mockReturnValue(res);
        res.json = jest.fn().mockReturnValue(res);
        return res;
    };

    let userId;
    beforeEach(async () => {
        userId = new mongoose.Types.ObjectId();
        const dob = `${new Date().getUTCFullYear() - 40}-01-01`;
        await User.create({ _id: userId, username: `u${userId}`, email: `${userId}@example.com`, password: 'x', dob });
    });

    test('recomputeDay writes effort and zones from the stream', async () => {
        const day = '2026-10-12';
        await HeartStream.create({ userId, day, blocks: streamOf([120, 150]) });
        await recomputeDay(userId, day);
        const row = await DailyMetrics.findOne({ userId, day }).lean();
        expect(row.activity.effortMin).toBe(45);
        expect(row.activity.effortSource).toBe('stream');
        expect(row.heart.zoneMinutes).toHaveLength(5);
    });

    test('the endpoint answers, and fills effort on a day rolled up before it existed', async () => {
        const today = new Date().toISOString().slice(0, 10);
        await DailyMetrics.create({ userId, day: today, sleep: { asleepMin: 450, score: 82 } });
        const res = mockRes();
        await controller.getReadout({ auth: { userId: String(userId) }, query: { tzOffset: '0' } }, res);
        const body = res.json.mock.calls[0][0];
        expect(body.day).toBe(today);
        expect(body.live).toBe(true);
        expect(body.sleep.score).toBe(82);
        const row = await DailyMetrics.findOne({ userId, day: today }).lean();
        expect(row.activity).toHaveProperty('effortMin', null);
        expect(row.activity.effortVersion).toBe(effort.EFFORT_VERSION);
    });
});
