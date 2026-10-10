/**
 * A technician's own week or month, worked out from the records — never typed, never kept.
 *
 * Pure: no database, no clock it was not handed. The controller loads the visits and bags for
 * the period and the one before it; everything here is arithmetic over those rows, so the same
 * report can be shown to the technician and to an administrator and cannot disagree with either.
 *
 * Five rules, each a way the naive report is wrong:
 *
 *  1. **Days are the market's days.** A visit at 00:30 Dubai time is Tuesday's even though it is
 *     Monday in UTC; a week runs Monday to Sunday on the market's calendar.
 *  2. **Distance says how it was known.** A leg driven with location shared is `measured` (the
 *     running total `routing.segmentKm` kept on the visit); any other leg is `estimated` with the
 *     same rule assignment uses — from the previous door, or from the technician's base for the
 *     first of the day. A leg with no pin at either end is counted in `unknownLegs`, never as 0.
 *     The drive home is not known and not included, and the screen says so. Mileage is claimed
 *     against; a figure that hides how much of it is a guess is one somebody gets wrong.
 *  3. **Null, never zero.** No visits means no on-time rate, no completion rate and no
 *     comparison — not 0%, which would tell somebody on leave they were late everywhere.
 *  4. **On time means at the door before the window closed** — the promise the customer was given.
 *  5. **No ranking.** Nothing here compares one technician with another. It is a personal record.
 */
const routing = require('./routing');

const KM_PER_MILE = 1.609344;
/** Markets that measure roads in miles. Everyone else: kilometres. */
const MILES = new Set(['GB']);

const pad = (n) => String(n).padStart(2, '0');
const ymdOf = (t) => `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
const parse = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const addDays = (ymd, n) => { const t = parse(ymd); t.setUTCDate(t.getUTCDate() + n); return ymdOf(t); };
const fmt = (ymd, opts) => parse(ymd).toLocaleDateString('en-GB', { timeZone: 'UTC', ...opts });

/** The week (Mon–Sun) or calendar month containing `date`, as local day strings. */
const periodFor = (kind, date) => {
    let from;
    let to;
    if (kind === 'month') {
        const t = parse(date);
        from = ymdOf(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1)));
        to = ymdOf(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)));
    } else {
        const back = (parse(date).getUTCDay() + 6) % 7; // Monday = 0
        from = addDays(date, -back);
        to = addDays(from, 6);
    }
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    const sameMonth = from.slice(0, 7) === to.slice(0, 7);
    const label = kind === 'month'
        ? fmt(from, { month: 'long', year: 'numeric' })
        : `${fmt(from, sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' })}–${fmt(to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
    return { kind: kind === 'month' ? 'month' : 'week', from, to, days, label };
};

const previousOf = (period) => periodFor(period.kind, addDays(period.from, -1));

const firstAt = (visit, status) => {
    const h = (visit.statusHistory || []).find((e) => e.status === status);
    return h ? new Date(h.at) : null;
};

const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const round1 = (x) => Math.round(x * 10) / 10;

/** A visit somebody actually drove to: it was worked, whatever the outcome at the door. */
const DRIVEN = new Set(['en_route', 'arrived', 'completed', 'missed']);
const OPEN = new Set(['booked', 'assigned', 'en_route', 'arrived']);

/**
 * Totals for one period. `visits` may include rows outside it (the controller loads two periods
 * at once); only those whose slot falls on one of the period's local days count.
 */
const summarise = ({ period, timezone, visits, manifests = [], base = null, localDay }) => {
    const inPeriod = new Set(period.days);
    const mine = visits
        .map((v) => ({ v, day: localDay(new Date(v.slot.start), timezone) }))
        .filter((x) => inPeriod.has(x.day))
        .sort((a, b) => new Date(a.v.slot.start) - new Date(b.v.slot.start));

    const days = new Map(period.days.map((d) => [d, { date: d, done: 0, missed: 0, toDo: 0, measuredKm: 0, estimatedKm: 0, unknownLegs: 0 }]));
    const legs = [];
    const lastDoor = new Map(); // day → where the previous driven visit was

    const t = {
        done: 0, missed: 0, toDo: 0,
        blood: 0, dna: 0, bracelets: 0, notDone: 0,
        onTime: 0, late: 0, doorMinutes: [],
        pass: 0, manual: 0,
        measuredKm: 0, estimatedKm: 0, unknownLegs: 0,
    };

    for (const { v, day } of mine) {
        const d = days.get(day);
        if (v.status === 'completed') { t.done += 1; d.done += 1; }
        else if (v.status === 'missed') { t.missed += 1; d.missed += 1; }
        else if (OPEN.has(v.status)) { t.toDo += 1; d.toDo += 1; }

        if (v.status === 'completed') {
            for (const task of v.tasks || []) {
                if (task.status === 'not_done') t.notDone += 1;
                if (task.status !== 'done') continue;
                if (task.kind === 'collect_blood') t.blood += 1;
                if (task.kind === 'collect_dna') t.dna += 1;
                if (task.kind === 'handover_bracelet') t.bracelets += 1;
            }
            if (v.identity?.method === 'pass') t.pass += 1;
            if (v.identity?.method === 'manual') t.manual += 1;
        }

        const arrived = firstAt(v, 'arrived');
        if (arrived && ['completed', 'missed', 'arrived'].includes(v.status)) {
            if (arrived <= new Date(v.slot.end)) t.onTime += 1;
            else t.late += 1;
        }
        const finished = firstAt(v, 'completed');
        if (arrived && finished && finished > arrived) t.doorMinutes.push((finished - arrived) / 60000);

        if (!DRIVEN.has(v.status)) continue;
        const from = lastDoor.get(day) ?? base;
        lastDoor.set(day, v.address);
        let km = null;
        let how = 'estimated';
        if (Number(v.driven?.km) > 0) {
            km = Number(v.driven.km);
            how = 'measured';
        } else if (routing.has(from) && routing.has(v.address)) {
            km = routing.haversineKm(from, v.address) * routing.ROAD_FACTOR;
        }
        if (km === null) { t.unknownLegs += 1; d.unknownLegs += 1; continue; }
        if (how === 'measured') { t.measuredKm += km; d.measuredKm += km; }
        else { t.estimatedKm += km; d.estimatedKm += km; }
        legs.push({ day, km, how, area: v.address?.area || null });
    }

    const bags = manifests.filter((m) => inPeriod.has(localDay(new Date(m.handedOverAt), timezone)));
    const received = bags.filter((m) => m.receivedAt);
    const bagTotals = {
        count: bags.length,
        tubes: bags.reduce((n, m) => n + (m.barcodes?.length || 0), 0),
        received: received.length,
        awaiting: bags.length - received.length,
        missingTubes: received.reduce((n, m) => n + (m.missing?.length || 0), 0),
    };

    return { t, days: [...days.values()], legs, bags: bagTotals };
};

const distanceIn = (km, unit) => round1(unit === 'mi' ? km / KM_PER_MILE : km);

/** Plain sentences worth a technician's glance; at most four, and only ones that are true. */
const highlightsFor = ({ t, days, legs, bags, unit }) => {
    const out = [];
    const busiest = [...days].sort((a, b) => b.done - a.done || a.date.localeCompare(b.date))[0];
    if (busiest && busiest.done >= 2) {
        out.push({ kind: 'busiest', text: `Busiest day: ${fmt(busiest.date, { weekday: 'long', day: 'numeric', month: 'short' })}, ${busiest.done} visits done.` });
    }
    const longest = [...legs].sort((a, b) => b.km - a.km)[0];
    if (longest && longest.km >= 1) {
        out.push({
            kind: 'longest',
            text: `Longest drive: ${distanceIn(longest.km, unit)} ${unit}${longest.area ? ` to ${longest.area}` : ''}${longest.how === 'estimated' ? ' (estimated)' : ''}.`,
        });
    }
    if (bags.count && !bags.awaiting && !bags.missingTubes) {
        out.push({ kind: 'bags', text: `Every bag reached the lab complete — ${bags.count} bag${bags.count === 1 ? '' : 's'}, ${bags.tubes} tube${bags.tubes === 1 ? '' : 's'}.` });
    } else if (bags.missingTubes) {
        out.push({ kind: 'missing', text: `${bags.missingTubes} tube${bags.missingTubes === 1 ? ' was' : 's were'} not found in the bag at the lab. The office will be in touch.` });
    }
    const arrivals = t.onTime + t.late;
    if (arrivals >= 3 && !t.late) out.push({ kind: 'on_time', text: `On time at every door — ${arrivals} of ${arrivals}.` });
    return out.slice(0, 4);
};

/**
 * The report. `visits` and `manifests` should cover this period and the one before it.
 * `today` (a local day) marks days still to come, so the strip can draw them hollow.
 */
const buildReport = ({ kind = 'week', date, today, timezone, market, visits, manifests = [], base = null, localDay }) => {
    const period = periodFor(kind, date);
    const prev = previousOf(period);
    const unit = MILES.has(market) ? 'mi' : 'km';

    const cur = summarise({ period, timezone, visits, manifests, base, localDay });
    const old = summarise({ period: prev, timezone, visits, manifests, base, localDay });
    const { t } = cur;

    const worked = t.done + t.missed;
    const arrivals = t.onTime + t.late;
    const totalKm = t.measuredKm + t.estimatedKm;
    const samples = t.blood + t.dna;

    const prevWorked = old.t.done + old.t.missed;
    const prevArrivals = old.t.onTime + old.t.late;

    return {
        period: { kind: period.kind, from: period.from, to: period.to, label: period.label, today, isCurrent: today >= period.from && today <= period.to },
        unit,
        visits: { done: t.done, missed: t.missed, toDo: t.toDo, completionRate: worked ? t.done / worked : null },
        samples: { blood: t.blood, dna: t.dna, total: samples, notDone: t.notDone },
        bracelets: t.bracelets,
        distance: {
            total: distanceIn(totalKm, unit),
            measured: distanceIn(t.measuredKm, unit),
            estimated: distanceIn(t.estimatedKm, unit),
            unknownLegs: t.unknownLegs,
        },
        onTime: { onTime: t.onTime, late: t.late, rate: arrivals ? t.onTime / arrivals : null },
        doorMinutes: t.doorMinutes.length ? Math.round(median(t.doorMinutes)) : null,
        identity: { pass: t.pass, manual: t.manual },
        bags: cur.bags,
        days: cur.days.map((d) => ({
            date: d.date,
            done: d.done,
            missed: d.missed,
            toDo: d.toDo,
            future: d.date > today,
            distance: { measured: distanceIn(d.measuredKm, unit), estimated: distanceIn(d.estimatedKm, unit), unknownLegs: d.unknownLegs },
        })),
        highlights: highlightsFor({ t, days: cur.days, legs: cur.legs, bags: cur.bags, unit }),
        // Only a period somebody actually worked is something to compare against.
        previous: prevWorked ? {
            label: prev.label,
            done: old.t.done,
            samples: old.t.blood + old.t.dna,
            distance: distanceIn(old.t.measuredKm + old.t.estimatedKm, unit),
            onTimeRate: prevArrivals ? old.t.onTime / prevArrivals : null,
        } : null,
    };
};

module.exports = { KM_PER_MILE, periodFor, previousOf, buildReport, addDays };
