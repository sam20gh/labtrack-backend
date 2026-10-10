/**
 * Distance and travel time between doors — the geometry under assignment and arrival times.
 *
 * Deliberately an estimate from straight-line distance, not a road network. A road router
 * (Google's Route Optimization, OSRM) gives better minutes but costs a key, a bill and a network
 * call inside every assignment, and the decisions it feeds are coarse: *can* this technician get
 * from Marina to JLT in the gap between two half-hour slots, and roughly *when* will they be at
 * the door. A straight line times a road factor answers both well enough to plan with, and
 * `travelMinutes` is the single place to swap in a router when the numbers say it matters.
 *
 * The constants are city driving, chosen for Dubai and stated rather than buried:
 *   ROAD_FACTOR   1.4   roads are longer than the crow flies
 *   SPEED_KMH     30    average door-to-door city speed, traffic included
 *   PARKING_MIN   5     finding the building, parking, the lift
 *   VISIT_MIN     20    at the door: identity, two tubes, a bracelet, the paperwork
 *
 * **A slot is an arrival window, not an appointment that ends.** A technician who arrives at
 * the start of the 08:00–08:30 window leaves at about 08:20, and makes the 08:30–09:00 visit if
 * they are at that door by 09:00. Measuring the gap from one window's *end* to the next one's
 * *start* instead — zero minutes for consecutive slots — would forbid one technician two
 * back-to-back visits even in the same building.
 *
 * Pure: no database, no network, no clock.
 */

const ROAD_FACTOR = 1.4;
const SPEED_KMH = 30;
const PARKING_MIN = 5;
const VISIT_MIN = 20;

const has = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng);

/** Great-circle distance in km. */
const haversineKm = (a, b) => {
    const R = 6371;
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

/**
 * Minutes to drive from one point to another and be at the door, or null when either point is
 * unknown — never zero, because "no idea" planned as "instant" sends a technician across a city
 * in no time at all.
 */
const travelMinutes = (from, to) => {
    if (!has(from) || !has(to)) return null;
    const km = haversineKm(from, to) * ROAD_FACTOR;
    return Math.round((km / SPEED_KMH) * 60 + PARKING_MIN);
};

/**
 * Minutes until a moving technician reaches the door. No parking allowance below ~300 m: they
 * are already outside.
 */
const etaMinutes = (from, to) => {
    if (!has(from) || !has(to)) return null;
    const km = haversineKm(from, to) * ROAD_FACTOR;
    return Math.max(1, Math.round((km / SPEED_KMH) * 60 + (km < 0.3 ? 0 : PARKING_MIN)));
};

/** Minutes from the earliest departure after `prev` to the close of `next`'s arrival window. */
const spare = (prev, next) => (new Date(next.slot.end) - new Date(prev.slot.start)) / 60000 - VISIT_MIN;

/**
 * Could somebody finish one visit and reach the next door inside its arrival window?
 * `true` / `false` when both doors are known, `null` when it cannot be judged.
 */
const reachable = (prev, next) => {
    const minutes = travelMinutes(prev.address, next.address);
    if (minutes === null) return null;
    return minutes <= spare(prev, next);
};

/**
 * The legs of a day, in slot order: from the base to the first door, and door to door.
 * Each leg says how long it should take and whether the gap allows it.
 */
const legsFor = (visits, base) => {
    const ordered = [...visits].sort((a, b) => new Date(a.slot.start) - new Date(b.slot.start));
    return ordered.map((v, i) => {
        const prev = ordered[i - 1];
        const from = prev ? prev.address : base;
        const minutes = travelMinutes(from, v.address);
        const free = prev ? spare(prev, v) : null;
        return {
            visitId: String(v._id),
            fromBase: !prev,
            minutes,
            tight: minutes !== null && free !== null && minutes > free,
        };
    });
};

/**
 * Distance actually driven between two consecutive GPS fixes on the way to a door, or 0 when
 * the pair cannot be trusted: either fix vaguer than `FIX_ACCURACY_M`, out of order, or implying
 * a speed no car in a city reaches (a fix that jumped across town and back). Fixes arrive every
 * ~150 m, so the straight line between two is close to the road between them — no road factor.
 * Only the running total is ever stored; the fixes themselves are not kept.
 */
const FIX_ACCURACY_M = 100;
const MAX_SPEED_KMH = 150;
const segmentKm = (a, b) => {
    if (!has(a) || !has(b)) return 0;
    if ((a.accuracy ?? 0) > FIX_ACCURACY_M || (b.accuracy ?? 0) > FIX_ACCURACY_M) return 0;
    const hours = (new Date(b.at) - new Date(a.at)) / 3600000;
    if (!(hours > 0)) return 0;
    const km = haversineKm(a, b);
    return km / hours > MAX_SPEED_KMH ? 0 : km;
};

module.exports = { FIX_ACCURACY_M, MAX_SPEED_KMH, segmentKm, ROAD_FACTOR, SPEED_KMH, PARKING_MIN, VISIT_MIN, haversineKm, travelMinutes, etaMinutes, reachable, legsFor, has };
