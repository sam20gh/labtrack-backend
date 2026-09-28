/**
 * Writes the shared GPS fixture tracks to `__tests__/fixtures/tracks/`.
 *
 * Each fixture is a synthetic run with a **known truth** — the distance and moving time the
 * runner actually covered — plus the failure it exists to exercise: GPS drift at a red
 * light, a tunnel, a teleport spike, a hill, fixes too inaccurate to use, a manual pause.
 * The tests assert `computeTrack` lands near the truth *and* that it matches
 * `expected.json` exactly; the second half is what the phone's port is held to.
 *
 * Deterministic (seeded PRNG), so re-running produces byte-identical files. After changing
 * this or `utils/trackMetrics.js`:
 *
 *   node scripts/generateTrackFixtures.js           # tracks + expected.json
 *
 * then copy the folder to `labtrack-frontend/lib/run/__tests__/fixtures/tracks/`. Neither
 * repo can see the other at build time; the two copies are the contract.
 *
 * Noise is correlated (AR(1)), not white. Real phone GPS wanders smoothly; white noise at
 * the same amplitude adds a zig-zag between every pair of fixes and inflates distance in a
 * way no real device does, which would tune the filter against a problem that does not exist.
 */
const fs = require('fs');
const path = require('path');
const { computeTrack } = require('../utils/trackMetrics');
const { activeKcal } = require('../utils/runEnergy');

const OUT = path.join(__dirname, '..', '__tests__', 'fixtures', 'tracks');
const T0 = Date.UTC(2026, 8, 20, 6, 30, 0); // a Sunday-morning run, fixed
const ORIGIN = { lat: 25.0800, lng: 55.1400 };
const M_PER_DEG_LAT = 111_320;
const mPerDegLng = (lat) => 111_320 * Math.cos((lat * Math.PI) / 180);

/** mulberry32 — small, seeded, good enough for noise. */
const rng = (seed) => () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());

/** Correlated position noise in metres. */
const wander = (seed, sigma = 1.5, phi = 0.95) => {
    const r = rng(seed);
    let x = 0; let y = 0;
    const k = sigma * Math.sqrt(1 - phi * phi);
    return () => { x = phi * x + k * gauss(r); y = phi * y + k * gauss(r); return [x, y]; };
};

const round = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;

/**
 * Build a track from a list of legs. A leg moves along a heading at a speed for a duration,
 * or stands still (speed 0). `emit: false` produces no fixes (a tunnel). `paused` marks a
 * manual pause window.
 */
const build = ({ seed, legs, hr = null, altAt = () => 12, altNoise = 0.8 }) => {
    const noise = wander(seed);
    const altR = rng(seed + 1);
    const track = { t: [], lat: [], lng: [], alt: [], acc: [], hr: [], pauses: [] };
    let x = 0; let y = 0; let t = T0; let along = 0;
    let truthM = 0; let truthMovingSec = 0;

    const push = (extra = {}) => {
        const [nx, ny] = noise();
        const lat = ORIGIN.lat + (y + ny + (extra.dy || 0)) / M_PER_DEG_LAT;
        const lng = ORIGIN.lng + (x + nx + (extra.dx || 0)) / mPerDegLng(ORIGIN.lat);
        track.t.push(t);
        track.lat.push(round(lat, 7));
        track.lng.push(round(lng, 7));
        track.alt.push(round(altAt(along) + altNoise * gauss(altR), 1));
        track.acc.push(extra.acc ?? 5);
        track.hr.push(hr ? Math.round(hr(t - T0)) : null);
    };

    push();
    for (const leg of legs) {
        const pauseStart = t;
        for (let s = 0; s < leg.seconds; s += 1) {
            if (leg.turn) {
                // Constant-speed circle: heading advances with distance.
                leg.heading += (leg.speed / leg.radius);
            }
            x += leg.speed * Math.cos(leg.heading);
            y += leg.speed * Math.sin(leg.heading);
            along += leg.speed;
            t += 1000;
            if (!leg.paused) {
                truthM += leg.speed;
                if (leg.speed > 0) truthMovingSec += 1;
            }
            if (leg.emit !== false) push(leg.spikeAt?.includes(s) ? { dx: 500, dy: 500 } : leg.badAccAt?.includes(s) ? { dx: 80, acc: 60 } : {});
        }
        if (leg.paused) track.pauses.push([pauseStart + 1000, t]);
    }
    if (!track.pauses.length) delete track.pauses;
    if (!hr) delete track.hr;
    return { track, truth: { distanceM: round(truthM, 1), movingSec: truthMovingSec } };
};

const E = 0;               // heading east
const N = Math.PI / 2;     // heading north
const pace = (minPerKm) => 1000 / (minPerKm * 60);

const FIXTURES = {
    // A clean 5 km loop at 5:00/km with heart rate. The baseline every other case differs from.
    loop5k: {
        type: 'jogging',
        weightKg: 70,
        ...build({
            seed: 11,
            legs: [{ speed: pace(5), seconds: 1500, heading: 0, turn: true, radius: 5000 / (2 * Math.PI) }],
            hr: (ms) => 140 + 15 * Math.min(1, ms / 600_000),
        }),
    },
    // 2 km, 90 s stood at a crossing, 1 km. The drift must add no distance or moving time.
    redLight: {
        type: 'jogging',
        weightKg: 70,
        ...build({
            seed: 22,
            legs: [
                { speed: pace(5.5), seconds: 660, heading: E },
                { speed: 0, seconds: 90, heading: E },
                { speed: pace(5.5), seconds: 330, heading: E },
            ],
        }),
    },
    // 3 km with a two-minute tunnel in the middle. The gap is not bridged by a guess.
    tunnel: {
        type: 'jogging',
        weightKg: 70,
        ...build({
            seed: 33,
            legs: [
                { speed: 3, seconds: 380, heading: N },
                { speed: 3, seconds: 120, heading: N, emit: false },
                { speed: 3, seconds: 500, heading: N },
            ],
        }),
    },
    // 2 km with three single-fix teleports 700 m off the line.
    teleport: {
        type: 'jogging',
        weightKg: 70,
        ...build({
            seed: 44,
            legs: [{ speed: 3, seconds: 667, heading: E, spikeAt: [100, 300, 500] }],
        }),
    },
    // A 60 m climb and back down, walked. Altitude noise must not add phantom climb.
    hill: {
        type: 'hiking',
        weightKg: 82,
        ...build({
            seed: 55,
            legs: [
                { speed: 1.2, seconds: 1000, heading: N },
                { speed: 1.2, seconds: 1000, heading: -N },
            ],
            altAt: (along) => 20 + 60 * Math.max(0, 1 - Math.abs(along - 1200) / 1200),
            altNoise: 1.2,
        }),
    },
    // A walk with twenty fixes reporting 60 m accuracy and landing 80 m off.
    lowAccuracy: {
        type: 'walking',
        weightKg: 64,
        ...build({
            seed: 66,
            legs: [{ speed: 1.4, seconds: 900, heading: E, badAccAt: Array.from({ length: 20 }, (_, i) => 200 + i * 20) }],
        }),
    },
    // A ride with a manual pause during which the bike is walked 200 m. Not counted.
    pausedRide: {
        type: 'biking',
        weightKg: 75,
        ...build({
            seed: 77,
            legs: [
                { speed: 7, seconds: 600, heading: E },
                { speed: 1, seconds: 200, heading: N, paused: true },
                { speed: 7, seconds: 600, heading: E },
            ],
        }),
    },
    // No weight on record: calories must be null, not a default.
    noWeight: {
        type: 'jogging',
        weightKg: null,
        ...build({ seed: 88, legs: [{ speed: 3, seconds: 400, heading: E }] }),
    },
};

fs.mkdirSync(OUT, { recursive: true });
const expected = {};
for (const [name, f] of Object.entries(FIXTURES)) {
    fs.writeFileSync(path.join(OUT, `${name}.json`), `${JSON.stringify({ type: f.type, weightKg: f.weightKg, truth: f.truth, track: f.track })}\n`);
    const m = computeTrack(f.track, { type: f.type });
    expected[name] = {
        distanceM: m.distanceM,
        movingSec: m.movingSec,
        elapsedSec: m.elapsedSec,
        avgPacePerKm: m.avgPacePerKm,
        maxSpeed: m.maxSpeed,
        elevationGainM: m.elevationGainM,
        avgBpm: m.avgBpm,
        maxBpm: m.maxBpm,
        splits: m.splits,
        routePoints: m.route.length,
        pointsUsed: m.pointsUsed,
        activeKcal: activeKcal(m.segments, { type: f.type, weightKg: f.weightKg }),
    };
    console.log(`${name.padEnd(12)} truth ${f.truth.distanceM}m/${f.truth.movingSec}s → ${m.distanceM}m/${m.movingSec}s  gain=${m.elevationGainM} kcal=${expected[name].activeKcal} splits=${m.splits.length} route=${m.route.length}/${m.pointsUsed}`);
}
fs.writeFileSync(path.join(OUT, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`);
console.log(`✅ wrote ${Object.keys(FIXTURES).length} fixtures + expected.json to ${OUT}`);
