/**
 * Who is working when — the roster as a table.
 *
 * Pure apart from `resolveTechnician` and `rosterFor`, which only read. A slot's capacity in a
 * market on `capacityMode: 'roster'` is the sum of `visitsPerSlot` over the technicians whose
 * shift covers the whole slot and who are not on time off that day. Market-wide, not per area:
 * a customer chooses a time before they type an address, so the slot list cannot know the
 * area yet. Areas decide *who* is assigned (`autoAssign`), not whether a slot is offered —
 * a visit in an area nobody on shift covers is left unassigned and shown as such.
 *
 * `autoAssign` is deterministic on purpose, the same argument every table here makes: an
 * administrator who presses it twice must get the same answer, and a test must be able to say
 * what that answer is. Route optimisation (phase 4) replaces the ordering, not the rules.
 */
const { localDay, partsInMinutes } = require('./markets');

const onTimeOff = (tech, ymd) => (tech.timeOff || []).some((t) => t.from <= ymd && ymd <= t.to);

const weekdayOf = (ymd) => {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

/** Does this technician's shift cover the whole slot starting at `start`? */
const onShift = (tech, market, start) => {
    if (!tech.active || tech.market !== market.code) return false;
    const at = start instanceof Date ? start : new Date(start);
    const ymd = localDay(at, market.timezone);
    if (onTimeOff(tech, ymd)) return false;
    const minute = partsInMinutes(at, market.timezone);
    const end = minute + market.visits.slotMinutes;
    const day = weekdayOf(ymd);
    return (tech.shifts || []).some((s) => s.day === day && s.startMinute <= minute && end <= s.endMinute);
};

const covers = (tech, city) => !tech.areas?.length || tech.areas.includes(city);

/** Places in one slot: fixed, or the technicians on shift. */
const capacityAt = (market, technicians, start) => (market.visits.capacityMode === 'roster'
    ? technicians.filter((t) => onShift(t, market, start)).reduce((n, t) => n + (t.visitsPerSlot || 1), 0)
    : market.visits.capacityPerSlot);

/**
 * Assign every unassigned visit of a day.
 *
 * For each visit in slot order: the candidates are technicians on shift for its slot, covering
 * its area, with room left in that slot; the one with the fewest visits that day wins, ties by
 * name. A visit with no candidate stays unassigned with a reason, so the timetable can say why.
 *
 * @param {object[]} visits       the day's visits (any status); only `booked` ones are assigned
 * @param {object[]} technicians  the market's technicians
 * @returns {{ assignments: { visitId, technicianId }[], unassigned: { visitId, reason }[] }}
 */
const autoAssign = (market, visits, technicians) => {
    const load = new Map(technicians.map((t) => [String(t._id), 0]));
    const perSlot = new Map(); // `${techId}|${iso}` → count
    const key = (techId, start) => `${techId}|${new Date(start).toISOString()}`;

    // What is already assigned counts against everyone.
    for (const v of visits) {
        if (!v.technicianId || !['assigned', 'en_route', 'arrived', 'completed'].includes(v.status)) continue;
        const id = String(v.technicianId);
        if (load.has(id)) load.set(id, load.get(id) + 1);
        perSlot.set(key(id, v.slot.start), (perSlot.get(key(id, v.slot.start)) || 0) + 1);
    }

    const assignments = [];
    const unassigned = [];
    const queue = visits.filter((v) => v.status === 'booked' && !v.technicianId)
        .sort((a, b) => new Date(a.slot.start) - new Date(b.slot.start) || String(a._id).localeCompare(String(b._id)));

    for (const v of queue) {
        const shift = technicians.filter((t) => onShift(t, market, v.slot.start));
        if (!shift.length) { unassigned.push({ visitId: String(v._id), reason: 'Nobody is on shift then' }); continue; }
        const area = shift.filter((t) => covers(t, v.address?.city));
        if (!area.length) { unassigned.push({ visitId: String(v._id), reason: `Nobody on shift covers ${v.address?.city}` }); continue; }
        const free = area.filter((t) => (perSlot.get(key(String(t._id), v.slot.start)) || 0) < (t.visitsPerSlot || 1));
        if (!free.length) { unassigned.push({ visitId: String(v._id), reason: 'Everyone covering that area is busy in that slot' }); continue; }
        free.sort((a, b) => load.get(String(a._id)) - load.get(String(b._id)) || a.name.localeCompare(b.name));
        const pick = free[0];
        const id = String(pick._id);
        load.set(id, load.get(id) + 1);
        perSlot.set(key(id, v.slot.start), (perSlot.get(key(id, v.slot.start)) || 0) + 1);
        assignments.push({ visitId: String(v._id), technicianId: id });
    }
    return { assignments, unassigned };
};

/** The market's active technicians. */
const rosterFor = (marketCode) => require('../models/Technician').find({ market: marketCode, active: true }).lean();

/**
 * The Technician behind whoever is signed in, or null.
 *
 * By `userId` first. Failing that, an unlinked profile whose email matches the session's
 * **verified** email is linked now — the same reason website orders are claimed only by a
 * verified email: anybody could otherwise sign up with a technician's address and receive
 * their round of home addresses.
 */
const resolveTechnician = async (auth) => {
    const Technician = require('../models/Technician');
    if (!auth?.userId) return null;
    const linked = await Technician.findOne({ userId: auth.userId });
    if (linked) return linked;
    if (!auth.emailVerified || !auth.email) return null;
    return Technician.findOneAndUpdate(
        { email: String(auth.email).toLowerCase(), userId: { $exists: false } },
        { $set: { userId: auth.userId } },
        { new: true }
    );
};

module.exports = { onShift, covers, capacityAt, autoAssign, rosterFor, resolveTechnician, onTimeOff };
