/**
 * Pace of aging, and the levers.
 *
 * Two features that are really one idea: the rate the number is moving at, and what would
 * change it. Both are arithmetic over things already computed, and both have a failure mode
 * that produces a confident, plausible, wrong answer rather than an error.
 *
 * The pace's is **1.0x**, which reads as "you are aging normally" — a reassurance — and is
 * what a naive implementation returns for somebody about whom nothing is known.
 */
const mongoose = require('mongoose');
const User = require('../models/userModel');
const DailyMetrics = require('../models/DailyMetrics');
const Biomarker = require('../models/Biomarker');
const BiologicalAge = require('../models/BiologicalAge');
const bio = require('../utils/biologicalAge');
const lifestyleTable = require('../utils/lifestyleAge');
const { forecast } = require('../utils/predictionForecast');
const ageController = require('../controllers/ageController');

const DAY_MS = 86400000;
let userId;

const mockRes = () => {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (p) => { res.body = p; return res; };
    return res;
};
const call = async (handler, query = {}) => {
    const res = mockRes();
    await handler({ auth: { userId }, query, body: {} }, res);
    return res;
};

/**
 * A snapshot series whose behavioural gap **opens** by `gapPerYear` years per calendar year.
 *
 * Positive opens the gap, so the expected pace is `1 + gapPerYear`; negative closes it. The
 * sign is stated because it is easy to get backwards, and a fixture with an inverted sign
 * makes every pace assertion pass against the wrong behaviour.
 *
 * Both halves are written, because `paceFrom` prefers the behavioural one and a fixture that
 * only filled the blended field would exercise the fallback instead of the real path.
 */
const seedSeries = ({ count = 8, everyDays = 14, startDelta = 5, gapPerYear = 0 }) => {
    const rows = [];
    for (let i = 0; i < count; i += 1) {
        const daysAgo = (count - 1 - i) * everyDays;
        const delta = startDelta - (gapPerYear * daysAgo) / 365.2425;
        rows.push({
            userId,
            value: 45 + delta,
            chronologicalAge: 45,
            delta,
            source: 'lifestyle',
            halves: [{ source: 'lifestyle', ok: true, value: 45 + delta, delta }],
            computedAt: new Date(Date.now() - daysAgo * DAY_MS),
        });
    }
    return BiologicalAge.insertMany(rows);
};

beforeEach(async () => {
    userId = new mongoose.Types.ObjectId();
    await User.create({
        _id: userId, username: `u${userId}`, email: `${userId}@e.com`, password: 'x',
        dob: new Date(Date.now() - 45 * 365.2425 * DAY_MS).toISOString().slice(0, 10),
        gender: 'Male', height: 178,
    });
});

describe('the pace is never a reassurance by default', () => {
    it('refuses rather than returning 1.0x when there is no series', async () => {
        // The failure this whole file exists for. "1.0x — aging normally" told to somebody
        // about whom nothing is known is worse than a missing number, because it is a claim
        // the person will believe.
        const pace = bio.paceFrom([], { forecast });
        expect(pace.ok).toBe(false);
        expect(pace.state).toBe('unknown');
        expect(pace.value).toBeUndefined();
    });

    it('refuses on too few snapshots, and says how many it needs', async () => {
        await seedSeries({ count: 3 });
        const rows = await BiologicalAge.find({ userId }).lean();
        const pace = bio.paceFrom(rows, { forecast });

        expect(pace.reason).toBe('too_few');
        expect(pace.need).toBe(bio.PACE_MIN_SNAPSHOTS);
    });

    it('refuses on a series that is dense but short', async () => {
        // Eight readings over a fortnight is not eight weeks of evidence.
        await seedSeries({ count: 8, everyDays: 2 });
        const rows = await BiologicalAge.find({ userId }).lean();
        const pace = bio.paceFrom(rows, { forecast });

        expect(pace.reason).toBe('too_short');
        expect(pace.need).toBe(bio.PACE_MIN_SPAN_DAYS);
    });
});

describe('the pace arithmetic', () => {
    it('reads exactly 1.0x for somebody whose gap is not moving', async () => {
        /**
         * The assertion that pins the choice of series. Fitted to `value` instead of `delta`
         * this comes out near but not at 1.0 — the lifestyle half drifts at exactly one year
         * per year and PhenoAge at about 0.89 — and the difference would look like a finding
         * about somebody's health rather than an artefact of which column was regressed.
         */
        await seedSeries({ count: 8, gapPerYear: 0 });
        const rows = await BiologicalAge.find({ userId }).lean();
        const pace = bio.paceFrom(rows, { forecast });

        expect(pace.ok).toBe(true);
        expect(pace.state).toBe('measured');
        expect(pace.value).toBe(1);
    });

    it('reads below 1.0x for somebody closing the gap', async () => {
        await seedSeries({ count: 8, startDelta: 6, gapPerYear: -0.5 });
        const rows = await BiologicalAge.find({ userId }).lean();
        const pace = bio.paceFrom(rows, { forecast });

        expect(pace.value).toBeCloseTo(0.5, 1);
    });

    it('reads above 1.0x for somebody opening it', async () => {
        await seedSeries({ count: 8, startDelta: 2, gapPerYear: 0.6 });
        const rows = await BiologicalAge.find({ userId }).lean();
        const pace = bio.paceFrom(rows, { forecast });

        expect(pace.value).toBeCloseTo(1.6, 1);
    });

    it('bounds the scale and says when it bound it', async () => {
        await seedSeries({ count: 8, startDelta: 1, gapPerYear: 8 });
        const rows = await BiologicalAge.find({ userId }).lean();
        const pace = bio.paceFrom(rows, { forecast });

        expect(pace.value).toBe(bio.PACE_BOUNDS[1]);
        expect(pace.clamped).toBe(true);
    });
});

describe('which series the pace is fitted to', () => {
    it('prefers the behavioural half, because the blended one moves in steps', async () => {
        await seedSeries({ count: 8, gapPerYear: 0 });
        const rows = await BiologicalAge.find({ userId }).lean();

        expect(bio.paceFrom(rows, { forecast }).basis.half).toBe('lifestyle');
    });

    it('falls back to the blended series for somebody whose evidence is bloods alone', async () => {
        const rows = [];
        for (let i = 0; i < 8; i += 1) {
            rows.push({
                userId, value: 50, chronologicalAge: 45, delta: 5, source: 'lab',
                halves: [{ source: 'lab', ok: true, value: 50, delta: 5 }],
                computedAt: new Date(Date.now() - (7 - i) * 14 * DAY_MS),
            });
        }
        await BiologicalAge.insertMany(rows);
        const stored = await BiologicalAge.find({ userId }).lean();

        expect(bio.paceFrom(stored, { forecast }).basis.half).toBe('blended');
    });

    it('is not dragged to the bound by a single panel step', async () => {
        /**
         * The reason the preference exists. A blended delta jumping from +2 to +6 on the day
         * a new panel lands fits to roughly ten years per year and clamps to the top of the
         * scale — which is not somebody aging three times over, it is two noisy measurements
         * four months apart being read as a trajectory. The behavioural half has no steps.
         */
        const rows = [];
        for (let i = 0; i < 8; i += 1) {
            const labDelta = i < 4 ? 2 : 6;          // the step
            rows.push({
                userId,
                value: 45 + (labDelta + 3) / 2,
                chronologicalAge: 45,
                delta: (labDelta + 3) / 2,           // blended: carries the step
                source: 'blended',
                halves: [
                    { source: 'lab', ok: true, delta: labDelta },
                    { source: 'lifestyle', ok: true, delta: 3 },   // flat, genuinely
                ],
                computedAt: new Date(Date.now() - (7 - i) * 14 * DAY_MS),
            });
        }
        await BiologicalAge.insertMany(rows);
        const stored = await BiologicalAge.find({ userId }).lean();
        const pace = bio.paceFrom(stored, { forecast });

        expect(pace.basis.half).toBe('lifestyle');
        expect(pace.value).toBe(1);
        expect(pace.clamped).toBe(false);
    });
});

describe('the provisional pace', () => {
    const half = (delta, windowDays) => ({ ok: true, delta, windowDays });

    it('is labelled differently, because it answers a different question', () => {
        const p = bio.provisionalPace({ recent: half(4, 30), window: half(5, 180) });
        expect(p.state).toBe('provisional');
        expect(p.value).toBe(0);
        // A measured pace observes change. This projects from one month of behaviour, and
        // the copy has to say so or the two look like the same claim.
        expect(p.message).toMatch(/rather than on how your age has actually moved/i);
    });

    it('carries no confidence, because there is no fit behind it', () => {
        expect(bio.provisionalPace({ recent: half(4, 30), window: half(5, 180) }).confidence)
            .toBeNull();
    });

    it('refuses when either window refused', () => {
        expect(bio.provisionalPace({ recent: { ok: false }, window: half(5, 180) }).ok).toBe(false);
        expect(bio.provisionalPace({ recent: half(4, 30), window: { ok: false } }).state)
            .toBe('unknown');
    });

    it('is what a new account gets, and it is never silently a measured one', async () => {
        await DailyMetrics.insertMany(Array.from({ length: 60 }, (_, i) => ({
            userId, day: new Date(Date.now() - (i + 1) * DAY_MS).toISOString().slice(0, 10),
            activity: { steps: 6400 }, heart: { restingBpm: 66, vo2Max: 39 },
            sleep: { asleepMin: 410 }, body: { weightKg: 84 },
        })));

        const pace = await ageController.paceFor(userId);
        expect(pace.state).toBe('provisional');
        expect(pace.basis.recentDays).toBe(30);
    });
});

describe('reading a stored snapshot back', () => {
    it('recovers the band from the delta when a row predates the field', async () => {
        // BiologicalAge is append-only, so a row written before a field existed is never
        // rewritten. A band is a pure function of a delta, so rendering a blank where a
        // label belongs is a choice rather than a constraint.
        const row = { value: 51, chronologicalAge: 45, delta: 6, source: 'lifestyle', halves: [] };
        const out = ageController._fromSnapshot(row);

        expect(out.band).toBe('older');
        expect(out.bandLabel).toBe('Older than your age');
    });

    it('prefers the stored band, so a threshold change cannot rewrite history', async () => {
        const out = ageController._fromSnapshot({
            value: 51, chronologicalAge: 45, delta: 6, band: 'on_track',
            source: 'lifestyle', halves: [],
        });
        expect(out.band).toBe('on_track');
    });

    it('survives a row with no halves at all', () => {
        expect(() => ageController._fromSnapshot({
            value: 50, chronologicalAge: 45, delta: 5, source: 'lab',
        })).not.toThrow();
    });
});

describe('levers', () => {
    const WELL = {
        albumin: 45, creatinine: 80, fasting_glucose: 5.0, crp: 1.0,
        lymphocytes_pct: 32, mcv: 90, rdw: 12.8, alp: 70, wbc: 6.0,
    };

    const seedPoorProfile = async () => {
        await DailyMetrics.insertMany(Array.from({ length: 90 }, (_, i) => ({
            userId, day: new Date(Date.now() - (i + 1) * DAY_MS).toISOString().slice(0, 10),
            activity: { steps: 5200 },
            heart: { restingBpm: 72, vo2Max: 34, zoneMinutes: [60, 30, 10, 3, 0] },
            sleep: { asleepMin: 372 }, body: { weightKg: 94 },
            bloodPressure: { systolic: 136, diastolic: 87 },
        })));
        await Biomarker.insertMany(Object.entries({
            ...WELL, fasting_glucose: 6.4, crp: 3.2, rdw: 14.4,
        }).map(([name, value]) => ({
            userId, name, value, measuredAt: new Date(Date.now() - 25 * DAY_MS),
            flag: 'normal', needsReview: false,
        })));
    };

    it('offers only things somebody could act on', async () => {
        await seedPoorProfile();
        const res = await call(ageController.getLevers);

        expect(res.statusCode).toBe(200);
        expect(res.body.levers.length).toBeGreaterThan(0);
        // "Lower your red cell distribution width" is advice nobody can take. A `fixed`
        // contributor is never a lever, however large its coefficient.
        expect(res.body.levers.every((l) => l.modifiable !== 'fixed')).toBe(true);
    });

    it('offers only things that would help', async () => {
        await seedPoorProfile();
        const { body } = await call(ageController.getLevers);
        // A contributor already better than its target produces a negative saving and must
        // not be shown as something to give up.
        expect(body.levers.every((l) => l.years > 0)).toBe(true);
    });

    it('caps the list, because a backlog is a thing people scroll past', async () => {
        await seedPoorProfile();
        const { body } = await call(ageController.getLevers);
        expect(body.levers.length).toBeLessThanOrEqual(bio.LEVER_LIMIT);
    });

    it('ranks by years recoverable', async () => {
        await seedPoorProfile();
        const { body } = await call(ageController.getLevers);
        expect(body.levers).toEqual([...body.levers].sort((a, b) => b.years - a.years));
    });

    it('names a route for every lever, and never one that does not exist', async () => {
        await seedPoorProfile();
        const { body } = await call(ageController.getLevers);

        // A lever with nowhere to go is the dead end PILLAR_ROUTE exists to prevent. The
        // group-qualified form matters: `/results` is not a route, and a bad router.push
        // throws nothing and goes nowhere.
        for (const l of body.levers) {
            expect(l.route).toMatch(/^\//);
            expect(l.route).not.toBe('/results');
        }
    });

    it('scales a lab lever by the lab half’s share of the blend', () => {
        // A marker worth two years of lab age is worth two years times the lab weight on the
        // blended number. Reporting the unweighted figure promises a change the number above
        // it cannot deliver.
        const markers = { ...WELL, fasting_glucose: 8.5 };
        const lab = bio.labAge({
            chronologicalAge: 45, sex: 'male',
            measurements: Object.entries(markers).map(([name, value]) => ({
                name, value, measuredAt: new Date(),
            })),
        });

        const full = bio.levers({
            chronologicalAge: 45, sex: 'male', markers, lab, weights: { lab: 1 },
        });
        const halved = bio.levers({
            chronologicalAge: 45, sex: 'male', markers, lab, weights: { lab: 0.5 },
        });

        expect(halved[0].years).toBeCloseTo(full[0].years / 2, 1);
    });

    it('answers 422 rather than an empty list when there is nothing to work from', async () => {
        const res = await call(ageController.getLevers);
        // The request was well formed; there is simply not enough of this person's data
        // behind it. The distinction `/predictions` already makes.
        expect(res.statusCode).toBe(422);
        expect(res.body.levers).toEqual([]);
        expect(res.body.message).toEqual(expect.any(String));
    });

    it('never leaks the mortality score through the lever route', async () => {
        await seedPoorProfile();
        const { body } = await call(ageController.getLevers);
        expect(JSON.stringify(body).toLowerCase()).not.toMatch(/mortalit|death|survival/);
    });
});

describe('the age gap in the prediction registry', () => {
    const metrics = require('../utils/predictionMetrics');

    it('forecasts the gap, not the age', () => {
        // Forecasting the absolute age forecasts mostly chronological age, which rises a year
        // per year whatever anybody does — so every prediction returns "you will be older",
        // dressed as an insight.
        expect(metrics.METRIC_KEYS).toContain('age_delta');
        expect(metrics.METRIC_KEYS).not.toContain('biological_age');
    });

    it('stages a forecast with the same bands a measured gap is staged by', () => {
        const band = metrics.get('age_delta').band(6);
        expect(band.key).toBe(bio.bandFor(6).key);
        expect(band.label).toBe(bio.bandFor(6).label);
    });

    it('gathers the stored deltas', async () => {
        await seedSeries({ count: 6, gapPerYear: 0.4 });
        const series = await metrics.get('age_delta').gather(userId);

        expect(series).toHaveLength(6);
        expect(series.every((p) => Number.isFinite(p.value))).toBe(true);
    });

    it('offers no one-day horizon, because this moves over months', () => {
        expect(metrics.get('age_delta').horizons).not.toContain(1);
    });
});
