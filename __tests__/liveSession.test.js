/**
 * A GPS session recorded on the phone.
 *
 * Two halves. The arithmetic is held against the shared fixture tracks — near each track's
 * known truth, and *exactly* at `expected.json`, which is the half the phone's port
 * (`labtrack-frontend/lib/run/trackMath.ts`) is held to as well. The endpoint is held to the
 * rules its header makes: recompute everything, a retry is an upsert, moving time is the
 * duration, the day's steps are not counted twice, no weight means no calories, and a
 * deleted run takes its route with it.
 */
jest.mock('../controllers/scoreController', () => ({ touch: jest.fn() }));
jest.mock('../controllers/achievementController', () => ({ touch: jest.fn() }));

const fs = require('fs');
const path = require('path');
const User = require('../models/userModel');
const ActivitySession = require('../models/ActivitySession');
const ActivityTrack = require('../models/ActivityTrack');
const DailyMetrics = require('../models/DailyMetrics');
const { computeTrack, simplify, elevationGain } = require('../utils/trackMetrics');
const { activeKcal } = require('../utils/runEnergy');
const { scoreSession } = require('../utils/activityScore');
const c = require('../controllers/activityController');

const FIXTURES = path.join(__dirname, 'fixtures', 'tracks');
const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected.json'), 'utf8'));
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));

const call = async (handler, req) => {
    let body;
    let status = 200;
    const res = {
        json: (payload) => { body = payload; return res; },
        status: (code) => { status = code; return res; },
    };
    await handler(req, res);
    return { status, body };
};

const seedUser = async (extra = {}) => {
    const suffix = `${Date.now()}${Math.round(Math.random() * 1e6)}`;
    const user = await User.create({
        username: `runner-${suffix}`,
        firstName: 'Test',
        lastName: 'Runner',
        email: `r${suffix}@example.com`,
        password: 'hashed',
        ...extra,
    });
    return user._id;
};

const upload = (userId, body) => call(c.createLiveSession, { user: { id: String(userId) }, body });

const bodyFor = (name, overrides = {}) => {
    const f = load(name);
    return {
        clientId: `3f2c9a10-${name.toLowerCase()}-4d1e`,
        type: f.type,
        tzOffset: 0,
        track: f.track,
        ...overrides,
    };
};

describe('the arithmetic, against the shared fixtures', () => {
    const names = Object.keys(expected);

    it.each(names)('%s matches expected.json exactly — the contract the phone is held to', (name) => {
        const f = load(name);
        const m = computeTrack(f.track, { type: f.type });
        const e = expected[name];
        expect(m.distanceM).toBe(e.distanceM);
        expect(m.movingSec).toBe(e.movingSec);
        expect(m.elapsedSec).toBe(e.elapsedSec);
        expect(m.avgPacePerKm).toBe(e.avgPacePerKm);
        expect(m.maxSpeed).toBe(e.maxSpeed);
        expect(m.elevationGainM).toBe(e.elevationGainM);
        expect(m.avgBpm).toBe(e.avgBpm);
        expect(m.maxBpm).toBe(e.maxBpm);
        expect(m.splits).toEqual(e.splits);
        expect(m.route).toHaveLength(e.routePoints);
        expect(m.pointsUsed).toBe(e.pointsUsed);
        expect(activeKcal(m.segments, { type: f.type, weightKg: f.weightKg })).toBe(e.activeKcal);
    });

    it.each(names.filter((n) => n !== 'tunnel'))('%s lands within 2% of the distance actually covered', (name) => {
        const f = load(name);
        const m = computeTrack(f.track, { type: f.type });
        expect(Math.abs(m.distanceM - f.truth.distanceM) / f.truth.distanceM).toBeLessThan(0.02);
        expect(Math.abs(m.movingSec - f.truth.movingSec)).toBeLessThanOrEqual(5);
    });

    it('does not bridge a tunnel with a guess: the gap costs its distance and its moving time', () => {
        const f = load('tunnel');
        const m = computeTrack(f.track, { type: f.type });
        // 120 s at 3 m/s went unrecorded.
        expect(m.distanceM).toBeGreaterThan(3000 - 360 - 30);
        expect(m.distanceM).toBeLessThan(3000 - 360 + 30);
        expect(m.movingSec).toBeLessThan(900);
        expect(m.elapsedSec).toBe(1000);
    });

    it('adds no distance and no moving time while stood at a red light', () => {
        const f = load('redLight');
        const m = computeTrack(f.track, { type: f.type });
        expect(m.elapsedSec - m.movingSec).toBeGreaterThanOrEqual(85);
    });

    it('drops a teleport and keeps the fixes either side of it', () => {
        const f = load('teleport');
        const m = computeTrack(f.track, { type: f.type });
        expect(m.pointsUsed).toBe(f.track.t.length - 3);
    });

    it('drops fixes worse than 25 m', () => {
        const f = load('lowAccuracy');
        const m = computeTrack(f.track, { type: f.type });
        expect(m.pointsUsed).toBe(f.track.t.length - 20);
    });

    it('counts nothing ridden or walked during a manual pause', () => {
        const f = load('pausedRide');
        const m = computeTrack(f.track, { type: f.type });
        expect(m.distanceM).toBeLessThan(8400 + 100);
        expect(m.movingSec).toBeLessThanOrEqual(1200);
    });

    it('finds the real climb and no phantom one', () => {
        expect(computeTrack(load('hill').track, { type: 'hiking' }).elevationGainM).toBeGreaterThan(50);
        expect(computeTrack(load('hill').track, { type: 'hiking' }).elevationGainM).toBeLessThan(70);
        expect(computeTrack(load('loop5k').track, { type: 'jogging' }).elevationGainM).toBeLessThan(5);
    });

    it('reports no climb, not zero, for a source with no altitude', () => {
        expect(elevationGain([null, null])).toBeNull();
    });

    it('splits a 5 km loop into five kilometres at about five minutes each', () => {
        const { splits } = computeTrack(load('loop5k').track, { type: 'jogging' });
        expect(splits.map((s) => s.label)).toEqual(['Km 1', 'Km 2', 'Km 3', 'Km 4', 'Km 5']);
        for (const s of splits.filter((x) => x.distanceM === 1000)) {
            expect(s.pacePerKm).toBeGreaterThan(290);
            expect(s.pacePerKm).toBeLessThan(310);
            expect(s.avgBpm).toBeGreaterThanOrEqual(140);
        }
    });

    it('simplifies the stored route without losing its ends', () => {
        const { track } = load('loop5k');
        const coords = track.lng.map((lng, i) => [lng, track.lat[i]]);
        const route = simplify(coords);
        expect(route.length).toBeLessThan(coords.length / 10);
        expect(route[0]).toEqual(coords[0]);
        expect(route[route.length - 1]).toEqual(coords[coords.length - 1]);
    });

    it('survives an empty or corrupt track rather than throwing', () => {
        expect(computeTrack({ t: [], lat: [], lng: [] }).distanceM).toBe(0);
        expect(computeTrack({ t: [1, 2], lat: [null, 'x'], lng: [0, 0] }).pointsUsed).toBe(0);
        expect(computeTrack(undefined).distanceM).toBe(0);
    });
});

describe('calories', () => {
    it('are null with no body mass — never a default', () => {
        const m = computeTrack(load('noWeight').track, { type: 'jogging' });
        expect(activeKcal(m.segments, { type: 'jogging', weightKg: null })).toBeNull();
    });

    it('are null for a type there is no equation for', () => {
        const m = computeTrack(load('loop5k').track, { type: 'jogging' });
        expect(activeKcal(m.segments, { type: 'swimming', weightKg: 70 })).toBeNull();
    });

    it('put a 5 km run at 70 kg in the range the ACSM equation gives', () => {
        const m = computeTrack(load('loop5k').track, { type: 'jogging' });
        const kcal = activeKcal(m.segments, { type: 'jogging', weightKg: 70 });
        expect(kcal).toBeGreaterThan(320);
        expect(kcal).toBeLessThan(400);
    });
});

describe('POST /activity/sessions/live', () => {
    it('stores the recomputed figures and ignores the ones the client sent', async () => {
        const userId = await seedUser({ weight: 70 });
        const { status, body } = await upload(userId, bodyFor('loop5k', {
            distanceM: 42_195, activeKcal: 9999, durationSec: 1,
        }));

        expect(status).toBe(201);
        const e = expected.loop5k;
        expect(body.session).toMatchObject({
            source: 'live',
            type: 'jogging',
            distanceM: e.distanceM,
            durationSec: e.movingSec,
            activeKcal: e.activeKcal,
            avgBpm: e.avgBpm,
        });
        expect(body.session.splits).toHaveLength(5);
        expect(body.session.route.type).toBe('LineString');
        expect(body.session.route.coordinates).toHaveLength(e.routePoints);
        expect(body.metrics.kcalUnavailable).toBeNull();

        const track = await ActivityTrack.findOne({ sessionId: body.session._id }).lean();
        expect(track.t).toHaveLength(load('loop5k').track.t.length);
    });

    it('answers a retry with the stored row, 200 not 409, and stores one', async () => {
        const userId = await seedUser({ weight: 70 });
        const first = await upload(userId, bodyFor('redLight'));
        const second = await upload(userId, bodyFor('redLight'));

        expect(first.status).toBe(201);
        expect(second.status).toBe(200);
        expect(second.body.duplicate).toBe(true);
        expect(String(second.body.session._id)).toBe(String(first.body.session._id));
        expect(await ActivitySession.countDocuments({ userId })).toBe(1);
        expect(await ActivityTrack.countDocuments({ userId })).toBe(1);
    });

    it('lets two people use the same client id', async () => {
        const a = await seedUser();
        const b = await seedUser();
        expect((await upload(a, bodyFor('noWeight'))).status).toBe(201);
        expect((await upload(b, bodyFor('noWeight'))).status).toBe(201);
    });

    it('does not add the run to the day’s steps or distance — the health store already did', async () => {
        const userId = await seedUser({ weight: 70 });
        const day = new Date(load('loop5k').track.t[0]).toISOString().slice(0, 10);
        await DailyMetrics.create({ userId, day, activity: { steps: 9000, distanceM: 6500 } });

        await upload(userId, bodyFor('loop5k'));

        const row = await DailyMetrics.findOne({ userId, day }).lean();
        expect(row.activity.steps).toBe(9000);
        expect(row.activity.distanceM).toBe(6500);
        expect(row.activity.sessions).toBe(1);
        expect(row.activity.exerciseMin).toBe(Math.round(expected.loop5k.movingSec / 60));
    });

    it('scores the session on moving time and effort, never on pace', async () => {
        const userId = await seedUser();
        const { body } = await upload(userId, bodyFor('loop5k', { effort: 4 }));
        const session = await ActivitySession.findById(body.session._id).lean();
        expect(session.scoreDelta).toBe(scoreSession({ durationSec: expected.loop5k.movingSec, effort: 4 }));
    });

    it('falls back to the profile weight, and says why when there is none', async () => {
        const withWeight = await seedUser({ weight: 70 });
        const without = await seedUser();

        const a = await upload(withWeight, bodyFor('noWeight'));
        const b = await upload(without, bodyFor('noWeight'));

        expect(a.body.session.activeKcal).toBeGreaterThan(0);
        expect(b.body.session.activeKcal).toBeUndefined();
        expect(b.body.metrics.kcalUnavailable).toBe('no_weight');
    });

    it('prefers a logged weight to the profile answer', async () => {
        const userId = await seedUser({ weight: 140 });
        const day = new Date(load('noWeight').track.t[0]).toISOString().slice(0, 10);
        await DailyMetrics.create({ userId, day, body: { weightKg: 70 } });

        const heavy = await seedUser({ weight: 70 });
        const a = await upload(userId, bodyFor('noWeight'));
        const b = await upload(heavy, bodyFor('noWeight'));
        expect(a.body.session.activeKcal).toBe(b.body.session.activeKcal);
    });

    it('still records a session with no usable GPS, on the clock minus pauses', async () => {
        const userId = await seedUser();
        const t0 = Date.UTC(2026, 8, 20, 7, 0, 0);
        const { status, body } = await upload(userId, {
            clientId: 'indoor-0001',
            type: 'running',
            startedAt: new Date(t0).toISOString(),
            endedAt: new Date(t0 + 30 * 60_000).toISOString(),
            track: { t: [], lat: [], lng: [], pauses: [[t0 + 60_000, t0 + 5 * 60_000]] },
        });
        expect(status).toBe(201);
        expect(body.session.durationSec).toBe(26 * 60);
        expect(body.session.distanceM).toBeUndefined();
        // Mongoose materialises an unset nested path as `{}` — the client checks coordinates.
        expect(body.session.route?.coordinates).toBeUndefined();
    });

    it('files the run under the runner’s local day', async () => {
        const userId = await seedUser();
        // 06:30 UTC on the 20th is 23:30 on the 19th at UTC-7.
        const { body } = await upload(userId, bodyFor('noWeight', { tzOffset: 420 }));
        expect(body.session.day).toBe('2026-09-19');
    });

    it.each([
        ['no client id', { clientId: undefined }],
        ['a type with no GPS meaning', { type: 'yoga' }],
        ['columns of different lengths', { track: { t: [1, 2, 3], lat: [1, 2], lng: [1, 2, 3] } }],
        ['no track at all', { track: undefined }],
    ])('refuses %s with a 400', async (_, overrides) => {
        const userId = await seedUser();
        const { status } = await upload(userId, bodyFor('noWeight', overrides));
        expect(status).toBe(400);
        expect(await ActivitySession.countDocuments({ userId })).toBe(0);
    });

    it('keeps only a short locality, never a long address', async () => {
        const userId = await seedUser();
        const { body } = await upload(userId, bodyFor('noWeight', { startAddress: `  ${'x'.repeat(200)}  ` }));
        expect(body.session.startAddress).toHaveLength(80);
    });
});

describe('GET /activity/live/context', () => {
    const context = (userId) => call(c.getLiveContext, { user: { id: String(userId) } });

    it('gives the logged weight first, then the profile, then null — the rule the upload prices with', async () => {
        const logged = await seedUser({ weight: 90 });
        await DailyMetrics.create({ userId: logged, day: '2026-09-01', body: { weightKg: 72 } });
        const profile = await seedUser({ weight: 90 });
        const none = await seedUser();

        expect((await context(logged)).body).toEqual({ weightKg: 72, weightSource: 'logged' });
        expect((await context(profile)).body).toEqual({ weightKg: 90, weightSource: 'profile' });
        expect((await context(none)).body).toEqual({ weightKg: null, weightSource: null });
    });
});

describe('the track after it is saved', () => {
    it('is readable by its owner and 404 to anyone else', async () => {
        const owner = await seedUser();
        const stranger = await seedUser();
        const { body } = await upload(owner, bodyFor('teleport'));
        const id = String(body.session._id);

        const mine = await call(c.getTrack, { user: { id: String(owner) }, params: { id } });
        const theirs = await call(c.getTrack, { user: { id: String(stranger) }, params: { id } });
        const junk = await call(c.getTrack, { user: { id: String(owner) }, params: { id: 'not-an-id' } });

        expect(mine.status).toBe(200);
        expect(mine.body.track.lat).toHaveLength(load('teleport').track.t.length);
        expect(theirs.status).toBe(404);
        expect(junk.status).toBe(404);
    });

    it('is deleted with its session', async () => {
        const userId = await seedUser();
        const { body } = await upload(userId, bodyFor('hill'));
        const res = await call(c.deleteSession, { user: { id: String(userId) }, params: { id: String(body.session._id) } });

        expect(res.status).toBe(200);
        expect(res.body.willResync).toBe(false);
        expect(await ActivityTrack.countDocuments({ userId })).toBe(0);
    });

    it('is not left behind when writing the session fails part-way', async () => {
        const userId = await seedUser();
        const spy = jest.spyOn(ActivityTrack, 'create').mockRejectedValueOnce(new Error('disk full'));
        const { status } = await upload(userId, bodyFor('hill'));
        spy.mockRestore();

        expect(status).toBe(500);
        expect(await ActivitySession.countDocuments({ userId })).toBe(0);
    });
});

