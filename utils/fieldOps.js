/**
 * The live operations board for one market: where each technician is, what they are doing,
 * what is waiting, and how the orders are flowing. Pure — the controller loads the rows.
 *
 * **Where a technician is, and how we know.** A position is only ever one of these, and the
 * board says which, because a dispatcher acting on a dot needs to know whether it is a GPS fix
 * from thirty seconds ago or a door they left at noon:
 *
 *   live       on the way to a visit; the phone's last fix (stale after ETA_FRESH minutes)
 *   door       at a door right now — the visit's own pin
 *   last_door  between visits; the last door they finished today, with when
 *   base       nothing worked yet today; their start point
 *
 * Nothing else exists. The server keeps a fix only while a visit is "on the way" and clears it
 * at the door (`collectionCentre.arriveVisit`), so a technician off shift or between visits is
 * never tracked — the board shows where they *were working*, never where they are now.
 *
 * States, in the order a dispatcher cares about them:
 *   at_door, en_route, between (has more today), done_today, idle (nothing assigned), off_shift
 */
const routing = require('./routing');
const roster = require('./roster');
const { etaOf, ETA_FRESH_MINUTES } = require('./collectionCentre');

const LIVE = new Set(['en_route', 'arrived']);
const TO_DO = new Set(['booked', 'assigned', 'en_route', 'arrived']);
const pin = (a) => (routing.has(a) ? { lat: a.lat, lng: a.lng } : null);
const lastAt = (v, status) => {
    const h = [...(v.statusHistory || [])].reverse().find((e) => e.status === status);
    return h ? new Date(h.at) : null;
};

/** A visit as the board draws it: no phone, no contact name, no pass code. */
const visitPin = (v, now) => ({
    _id: String(v._id),
    status: v.status,
    start: v.slot.start,
    end: v.slot.end,
    area: v.address?.area || null,
    building: v.address?.building || null,
    city: v.address?.city || null,
    at: pin(v.address),
    technicianId: v.technicianId ? String(v.technicianId) : null,
    tasks: (v.tasks || []).map((t) => ({ kind: t.kind, status: t.status })),
    eta: etaOf(v, now),
    late: TO_DO.has(v.status) && v.status !== 'arrived' && new Date(v.slot.end) < now,
});

const positionOf = (tech, visits, now) => {
    const moving = visits.find((v) => v.status === 'en_route' && v.tracking?.at && Number.isFinite(v.tracking.lat));
    if (moving) {
        const at = new Date(moving.tracking.at);
        return {
            lat: moving.tracking.lat, lng: moving.tracking.lng, at, source: 'live',
            stale: now - at > ETA_FRESH_MINUTES * 60000, accuracy: moving.tracking.accuracy ?? null,
        };
    }
    const atDoor = visits.find((v) => v.status === 'arrived' && routing.has(v.address));
    if (atDoor) return { ...pin(atDoor.address), at: lastAt(atDoor, 'arrived'), source: 'door', stale: false };
    const finished = visits
        .filter((v) => ['completed', 'missed'].includes(v.status) && routing.has(v.address))
        .map((v) => ({ v, at: lastAt(v, v.status) || new Date(v.slot.end) }))
        .sort((a, b) => b.at - a.at)[0];
    if (finished) return { ...pin(finished.v.address), at: finished.at, source: 'last_door', stale: false };
    if (routing.has(tech.base)) return { lat: tech.base.lat, lng: tech.base.lng, at: null, source: 'base', stale: false };
    return null;
};

const stateOf = (tech, market, visits, now) => {
    if (visits.some((v) => v.status === 'arrived')) return 'at_door';
    if (visits.some((v) => v.status === 'en_route')) return 'en_route';
    const left = visits.filter((v) => TO_DO.has(v.status)).length;
    if (left) return 'between';
    if (visits.some((v) => ['completed', 'missed'].includes(v.status))) return 'done_today';
    return roster.onShift(tech, market, now) ? 'idle' : 'off_shift';
};

/**
 * @param market   resolved market
 * @param technicians  active technicians in the market
 * @param visits   today's visits in the market (any technician, or none)
 * @param week     { [technicianId]: report } from fieldReport, optional
 * @param pipeline counts from the controller
 */
const board = ({ market, technicians, visits, week = {}, pipeline, specimens, bags, now = new Date(), today }) => {
    const byTech = new Map(technicians.map((t) => [String(t._id), []]));
    for (const v of visits) {
        const id = v.technicianId ? String(v.technicianId) : null;
        if (id && byTech.has(id)) byTech.get(id).push(v);
    }

    const crew = technicians.map((t) => {
        const mine = (byTech.get(String(t._id)) || []).sort((a, b) => new Date(a.slot.start) - new Date(b.slot.start));
        const current = mine.find((v) => LIVE.has(v.status)) || null;
        const next = mine.find((v) => v.status === 'assigned' && new Date(v.slot.end) >= now) || null;
        const done = mine.filter((v) => v.status === 'completed');
        // Today's route, base first, for the map's line when a technician is selected.
        const route = [pin(t.base), ...mine.map((v) => pin(v.address))].filter(Boolean);
        const r = week[String(t._id)];
        return {
            _id: String(t._id),
            name: t.name,
            phone: t.phone || null,
            areas: t.areas || [],
            base: t.base?.label || null,
            state: stateOf(t, market, mine, now),
            onShift: roster.onShift(t, market, now),
            position: positionOf(t, mine, now),
            current: current ? visitPin(current, now) : null,
            next: next ? visitPin(next, now) : null,
            today: {
                total: mine.length,
                done: done.length,
                missed: mine.filter((v) => v.status === 'missed').length,
                toDo: mine.filter((v) => TO_DO.has(v.status)).length,
                samples: done.reduce((n, v) => n + (v.tasks || []).filter((k) => k.status === 'done' && k.kind !== 'handover_bracelet').length, 0),
            },
            legs: routing.legsFor(mine, t.base).filter((l) => l.tight).length,
            route,
            week: r ? {
                done: r.visits.done,
                missed: r.visits.missed,
                samples: r.samples.total,
                distance: r.distance.total,
                unit: r.unit,
                onTimeRate: r.onTime.rate,
            } : null,
        };
    });

    const STATE_ORDER = ['at_door', 'en_route', 'between', 'idle', 'done_today', 'off_shift'];
    crew.sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || a.name.localeCompare(b.name));

    const pins = visits.map((v) => visitPin(v, now));
    const count = (pred) => pins.filter(pred).length;
    return {
        market: { code: market.code, name: market.name, timezone: market.timezone },
        today,
        now,
        totals: {
            visits: pins.length,
            done: count((p) => p.status === 'completed'),
            missed: count((p) => p.status === 'missed'),
            unassigned: count((p) => p.status === 'booked'),
            onTheRoad: crew.filter((c) => c.state === 'en_route').length,
            atDoors: crew.filter((c) => c.state === 'at_door').length,
            late: count((p) => p.late),
            samples: crew.reduce((n, c) => n + c.today.samples, 0),
            onShift: crew.filter((c) => c.onShift).length,
            crew: crew.length,
        },
        pipeline,
        specimens,
        bags,
        crew,
        visits: pins,
    };
};

module.exports = { board, positionOf, stateOf };
