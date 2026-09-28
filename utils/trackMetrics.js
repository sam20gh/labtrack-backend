/**
 * What a recorded GPS track measured — distance, moving time, splits, climb, heart rate and
 * the simplified route.
 *
 * **A deterministic table, not a judgement**, in the series with `bloodPressure.js`,
 * `predictionForecast.js` and the rest, and for the same reason: the number a live session
 * stores has to be the same number on every call, pinned by a test, and reproducible by the
 * phone. `labtrack-frontend/lib/run/trackMath.ts` is a line-for-line port. Neither repo can
 * import the other at build time, so both suites run the **same fixture tracks**
 * (`__tests__/fixtures/tracks/`, vendored into both) and assert the same outputs. Change a
 * constant here and the phone's live numbers will disagree with the stored ones until the
 * port is changed too — the fixtures will say so on both sides.
 *
 * The server's result is the record. The phone's is provisional: it is what the live screen
 * shows while running, and the summary swaps to this once the upload returns.
 *
 * Input is columnar, the shape `ActivityTrack` stores:
 *   { t: [ms epoch], lat: [], lng: [], alt?: [], acc?: [], hr?: [], pauses?: [[startMs, endMs]] }
 *
 * Five rules, each a way the naive version is wrong:
 *
 * 1. **A fix worse than `MAX_ACCURACY_M` is dropped.** A phone indoors or under glass reports
 *    positions tens of metres off; summed, they are distance nobody ran.
 * 2. **A fix implying an impossible speed is dropped, not the one before it.** A GPS teleport
 *    is a single bad point; discarding the previous good one as well loses real distance.
 * 3. **Distance is counted between anchors, not between fixes.** A new anchor is set only
 *    once the position is `MIN_STEP_M` from the last one. Fix-to-fix, GPS wander is a large
 *    share of every step at walking pace — the `hill` and `lowAccuracy` fixtures read 8% and
 *    6% long that way — and at a red light it is all of it. An anchor-to-anchor step slower
 *    than the type's stop speed is standing still: neither distance nor moving time, which
 *    is what auto-pause means.
 * 4. **A gap is not bridged by guessing.** Longer than `MAX_GAP_SEC` (a tunnel, a lost fix)
 *    and the chain breaks: no distance and no moving time across it, so pace is not dragged
 *    down by minutes with no distance. The elapsed clock still counts it.
 * 5. **Altitude is smoothed over ±`ALT_SMOOTH_SEC`, then climb needs `CLIMB_HYSTERESIS_M`.**
 *    GPS altitude is the noisiest thing a phone reports. Hysteresis alone is not enough:
 *    per-second noise of under a metre still crosses a 3 m band dozens of times an hour, and
 *    the `loop5k` fixture — dead flat — climbed 65 m that way before smoothing.
 */

const EARTH_RADIUS_M = 6_371_008.8;

const MAX_ACCURACY_M = 25;
const MAX_GAP_SEC = 60;
const ALT_SMOOTH_SEC = 15;
const CLIMB_HYSTERESIS_M = 3;
/** A final partial split shorter than this is folded away rather than shown as a split. */
const MIN_PARTIAL_SPLIT_M = 100;
const SPLIT_M = 1000;
/** Douglas–Peucker tolerance for the stored `route`. */
const ROUTE_TOLERANCE_M = 2;
const HR_MIN = 30;
const HR_MAX = 230;

/**
 * Per type: the fastest plausible speed (m/s), the speed below which somebody is standing
 * still, and the anchor spacing in metres (rule 3). Hiking's stop speed is lower because a
 * steep climb is genuinely slow. Keyed by `healthSync.normaliseType` output — `running` arrives as `jogging`.
 */
const TYPE_LIMITS = {
    walking: { maxSpeed: 4, stopSpeed: 0.4, minStep: 5 },
    jogging: { maxSpeed: 12, stopSpeed: 0.5, minStep: 5 },
    hiking: { maxSpeed: 4, stopSpeed: 0.25, minStep: 5 },
    biking: { maxSpeed: 25, stopSpeed: 1, minStep: 8 },
};
const TRACKABLE_TYPES = Object.keys(TYPE_LIMITS);

const toRad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in metres. */
const haversine = (lat1, lng1, lat2, lng2) => {
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
};

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const round1 = (v) => Math.round(v * 10) / 10;

const inPause = (ms, pauses) => pauses.some(([s, e]) => ms >= s && ms <= e);
/** True when [a, b] overlaps any pause window. */
const crossesPause = (a, b, pauses) => pauses.some(([s, e]) => a <= e && b >= s);

/**
 * The columnar track as clean point objects, time-ordered, with rule 1 applied. Invalid rows are skipped, not fatal: one corrupt fix must not cost a run.
 */
const toPoints = (track) => {
    const n = Array.isArray(track?.t) ? track.t.length : 0;
    const points = [];
    for (let i = 0; i < n; i += 1) {
        const t = track.t[i];
        const lat = track.lat?.[i];
        const lng = track.lng?.[i];
        if (!finite(t) || !finite(lat) || !finite(lng)) continue;
        if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
        const acc = track.acc?.[i];
        if (finite(acc) && acc > MAX_ACCURACY_M) continue;
        const alt = track.alt?.[i];
        const hr = track.hr?.[i];
        points.push({
            t, lat, lng,
            alt: finite(alt) ? alt : null,
            hr: finite(hr) && hr >= HR_MIN && hr <= HR_MAX ? hr : null,
        });
    }
    points.sort((a, b) => a.t - b.t);
    return points;
};

const normalisePauses = (pauses) => (Array.isArray(pauses) ? pauses : [])
    .filter((p) => Array.isArray(p) && finite(p[0]) && finite(p[1]) && p[1] >= p[0])
    .map(([s, e]) => [s, e]);

/**
 * Centred moving average of altitude over ±`ALT_SMOOTH_SEC`, two-pointer so it is linear.
 * Points without altitude stay null and are not averaged in.
 */
const smoothAltitudes = (points) => {
    const out = new Array(points.length).fill(null);
    let lo = 0;
    let hi = 0;
    let sum = 0;
    let count = 0;
    const add = (p) => { if (finite(p.alt)) { sum += p.alt; count += 1; } };
    const drop = (p) => { if (finite(p.alt)) { sum -= p.alt; count -= 1; } };
    for (let i = 0; i < points.length; i += 1) {
        const t = points[i].t;
        while (hi < points.length && points[hi].t <= t + ALT_SMOOTH_SEC * 1000) { add(points[hi]); hi += 1; }
        while (points[lo].t < t - ALT_SMOOTH_SEC * 1000) { drop(points[lo]); lo += 1; }
        if (finite(points[i].alt) && count > 0) out[i] = sum / count;
    }
    return out;
};

/**
 * Elevation gain with hysteresis. `null` when the track carried no altitude at all — a
 * source that does not report altitude is not evidence of a flat route.
 */
const elevationGain = (alts) => {
    const values = alts.filter(finite);
    if (!values.length) return null;
    let ref = values[0];
    let gain = 0;
    for (const alt of values) {
        if (alt >= ref + CLIMB_HYSTERESIS_M) {
            gain += alt - ref;
            ref = alt;
        } else if (alt <= ref - CLIMB_HYSTERESIS_M) {
            ref = alt;
        }
    }
    return round1(gain);
};

/** Perpendicular distance from p to segment a–b, metres, on a local flat projection. */
const segmentDistance = (p, a, b, cosLat) => {
    const x = (q) => toRad(q[0]) * EARTH_RADIUS_M * cosLat;
    const y = (q) => toRad(q[1]) * EARTH_RADIUS_M;
    const [px, py, ax, ay, bx, by] = [x(p), y(p), x(a), y(a), x(b), y(b)];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    return Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
};

/**
 * Douglas–Peucker over `[lng, lat]` pairs. Iterative, so a six-hour hike cannot blow the
 * stack. Endpoints are always kept.
 */
const simplify = (coords, tolerance = ROUTE_TOLERANCE_M) => {
    if (coords.length <= 2) return coords.slice();
    const cosLat = Math.cos(toRad(coords[0][1]));
    const keep = new Uint8Array(coords.length);
    keep[0] = 1;
    keep[coords.length - 1] = 1;
    const stack = [[0, coords.length - 1]];
    while (stack.length) {
        const [first, last] = stack.pop();
        let maxDist = 0;
        let index = -1;
        for (let i = first + 1; i < last; i += 1) {
            const d = segmentDistance(coords[i], coords[first], coords[last], cosLat);
            if (d > maxDist) { maxDist = d; index = i; }
        }
        if (index !== -1 && maxDist > tolerance) {
            keep[index] = 1;
            stack.push([first, index], [index, last]);
        }
    }
    return coords.filter((_, i) => keep[i]);
};

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * The whole computation. Returns every figure the session row and its detail screen need.
 * `segments` (the per-interval breakdown) is returned for `runEnergy`, which prices each
 * moving interval by its own speed and grade, and is not stored.
 */
const computeTrack = (track, { type = 'jogging' } = {}) => {
    const limits = TYPE_LIMITS[type] || TYPE_LIMITS.jogging;
    const pauses = normalisePauses(track?.pauses);
    const raw = toPoints(track);

    const empty = {
        distanceM: 0, movingSec: 0, elapsedSec: 0, avgPacePerKm: null, avgSpeed: null, maxSpeed: null,
        elevationGainM: null, avgBpm: null, maxBpm: null, splits: [], route: [], segments: [],
        pointsUsed: 0, pointsDropped: Array.isArray(track?.t) ? track.t.length : 0,
    };
    if (raw.length < 2) return { ...empty, pointsUsed: raw.length };

    const elapsedSec = Math.round((raw[raw.length - 1].t - raw[0].t) / 1000);

    // Rule 2: drop teleports against the last *kept* point, so one bad fix costs one fix.
    const kept = [raw[0]];
    for (let i = 1; i < raw.length; i += 1) {
        const prev = kept[kept.length - 1];
        const p = raw[i];
        const dt = (p.t - prev.t) / 1000;
        if (dt <= 0) continue;
        const d = haversine(prev.lat, prev.lng, p.lat, p.lng);
        // A gap is judged by rule 4 below, not as a speed — a long gap's average speed is
        // meaningless in either direction.
        if (dt <= MAX_GAP_SEC && d / dt > limits.maxSpeed) continue;
        kept.push(p);
    }

    const alts = smoothAltitudes(kept);

    let distanceM = 0;
    let movingSec = 0;
    let maxSpeed = 0;
    const segments = [];
    // Rule 3: the last anchor, as an index into `kept`.
    let anchor = 0;

    for (let i = 1; i < kept.length; i += 1) {
        const prev = kept[i - 1];
        const b = kept[i];

        // Rule 4, and manual pauses: the chain breaks, nothing is counted across it, and the
        // next anchor is the first fix after the break.
        if ((b.t - prev.t) / 1000 > MAX_GAP_SEC || crossesPause(prev.t, b.t, pauses) || inPause(b.t, pauses)) {
            anchor = i;
            continue;
        }

        const from = anchor;
        const a = kept[from];
        const d = haversine(a.lat, a.lng, b.lat, b.lng);
        if (d < limits.minStep) continue;

        const dt = (b.t - a.t) / 1000;
        const speed = d / dt;
        anchor = i;
        if (speed < limits.stopSpeed) continue; // standing still, however it drifted

        distanceM += d;
        movingSec += dt;
        if (speed > maxSpeed) maxSpeed = speed;
        const climb = finite(alts[i]) && finite(alts[from]) ? alts[i] - alts[from] : null;
        segments.push({
            startT: a.t, endT: b.t, distanceM: d, durationSec: dt, speed, climbM: climb,
            hr: b.hr, cumulativeM: distanceM,
        });
    }

    const splits = buildSplits(segments);

    const hrs = kept.filter((p) => !inPause(p.t, pauses)).map((p) => p.hr).filter(finite);
    const route = simplify(kept.map((p) => [p.lng, p.lat]));

    return {
        distanceM: round1(distanceM),
        movingSec: Math.round(movingSec),
        elapsedSec,
        avgPacePerKm: distanceM >= 10 ? Math.round(movingSec / (distanceM / 1000)) : null,
        avgSpeed: movingSec > 0 ? round1(distanceM / movingSec) : null,
        maxSpeed: maxSpeed > 0 ? round1(maxSpeed) : null,
        elevationGainM: elevationGain(alts),
        avgBpm: hrs.length ? Math.round(mean(hrs)) : null,
        // A reduce, not `Math.max(...hrs)`: spreading 50,000 arguments overflows the stack.
        maxBpm: hrs.length ? hrs.reduce((m, v) => (v > m ? v : m), -Infinity) : null,
        splits,
        route,
        segments,
        pointsUsed: kept.length,
        pointsDropped: (track?.t?.length || 0) - kept.length,
    };
};

/**
 * Per-kilometre splits, with the crossing time interpolated inside the segment that crosses
 * the boundary — otherwise a split's pace depends on where the fixes happened to land.
 * A trailing partial of at least `MIN_PARTIAL_SPLIT_M` is its own split, labelled with its
 * real distance.
 */
const buildSplits = (segments) => {
    const splits = [];
    let splitDist = 0;
    let splitSec = 0;
    let splitHr = [];
    const close = (distanceM, durationSec) => {
        const order = splits.length + 1;
        splits.push({
            label: distanceM >= SPLIT_M ? `Km ${order}` : `${round1(distanceM / 1000)} km`,
            order,
            distanceM: round1(distanceM),
            durationSec: Math.round(durationSec),
            avgBpm: splitHr.length ? Math.round(mean(splitHr)) : null,
            pacePerKm: distanceM > 0 ? Math.round(durationSec / (distanceM / 1000)) : null,
        });
        splitHr = [];
    };

    for (const seg of segments) {
        let remainingD = seg.distanceM;
        let remainingT = seg.durationSec;
        // One heart-rate sample per split the segment touches.
        while (splitDist + remainingD >= SPLIT_M) {
            const need = SPLIT_M - splitDist;
            const frac = remainingD > 0 ? need / remainingD : 0;
            const tPart = remainingT * frac;
            if (finite(seg.hr)) splitHr.push(seg.hr);
            close(SPLIT_M, splitSec + tPart);
            splitDist = 0;
            splitSec = 0;
            remainingD -= need;
            remainingT -= tPart;
        }
        if (remainingD > 0 && finite(seg.hr)) splitHr.push(seg.hr);
        splitDist += remainingD;
        splitSec += remainingT;
    }
    if (splitDist >= MIN_PARTIAL_SPLIT_M) close(splitDist, splitSec);
    return splits;
};

module.exports = {
    computeTrack,
    haversine,
    simplify,
    elevationGain,
    TRACKABLE_TYPES,
    TYPE_LIMITS,
    MAX_ACCURACY_M,
    MAX_GAP_SEC,
    ALT_SMOOTH_SEC,
    CLIMB_HYSTERESIS_M,
    ROUTE_TOLERANCE_M,
};
