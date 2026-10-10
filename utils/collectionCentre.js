/**
 * Home sample collection: holding a slot, booking it, moving it, and recording what happened
 * at the door. Every surface — the app, the website, the portal, and the technician app in
 * phase 4 — goes through here, so a visit cannot be booked one way from one screen and
 * another way from the next.
 *
 * Four rules:
 *
 *  1. **A slot is never oversold.** `reserve` is one conditional increment on
 *     `CollectionSlot`; see that model for why it holds under concurrency.
 *  2. **A place is held while somebody pays, then released if they don't.** Checkout holds the
 *     slot for `HOLD_MINUTES`; payment turns the hold into a booking (`confirmForOrder`). A hold
 *     that lapses goes back to the slot (`expireHolds`). If the money lands after the hold
 *     lapsed and the slot has since filled, the order still completes and the visit asks the
 *     customer to choose again (`needs_rebooking`) — losing a paid order to a timer would be
 *     worse than one extra tap.
 *  3. **The visit moves the parcels, never the other way round.** Booking moves the order's
 *     home-collection components to `visit_booked`; a collected task moves its kit to
 *     `collected` and creates the `Specimen`; a handover moves the bracelet to `delivered`. The
 *     per-parcel admin endpoint refuses those stages (`orderComponents.VISIT_OWNED`).
 *  4. **No sample without a barcode, and no barcode twice.** A collected task must carry the
 *     label on the tube; a barcode already on a specimen is refused before anything is written.
 *
 * Notification failures never fail the action that prompted them (`publish` never throws).
 */
const Order = require('../models/Order');
const Product = require('../models/Product');
const Market = require('../models/Market');
const CollectionSlot = require('../models/CollectionSlot');
const CollectionVisit = require('../models/CollectionVisit');
const Specimen = require('../models/Specimen');
const C = require('./orderComponents');
const M = require('./markets');
const { publish } = require('./notificationCentre');
const roster = require('./roster');
const routing = require('./routing');
const crypto = require('crypto');

/** How old a technician's last position may be before an arrival estimate is withheld. */
const ETA_FRESH_MINUTES = 10;
/** The "about N minutes away" push, sent once per visit when the estimate first drops under this. */
const NEAR_MINUTES = 10;
/** A phone fix this vague is not used to pin a door. */
const PIN_ACCURACY_M = 100;

/**
 * How long a slot is held while somebody pays. Longer than the website's Stripe session (31
 * minutes, Stripe's minimum plus a margin), so a hold never lapses while its payment page can
 * still be paid.
 */
const HOLD_MINUTES = 35;

const ACTIVE = CollectionVisit.HOLDING;
const TASK_FOR = { blood: 'collect_blood', dna: 'collect_dna', bracelet: 'handover_bracelet' };
const KIND_OF = { collect_blood: 'blood', collect_dna: 'dna' };

const fail = (status, message, reason) => ({ ok: false, status, message, reason });

/** Six characters with no 0/O or 1/I/L — read off a phone on a doorstep, it has to survive. */
const PASS_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const newPassCode = () => {
    const bytes = crypto.randomBytes(6);
    return [...bytes].map((b) => PASS_ALPHABET[b % PASS_ALPHABET.length]).join('');
};

// ── Capacity ─────────────────────────────────────────────────────────────────

/**
 * Take one place in a slot, or report it full.
 *
 * The upsert creates the slot's row on its first booking. A duplicate-key error then means one
 * of two things: the slot is full (the filter skipped the full row and the insert collided with
 * it), or several people booked an empty slot at the same instant and another request created
 * the row first. The second is not "full", so it is retried once as a plain increment against
 * the row that now exists; only if that matches nothing is the slot full.
 */
// The unique index is the guarantee. Mongoose builds it in the background at startup, and a
// booking in the first moments after a deploy could otherwise race the build. Awaited once.
let indexReady = null;

/** Places in one slot right now: the fixed figure, or the technicians on shift. */
const capacityFor = async (market, start) => (market.visits.capacityMode === 'roster'
    ? roster.capacityAt(market, await roster.rosterFor(market.code), start)
    : market.visits.capacityPerSlot);

const reserve = async (market, start) => {
    if (!indexReady) indexReady = CollectionSlot.init();
    await indexReady;
    const capacity = await capacityFor(market, start);
    // Nobody on shift: the conditional below would match `count < 0` and refuse anyway, but an
    // upsert on an absent row would then *insert* one. Refuse before touching the collection.
    if (capacity <= 0) return false;
    const filter = { market: market.code, start, count: { $lt: capacity } };
    try {
        await CollectionSlot.findOneAndUpdate(filter, { $inc: { count: 1 } }, { upsert: true, new: true });
        return true;
    } catch (error) {
        if (error.code !== 11000) throw error;
    }
    const taken = await CollectionSlot.findOneAndUpdate(filter, { $inc: { count: 1 } }, { new: true });
    return Boolean(taken);
};

const release = (marketCode, start) =>
    CollectionSlot.updateOne({ market: marketCode, start, count: { $gt: 0 } }, { $inc: { count: -1 } });

/** Slot start (ISO) → places taken, for a window. */
const takenBetween = async (marketCode, from, to) => {
    const rows = await CollectionSlot.find({ market: marketCode, start: { $gte: from, $lt: to } }).lean();
    return new Map(rows.map((r) => [new Date(r.start).toISOString(), r.count]));
};

/** The bookable days for a market from `now`, with what is left in each slot. */
const availability = async (market, now = new Date()) => {
    const horizon = new Date(now.getTime() + (market.visits.bookAheadDays + 1) * 86400000);
    const taken = await takenBetween(market.code, now, horizon);
    if (market.visits.capacityMode !== 'roster') return M.slotsFor(market, { now, taken });
    const technicians = await roster.rosterFor(market.code);
    return M.slotsFor(market, { now, taken, capacityAt: (start) => roster.capacityAt(market, technicians, start) });
};

// ── Shapes ───────────────────────────────────────────────────────────────────

const clean = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/**
 * Validate the address a technician will need. Refused rather than patched: a visit to
 * "Dubai" with no building is a technician phoning around a city.
 */
const cleanVisitDetails = (input, market) => {
    const a = input?.address || {};
    const address = {
        building: clean(a.building, 120),
        street: clean(a.street, 120),
        area: clean(a.area, 80),
        city: clean(a.city, 60),
        landmark: clean(a.landmark, 120),
        makani: clean(a.makani, 20),
        country: (M.countriesFor(market)[0]) || undefined,
        lat: Number.isFinite(Number(a.lat)) && a.lat !== null && a.lat !== '' ? Number(a.lat) : undefined,
        lng: Number.isFinite(Number(a.lng)) && a.lng !== null && a.lng !== '' ? Number(a.lng) : undefined,
    };
    const phone = clean(input?.phone, 30);
    const errors = [];
    if (!address.building) errors.push('Add the building or villa.');
    if (!address.area) errors.push('Add the area or community.');
    if (!address.city) errors.push('Choose the city or emirate.');
    else if (market.visits.serviceAreas.length && !market.visits.serviceAreas.includes(address.city)) {
        errors.push(`We do not visit ${address.city} yet. We cover ${market.visits.serviceAreas.join(', ')}.`);
    }
    if (!phone || !/^[+\d][\d\s()-]{6,}$/.test(phone)) errors.push('Add a phone number the technician can call.');
    if (address.lat !== undefined && (address.lat < -90 || address.lat > 90)) delete address.lat;
    if (address.lng !== undefined && (address.lng < -180 || address.lng > 180)) delete address.lng;
    return errors.length
        ? { ok: false, errors }
        : { ok: true, value: { address, phone, contactName: clean(input?.contactName, 80), accessNotes: clean(input?.accessNotes, 500) } };
};

/** One task per home-collection parcel on these orders that has not been dealt with yet. */
const tasksFor = (orders) => orders.flatMap((order) =>
    order.items.flatMap((item) => (item.components || [])
        .filter((c) => c.method === 'home_collection' && ['placed', 'visit_booked'].includes(c.status))
        .map((c) => ({
            kind: TASK_FOR[c.kind],
            orderId: order._id,
            itemId: item._id,
            componentId: c._id,
        }))));

const requiresFastingFor = async (orders) => {
    const ids = orders.flatMap((o) => o.items.map((i) => i.productId));
    return Boolean(await Product.exists({ _id: { $in: ids }, requiresFasting: true }));
};

/** Re-derive an order's status from its components, recording the move. */
const rollUp = (order, note) => {
    const rolled = C.rollupStatus(order.items.flatMap((i) => i.components || []));
    if (rolled && rolled !== order.status && !['pending_payment', 'cancelled', 'refunded'].includes(order.status)) {
        order.transitionTo(rolled, note);
    }
};

/** Move every component a visit's tasks point at, when it is at `from`. */
const moveComponents = async (visit, from, to, note) => {
    const orders = await Order.find({ _id: { $in: visit.orderIds } });
    for (const order of orders) {
        let changed = false;
        for (const item of order.items) {
            for (const c of item.components || []) {
                if (c.method !== 'home_collection' || !from.includes(c.status)) continue;
                const tracked = visit.tasks.some((t) => String(t.componentId) === String(c._id));
                if (!tracked) continue;
                c.status = to;
                c.statusHistory.push({ status: to, at: new Date(), note });
                changed = true;
            }
        }
        if (changed) {
            rollUp(order, note);
            await order.save();
        }
    }
};

const visitView = (visit) => ({
    _id: String(visit._id),
    status: visit.status,
    market: visit.market,
    timezone: visit.timezone,
    slot: visit.slot,
    label: M.describeSlot(new Date(visit.slot.start), new Date(visit.slot.end), visit.timezone),
    address: visit.address,
    phone: visit.phone,
    contactName: visit.contactName || null,
    accessNotes: visit.accessNotes || null,
    requiresFasting: Boolean(visit.requiresFasting),
    holdExpiresAt: visit.holdExpiresAt || null,
    // The technician's first name only: enough to recognise who is at the door.
    assignee: visit.technicianId && typeof visit.technicianId === 'object' && visit.technicianId.name
        ? { name: String(visit.technicianId.name).split(' ')[0] }
        : visit.assignee?.name ? { name: visit.assignee.name } : null,
    identityChecked: Boolean(visit.identity?.method),
    // Minutes, never a position: the customer is told how long, not where the technician is.
    eta: etaOf(visit),
    tasks: (visit.tasks || []).map((t) => ({
        _id: String(t._id), kind: t.kind, status: t.status, orderId: String(t.orderId),
    })),
    orderIds: (visit.orderIds || []).map(String),
});

/** The current arrival estimate, or null when there is none worth showing. */
function etaOf(visit, now = new Date()) {
    const t = visit.tracking;
    if (visit.status !== 'en_route' || !t?.at || !Number.isFinite(t.etaMinutes)) return null;
    if (now - new Date(t.at) > ETA_FRESH_MINUTES * 60000) return null;
    return { minutes: t.etaMinutes, updatedAt: t.at };
}

// ── Notifications ────────────────────────────────────────────────────────────

const tell = (visit, key, title, body) => {
    if (!visit.userId) return; // a website order nobody has claimed yet has nobody to tell
    publish(String(visit.userId), {
        category: 'collection',
        title,
        body,
        route: `/collection/${visit._id}`,
        data: { type: 'collection', visitId: String(visit._id) },
        dedupeKey: `collection:${visit._id}:${key}`,
        source: 'collection',
    });
};

const labelOf = (visit) => M.describeSlot(new Date(visit.slot.start), new Date(visit.slot.end), visit.timezone);

const FASTING = ' Please fast for 8 hours before: water is fine.';

// ── Booking ──────────────────────────────────────────────────────────────────

/**
 * Hold a slot for an unpaid order. Called at checkout, app and website alike. The order must
 * already exist, so the visit can point at it; if the hold fails the caller discards the order.
 */
const holdForOrder = async ({ order, market, start, details, now = new Date() }) => {
    const check = M.isBookableStart(market, start, now);
    if (!check.ok) return fail(409, M.REFUSAL[check.reason], check.reason);
    const at = new Date(start);
    if (!(await reserve(market, at))) return fail(409, M.REFUSAL.full, 'full');

    try {
        const visit = await CollectionVisit.create({
            userId: order.userId || undefined,
            orderIds: [order._id],
            market: market.code,
            timezone: market.timezone,
            slot: { start: at, end: new Date(at.getTime() + market.visits.slotMinutes * 60000) },
            status: 'held',
            holdExpiresAt: new Date(now.getTime() + HOLD_MINUTES * 60000),
            passCode: newPassCode(),
            ...details,
            tasks: tasksFor([order]),
            requiresFasting: await requiresFastingFor([order]),
            statusHistory: [{ status: 'held', at: now, note: 'Held during checkout' }],
        });
        await Order.updateOne({ _id: order._id }, { $set: { 'fulfilment.visitId': visit._id } });
        return { ok: true, visit };
    } catch (error) {
        await release(market.code, at);
        throw error;
    }
};

/** A held or re-reserved visit becomes the customer's; its parcels move to `visit_booked`. */
const markBooked = async (visit, note) => {
    visit.transitionTo('booked', note, 'system');
    visit.holdExpiresAt = undefined;
    await visit.save();
    await moveComponents(visit, ['placed'], 'visit_booked', 'Collection visit booked');
    tell(visit, `booked:${new Date(visit.slot.start).toISOString()}`, 'Your collection visit is booked',
        `A technician will visit ${labelOf(visit)}.${visit.requiresFasting ? FASTING : ''}`);
};

/**
 * The order was paid (or placed with payment switched off): turn its held visit into a
 * booking. Idempotent — the webhook and the confirm call can both arrive.
 */
const confirmForOrder = async (orderId, now = new Date()) => {
    try {
        const order = await Order.findById(orderId).lean();
        const visitId = order?.fulfilment?.visitId;
        if (!visitId) return null;
        const visit = await CollectionVisit.findById(visitId);
        if (!visit) return null;

        if (visit.status === 'held') {
            await markBooked(visit, 'Payment received');
            return visit;
        }
        if (visit.status === 'expired') {
            // The hold lapsed before the money landed. Take the slot again if it is still free.
            const market = await Market.resolve(visit.market);
            const stillOffered = M.isBookableStart(market, visit.slot.start, now).ok;
            if (stillOffered && await reserve(market, new Date(visit.slot.start))) {
                await markBooked(visit, 'Payment received after the hold lapsed; slot still free');
            } else {
                visit.transitionTo('needs_rebooking', 'Paid after the hold lapsed and the slot had filled', 'system');
                visit.holdExpiresAt = undefined;
                await visit.save();
                tell(visit, 'rebook', 'Please choose a new visit time',
                    'Your payment went through, but the time you picked filled up while it did. Choose another and we will be there.');
            }
            return visit;
        }
        return visit; // already booked: nothing to do
    } catch (error) {
        console.error('❌ Confirming the collection visit failed:', error.message);
        return null;
    }
};

/**
 * Book a visit for paid orders that have none — "book later", or after a missed or cancelled
 * visit. No hold: the money has already been taken.
 */
const bookForOrders = async ({ orders, market, start, details, userId, now = new Date() }) => {
    const tasks = tasksFor(orders);
    if (!tasks.length) return fail(409, 'There is nothing on this order left to collect.', 'nothing');
    const check = M.isBookableStart(market, start, now);
    if (!check.ok) return fail(409, M.REFUSAL[check.reason], check.reason);
    const at = new Date(start);
    if (!(await reserve(market, at))) return fail(409, M.REFUSAL.full, 'full');

    try {
        const visit = await CollectionVisit.create({
            userId,
            orderIds: orders.map((o) => o._id),
            market: market.code,
            timezone: market.timezone,
            slot: { start: at, end: new Date(at.getTime() + market.visits.slotMinutes * 60000) },
            status: 'held',
            passCode: newPassCode(),
            ...details,
            tasks,
            requiresFasting: await requiresFastingFor(orders),
            statusHistory: [{ status: 'held', at: now, note: 'Booked after payment' }],
        });
        await Order.updateMany({ _id: { $in: orders.map((o) => o._id) } }, { $set: { 'fulfilment.visitId': visit._id } });
        await markBooked(visit, 'Booked');
        return { ok: true, visit };
    } catch (error) {
        await release(market.code, at);
        throw error;
    }
};

/** Has the customer's window to change this visit closed? Administrators are never cut off. */
const pastCutoff = (visit, market, now) =>
    new Date(visit.slot.start).getTime() - now.getTime() < market.visits.rescheduleCutoffHours * 3600000;

/** Move a visit to another slot: take the new place first, then give back the old. */
const reschedule = async ({ visit, start, by, now = new Date() }) => {
    if (!['booked', 'assigned', 'needs_rebooking'].includes(visit.status)) {
        return fail(409, `A visit that is ${visit.status.replace('_', ' ')} cannot be moved.`, 'state');
    }
    const market = await Market.resolve(visit.market);
    if (by === 'customer' && visit.status !== 'needs_rebooking' && pastCutoff(visit, market, now)) {
        return fail(409, `Visits can be changed up to ${market.visits.rescheduleCutoffHours} hours before. Please call us to change this one.`, 'cutoff');
    }
    const check = M.isBookableStart(market, start, now);
    if (!check.ok) return fail(409, M.REFUSAL[check.reason], check.reason);
    const at = new Date(start);
    if (at.getTime() === new Date(visit.slot.start).getTime() && visit.status !== 'needs_rebooking') {
        return { ok: true, visit };
    }
    if (!(await reserve(market, at))) return fail(409, M.REFUSAL.full, 'full');

    const held = visit.status !== 'needs_rebooking';
    const old = new Date(visit.slot.start);
    visit.slot = { start: at, end: new Date(at.getTime() + market.visits.slotMinutes * 60000) };
    // A technician assigned to the old time is not assigned to the new one.
    visit.assignee = undefined;
    visit.technicianId = undefined;
    visit.remindedAt = undefined;
    visit.transitionTo('booked', `Moved from ${old.toISOString()}`, by);
    await visit.save();
    if (held) await release(visit.market, old);
    await moveComponents(visit, ['placed'], 'visit_booked', 'Collection visit booked');
    tell(visit, `moved:${at.toISOString()}`, 'Your visit has moved', `Your technician will now visit ${labelOf(visit)}.`);
    return { ok: true, visit };
};

/** Cancel a visit. The order stands; its kits go back to waiting for a booking. */
const cancel = async ({ visit, by, now = new Date(), note, notify = true }) => {
    if (!ACTIVE.includes(visit.status) && visit.status !== 'needs_rebooking') {
        return fail(409, `A visit that is ${visit.status.replace('_', ' ')} cannot be cancelled.`, 'state');
    }
    const market = await Market.resolve(visit.market);
    if (by === 'customer' && pastCutoff(visit, market, now)) {
        return fail(409, `Visits can be cancelled up to ${market.visits.rescheduleCutoffHours} hours before. Please call us.`, 'cutoff');
    }
    const held = visit.status !== 'needs_rebooking';
    visit.cancelledBy = by;
    visit.tracking = undefined;
    visit.transitionTo('cancelled', note, by);
    await visit.save();
    if (held) await release(visit.market, new Date(visit.slot.start));
    await moveComponents(visit, ['visit_booked'], 'placed', 'Collection visit cancelled');
    if (by !== 'customer' && notify) {
        tell(visit, 'cancelled', 'Your collection visit was cancelled', 'Please choose a new time in the app.');
    }
    return { ok: true, visit };
};

/** Give back the places of holds nobody paid for. Run by `jobs/collectionJob.js`. */
const expireHolds = async (now = new Date()) => {
    const lapsed = await CollectionVisit.find({ status: 'held', holdExpiresAt: { $lte: now } });
    for (const visit of lapsed) {
        // Conditional, so a payment confirming the same visit at this moment wins cleanly.
        const res = await CollectionVisit.updateOne(
            { _id: visit._id, status: 'held' },
            { $set: { status: 'expired' }, $unset: { holdExpiresAt: '' }, $push: { statusHistory: { status: 'expired', at: now, note: 'Hold lapsed unpaid', by: 'system' } } }
        );
        if (res.modifiedCount) await release(visit.market, new Date(visit.slot.start));
    }
    return lapsed.length;
};

/**
 * The reminder before a visit, once. `REMINDER_HOURS` ahead because UAE visits run around the
 * clock — "the evening before" means nothing for a 03:00 slot — and twelve hours is long enough
 * to start a fast.
 */
const REMINDER_HOURS = 12;
const sendReminders = async (now = new Date()) => {
    const due = await CollectionVisit.find({
        status: { $in: ['booked', 'assigned'] },
        remindedAt: { $exists: false },
        'slot.start': { $gt: now, $lte: new Date(now.getTime() + REMINDER_HOURS * 3600000) },
    });
    for (const visit of due) {
        tell(visit, `reminder:${new Date(visit.slot.start).toISOString()}`, 'Your collection visit is coming up',
            `${labelOf(visit)}. Please be in and have your phone with you.${visit.requiresFasting ? FASTING : ''}`);
        await CollectionVisit.updateOne({ _id: visit._id }, { $set: { remindedAt: now } });
    }
    return due.length;
};

// ── At the door ──────────────────────────────────────────────────────────────

/** Our labels: letters, digits and dashes, 6–32 characters. Normalised to upper case. */
const normaliseBarcode = (value) => {
    if (typeof value !== 'string') return null;
    const code = value.trim().toUpperCase().replace(/\s+/g, '');
    return /^[A-Z0-9-]{6,32}$/.test(code) ? code : null;
};

/** A bracelet's serial or MAC address, as printed on the device or its box. */
const normaliseSerial = (value) => {
    if (typeof value !== 'string') return null;
    const code = value.trim().toUpperCase().replace(/\s+/g, '');
    return /^[A-Z0-9:-]{6,32}$/.test(code) ? code : null;
};

/**
 * Record a visit: each task `done` or `not_done`, a collected sample with its barcode.
 *
 * Everything is checked before anything is written, so a mistyped barcode on the third tube
 * does not leave the first two recorded and the visit half-finished.
 */
const completeVisit = async ({ visit, results, by, identityConfirmed = false, now = new Date() }) => {
    if (!['booked', 'assigned', 'en_route', 'arrived'].includes(visit.status)) {
        return fail(409, `A visit that is ${visit.status.replace('_', ' ')} cannot be completed.`, 'state');
    }
    // Before a single tube is labelled: is this the person the visit is for? The pass, or a
    // name and date-of-birth check the technician confirms — never neither.
    if (!visit.identity?.method && identityConfirmed !== true) {
        return fail(400, 'Confirm who you collected from: scan their visit pass, or check their name and date of birth.', 'identity');
    }
    const byTask = new Map((Array.isArray(results) ? results : []).map((r) => [String(r?.taskId), r]));
    const plan = [];
    for (const task of visit.tasks.filter((t) => t.status === 'pending')) {
        const r = byTask.get(String(task._id));
        if (!r || !['done', 'not_done'].includes(r.status)) {
            return fail(400, 'Record every item on the visit as done or not done.', 'incomplete');
        }
        const collecting = task.kind !== 'handover_bracelet';
        const barcode = r.barcode ? (collecting ? normaliseBarcode(r.barcode) : normaliseSerial(r.barcode)) : null;
        if (r.status === 'done' && collecting && !barcode) {
            return fail(400, 'Each collected sample needs the barcode from its label (6–32 letters and digits).', 'barcode');
        }
        // The serial is what links this bracelet to this person — the app pairs it by it.
        if (r.status === 'done' && !collecting && !barcode) {
            return fail(400, 'A handed-over bracelet needs the serial from the device or its box.', 'serial');
        }
        plan.push({ task, status: r.status, barcode, note: clean(r.note, 300) });
    }

    const codes = plan.filter((p) => p.status === 'done' && p.task.kind !== 'handover_bracelet').map((p) => p.barcode);
    if (new Set(codes).size !== codes.length) return fail(400, 'The same barcode was entered twice.', 'duplicate');
    const used = await Specimen.find({ barcode: { $in: codes } }).select('barcode').lean();
    if (used.length) return fail(409, `Barcode ${used[0].barcode} is already on another sample. Check the label.`, 'duplicate');
    const serials = plan.filter((p) => p.status === 'done' && p.task.kind === 'handover_bracelet').map((p) => p.barcode);
    if (serials.length && await Order.exists({ 'items.components.deviceSerial': { $in: serials } })) {
        return fail(409, 'That bracelet serial is already recorded against another order. Check the device.', 'duplicate');
    }

    const market = await Market.resolve(visit.market);
    const orders = await Order.find({ _id: { $in: visit.orderIds } });
    const findComponent = (task) => {
        const order = orders.find((o) => String(o._id) === String(task.orderId));
        const item = order?.items.id(task.itemId);
        return { order, component: item?.components?.find((c) => String(c._id) === String(task.componentId)) };
    };

    // Specimens first: the unique index is the last word on a barcode raced in from elsewhere.
    const created = [];
    try {
        for (const p of plan.filter((x) => x.status === 'done' && x.task.kind !== 'handover_bracelet')) {
            const { order } = findComponent(p.task);
            const kind = KIND_OF[p.task.kind];
            created.push(await Specimen.create({
                barcode: p.barcode,
                kind,
                userId: order?.userId || visit.userId || undefined,
                orderId: p.task.orderId,
                itemId: p.task.itemId,
                componentId: p.task.componentId,
                visitId: visit._id,
                lab: market?.labs?.[kind] || undefined,
                events: [{ type: 'collected', at: now, by }],
            }));
        }
    } catch (error) {
        await Specimen.deleteMany({ _id: { $in: created.map((s) => s._id) } });
        if (error.code === 11000) return fail(409, 'One of those barcodes is already on another sample.', 'duplicate');
        throw error;
    }

    for (const p of plan) {
        p.task.status = p.status;
        p.task.barcode = p.barcode || undefined;
        p.task.note = p.note;
        p.task.at = now;
        const { component } = findComponent(p.task);
        if (!component) continue;
        if (p.status === 'done') {
            const to = p.task.kind === 'handover_bracelet' ? 'delivered' : 'collected';
            if (p.task.kind === 'handover_bracelet') component.deviceSerial = p.barcode;
            component.status = to;
            component.statusHistory.push({ status: to, at: now, note: p.task.kind === 'handover_bracelet' ? `Handed over, serial ${p.barcode}` : `Barcode ${p.barcode}` });
        } else {
            // Not collected this time — a failed draw, a bracelet refused. Back to waiting for a visit.
            component.status = 'placed';
            component.statusHistory.push({ status: 'placed', at: now, note: `Not done at the visit${p.note ? `: ${p.note}` : ''}` });
        }
    }
    for (const order of orders) {
        rollUp(order, 'Collection visit');
        await order.save();
    }

    if (!visit.identity?.method) visit.identity = { method: 'manual', at: now, by };
    visit.tracking = undefined;
    visit.transitionTo('completed', `${plan.filter((p) => p.status === 'done').length} of ${plan.length} done`, by);
    await visit.save();

    const collected = plan.filter((p) => p.status === 'done' && p.task.kind !== 'handover_bracelet').length;
    const handed = plan.some((p) => p.status === 'done' && p.task.kind === 'handover_bracelet');
    const missedAny = plan.some((p) => p.status === 'not_done');
    tell(visit, 'completed',
        collected ? 'Your samples are on their way to the lab' : 'Your visit is complete',
        [
            collected ? `We collected ${collected === 1 ? 'your sample' : `${collected} samples`} and will tell you when the lab has ${collected === 1 ? 'it' : 'them'}.` : null,
            handed ? 'Pair your bracelet from the app to start recording.' : null,
            missedAny ? 'Something could not be done this time — book another visit from the app.' : null,
        ].filter(Boolean).join(' '));
    return { ok: true, visit, specimens: created };
};

/** Nobody was in. The kits go back to waiting, and the customer is asked to rebook. */
const markMissed = async ({ visit, by, note }) => {
    if (!['booked', 'assigned', 'en_route', 'arrived'].includes(visit.status)) {
        return fail(409, `A visit that is ${visit.status.replace('_', ' ')} cannot be marked missed.`, 'state');
    }
    visit.tracking = undefined;
    visit.transitionTo('missed', note, by);
    await visit.save();
    await moveComponents(visit, ['visit_booked'], 'placed', 'Collection visit missed');
    tell(visit, 'missed', 'We missed you', 'Our technician could not reach you. Choose a new time in the app and we will come back.');
    return { ok: true, visit };
};

/** The laboratory has the tube: a scan of its barcode moves the kit to `sample_received`. */
const receiveSpecimen = async ({ barcode, by, now = new Date() }) => {
    const code = normaliseBarcode(barcode);
    if (!code) return fail(400, 'That does not look like one of our barcodes.', 'invalid');
    const specimen = await Specimen.findOne({ barcode: code });
    if (!specimen) return fail(404, `No sample is registered under ${code}.`, 'unknown');
    if (!['collected', 'in_transit'].includes(specimen.status)) {
        return fail(409, `Sample ${code} is already ${specimen.status.replace('_', ' ')}.`, 'state');
    }
    specimen.status = 'received';
    specimen.events.push({ type: 'received', at: now, by });
    await specimen.save();

    const order = await Order.findById(specimen.orderId);
    const component = order?.items.id(specimen.itemId)?.components?.find((c) => String(c._id) === String(specimen.componentId));
    if (component && component.status === 'collected') {
        component.status = 'sample_received';
        component.statusHistory.push({ status: 'sample_received', at: now, note: `Barcode ${code} received` });
        rollUp(order, 'Sample received at the lab');
        await order.save();
        if (order.userId) {
            publish(String(order.userId), {
                category: 'order',
                title: 'The lab has your sample',
                body: `Your ${specimen.kind === 'dna' ? 'DNA' : 'blood'} sample has arrived at the laboratory.`,
                route: `/order-details?orderId=${order._id}`,
                dedupeKey: `specimen:${specimen._id}:received`,
                source: 'collection',
            });
        }
    }
    return { ok: true, specimen };
};

/**
 * The order was cancelled or refunded: its visit goes too, and its place back to the slot.
 * A visit serving another order as well is left alone — that order still needs it.
 */
const cancelForOrder = async (orderId, by = 'system') => {
    try {
        const visits = await CollectionVisit.find({ orderIds: orderId, status: { $in: [...ACTIVE, 'needs_rebooking'] } });
        for (const visit of visits) {
            if (visit.orderIds.length > 1) continue;
            // Not cut off: the order is gone, and a technician must not turn up for it. Not
            // announced either — the person was told about the order, which is the news.
            await cancel({ visit, by: by === 'customer' ? 'system' : by, note: 'Order cancelled', notify: false });
        }
    } catch (error) {
        console.error('❌ Cancelling the visit for an order failed:', error.message);
    }
};

// ── Technicians ──────────────────────────────────────────────────────────────

/**
 * Give a visit to a technician. Refused when they are inactive, in another market, or not on
 * shift for the slot; refused when they already have their slot's worth of visits — unless an
 * administrator passes `force`, because the person who knows that Omar can do two in Marina is
 * the one pressing the button.
 */
const assignTechnician = async ({ visit, technicianId, by, force = false }) => {
    if (!['booked', 'assigned'].includes(visit.status)) {
        return fail(409, `A visit that is ${visit.status.replace('_', ' ')} cannot be assigned.`, 'state');
    }
    if (!technicianId) {
        visit.technicianId = undefined;
        visit.assignee = undefined;
        visit.transitionTo('booked', 'Unassigned', by);
        await visit.save();
        return { ok: true, visit };
    }
    const Technician = require('../models/Technician');
    const tech = await Technician.findById(technicianId).lean();
    if (!tech || !tech.active) return fail(404, 'No active technician with that id.', 'unknown');
    const market = await Market.resolve(visit.market);
    if (tech.market !== market.code) return fail(409, `${tech.name} works in another market.`, 'market');
    if (!force) {
        if (!roster.onShift(tech, market, visit.slot.start)) return fail(409, `${tech.name} is not on shift at that time.`, 'shift');
        const busy = await CollectionVisit.countDocuments({
            _id: { $ne: visit._id }, technicianId: tech._id, 'slot.start': visit.slot.start,
            status: { $in: ['assigned', 'en_route', 'arrived'] },
        });
        if (busy >= (tech.visitsPerSlot || 1)) return fail(409, `${tech.name} already has a visit in that slot.`, 'busy');
    }
    visit.technicianId = tech._id;
    visit.assignee = undefined;
    visit.transitionTo('assigned', `Assigned to ${tech.name}${force ? ' (overridden)' : ''}`, by);
    await visit.save();
    return { ok: true, visit, technician: tech };
};

/** Assign a whole day's unassigned visits by the deterministic rule in `roster.autoAssign`. */
const autoAssignDay = async ({ market, date, by }) => {
    const from = M.localToUtc(date, 0, market.timezone);
    const to = M.localToUtc(date, 24 * 60, market.timezone);
    const [visits, technicians] = await Promise.all([
        CollectionVisit.find({ market: market.code, 'slot.start': { $gte: from, $lt: to } }),
        roster.rosterFor(market.code),
    ]);
    const plan = roster.autoAssign(market, visits.map((v) => v.toObject()), technicians);
    const byId = new Map(technicians.map((t) => [String(t._id), t]));
    for (const a of plan.assignments) {
        const visit = visits.find((v) => String(v._id) === a.visitId);
        visit.technicianId = a.technicianId;
        visit.transitionTo('assigned', `Auto-assigned to ${byId.get(a.technicianId).name}`, by);
        await visit.save();
    }
    return plan;
};

/** The technician has set off: the customer is told. */
const startVisit = async ({ visit, by }) => {
    if (visit.status !== 'assigned') return fail(409, `A visit that is ${visit.status.replace('_', ' ')} cannot be started.`, 'state');
    visit.transitionTo('en_route', 'On the way', by);
    await visit.save();
    const tech = visit.technicianId ? await require('../models/Technician').findById(visit.technicianId).select('name').lean() : null;
    tell(visit, 'en_route', 'Your technician is on the way',
        `${tech ? `${tech.name.split(' ')[0]} is` : 'Your technician is'} heading to you now. Have your visit pass ready in the app.`);
    return { ok: true, visit };
};

/**
 * Pin the door from the technician's phone, once, if nobody has: the next visit to this
 * address can then be routed. A vague fix (indoors, a basement) is not used — a pin 300 m off
 * sends the next technician to the wrong tower.
 */
const has = (p) => Boolean(p) && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));

const learnDoor = (visit, fix) => {
    if (!fix || routing.has(visit.address)) return;
    const lat = Number(fix.lat);
    const lng = Number(fix.lng);
    const accuracy = Number(fix.accuracy);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
    if (!Number.isFinite(accuracy) || accuracy > PIN_ACCURACY_M) return;
    visit.address.lat = lat;
    visit.address.lng = lng;
    visit.address.coordSource = 'technician';
};

const arriveVisit = async ({ visit, by, fix }) => {
    if (!['assigned', 'en_route'].includes(visit.status)) return fail(409, `A visit that is ${visit.status.replace('_', ' ')} cannot be marked arrived.`, 'state');
    learnDoor(visit, fix);
    // The last stretch: from the final fix on the way to the door itself.
    // The phone's own fix at the door, or the door's pin when it sent none.
    const door = has(fix) ? { ...fix, at: fix.at || new Date() }
        : routing.has(visit.address) ? { lat: visit.address.lat, lng: visit.address.lng, at: new Date() } : null;
    if (visit.tracking?.at && door) addDriven(visit, visit.tracking, door);
    // At the door: the position is no longer needed, and is not kept.
    visit.tracking = undefined;
    visit.transitionTo('arrived', 'At the door', by);
    await visit.save();
    return { ok: true, visit };
};

/**
 * Where the technician is, while on the way. Turned into minutes against the door when the
 * door is pinned; the customer is told once when it first drops under ten. Refused in any
 * other state, so a phone that keeps reporting after arrival writes nothing.
 */
/** Add one trusted stretch to the visit's running distance. */
const addDriven = (visit, from, to) => {
    const km = routing.segmentKm(
        { lat: from.lat, lng: from.lng, accuracy: from.accuracy, at: from.at },
        { lat: Number(to.lat), lng: Number(to.lng), accuracy: to.accuracy, at: to.at },
    );
    if (!km) return;
    visit.driven = { km: Math.round(((visit.driven?.km || 0) + km) * 1000) / 1000, fixes: (visit.driven?.fixes || 0) + 1 };
};

const updateLocation = async ({ visit, fix, now = new Date() }) => {
    if (visit.status !== 'en_route') return fail(409, 'Location is only shared on the way to a visit.', 'state');
    const lat = Number(fix?.lat);
    const lng = Number(fix?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return fail(400, 'A location needs a latitude and longitude.', 'invalid');
    }
    const at = fix.at && !Number.isNaN(new Date(fix.at).getTime()) ? new Date(fix.at) : now;
    // A queued fix older than the one held is history, not news.
    if (visit.tracking?.at && at < new Date(visit.tracking.at)) return { ok: true, visit };
    const eta = routing.etaMinutes({ lat, lng }, visit.address);
    const nearAnnounced = Boolean(visit.tracking?.nearAnnounced);
    const accuracy = Number.isFinite(Number(fix.accuracy)) ? Number(fix.accuracy) : undefined;
    if (visit.tracking?.at) addDriven(visit, visit.tracking, { lat, lng, accuracy, at });
    visit.tracking = {
        lat, lng,
        accuracy: Number.isFinite(Number(fix.accuracy)) ? Number(fix.accuracy) : undefined,
        at,
        etaMinutes: eta ?? undefined,
        nearAnnounced: nearAnnounced || (eta !== null && eta <= NEAR_MINUTES),
    };
    await visit.save();
    if (!nearAnnounced && eta !== null && eta <= NEAR_MINUTES) {
        tell(visit, 'near', 'Your technician is nearly there',
            `About ${eta} minute${eta === 1 ? '' : 's'} away. Have your visit pass ready in the app.`);
    }
    return { ok: true, visit };
};

/**
 * Check the visit pass at the door. Compared in constant time; a wrong code changes nothing
 * and says only that it did not match — it never says what the right one is.
 */
const verifyPass = async ({ visit, code, by, fix, now = new Date() }) => {
    if (!['assigned', 'en_route', 'arrived'].includes(visit.status)) {
        return fail(409, `A visit that is ${visit.status.replace('_', ' ')} cannot be checked in.`, 'state');
    }
    const sent = String(code || '').toUpperCase().replace(/[\s-]/g, '');
    const want = String(visit.passCode || '');
    const ok = want.length > 0 && sent.length === want.length
        && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(want));
    if (!ok) return fail(400, 'That pass does not match this visit. Check you are at the right address.', 'mismatch');
    visit.identity = { method: 'pass', at: now, by };
    learnDoor(visit, fix);
    visit.tracking = undefined;
    if (visit.status !== 'arrived') visit.transitionTo('arrived', 'Visit pass checked', by);
    else visit.statusHistory.push({ status: 'arrived', at: now, note: 'Visit pass checked', by });
    await visit.save();
    return { ok: true, visit };
};

// ── Hand-over to the laboratory ──────────────────────────────────────────────

const MANIFEST_ALPHABET = PASS_ALPHABET;
const newManifestCode = () => `PQM-${[...crypto.randomBytes(6)].map((b) => MANIFEST_ALPHABET[b % MANIFEST_ALPHABET.length]).join('')}`;

/**
 * Put a bag of tubes on its way to a laboratory. Every barcode must be a tube *this
 * technician* collected, not yet handed over, destined for *this* laboratory — a blood tube in
 * the DNA bag is refused here rather than discovered at the wrong bench.
 */
const handOver = async ({ technician, lab, barcodes, by, now = new Date() }) => {
    const SampleManifest = require('../models/SampleManifest');
    const labCode = String(lab || '').trim().toUpperCase();
    if (!labCode) return fail(400, 'Choose the laboratory this bag is going to.', 'lab');
    const codes = [...new Set((Array.isArray(barcodes) ? barcodes : []).map(normaliseBarcode))];
    if (!codes.length || codes.includes(null)) return fail(400, 'Scan every tube going into the bag.', 'barcode');

    const specimens = await Specimen.find({ barcode: { $in: codes } });
    const found = new Map(specimens.map((sp) => [sp.barcode, sp]));
    const visitIds = specimens.map((sp) => sp.visitId).filter(Boolean);
    const mine = new Set((await CollectionVisit.find({ _id: { $in: visitIds }, technicianId: technician._id }).select('_id').lean()).map((v) => String(v._id)));
    for (const code of codes) {
        const sp = found.get(code);
        if (!sp || !mine.has(String(sp.visitId))) return fail(404, `${code} is not a sample you collected.`, 'unknown');
        if (sp.status !== 'collected') return fail(409, `${code} is already ${sp.status.replace('_', ' ')}.`, 'state');
        if (sp.lab && sp.lab !== labCode) return fail(409, `${code} goes to ${sp.lab}, not ${labCode}. Bag it separately.`, 'lab');
    }

    let manifest = null;
    for (let i = 0; i < 3 && !manifest; i++) {
        try {
            manifest = await SampleManifest.create({
                code: newManifestCode(), technicianId: technician._id, market: technician.market, lab: labCode,
                specimenIds: specimens.map((sp) => sp._id), barcodes: codes, handedOverAt: now,
            });
        } catch (error) {
            if (error.code !== 11000) throw error;
        }
    }
    await Specimen.updateMany(
        { _id: { $in: specimens.map((sp) => sp._id) }, status: 'collected' },
        { $set: { status: 'in_transit', manifestId: manifest._id }, $push: { events: { type: 'handed_over', at: now, by, note: manifest.code } } }
    );
    return { ok: true, manifest };
};

/**
 * The bag has arrived: every tube on its manifest is received at once. A tube the bench did
 * not find is named in `missing` and left in transit, so it stays visible as a gap.
 */
const receiveManifest = async ({ code, missing = [], by, now = new Date() }) => {
    const SampleManifest = require('../models/SampleManifest');
    const manifest = await SampleManifest.findOne({ code: String(code || '').trim().toUpperCase() });
    if (!manifest) return fail(404, 'No bag with that code.', 'unknown');
    if (manifest.receivedAt) return fail(409, 'That bag has already been received.', 'state');
    const absent = new Set((Array.isArray(missing) ? missing : []).map(normaliseBarcode).filter(Boolean));
    const received = [];
    for (const barcode of manifest.barcodes) {
        if (absent.has(barcode)) continue;
        const r = await receiveSpecimen({ barcode, by, now });
        if (r.ok) received.push(barcode);
    }
    manifest.receivedAt = now;
    manifest.receivedBy = by;
    manifest.missing = [...absent];
    await manifest.save();
    return { ok: true, manifest, received };
};

/** A claimed website order brings its visit with it. */
const claimVisits = (orderIds, userId) =>
    CollectionVisit.updateMany({ orderIds: { $in: orderIds }, userId: null }, { $set: { userId } });

module.exports = {
    HOLD_MINUTES,
    REMINDER_HOURS,
    reserve,
    release,
    availability,
    cleanVisitDetails,
    tasksFor,
    holdForOrder,
    confirmForOrder,
    bookForOrders,
    reschedule,
    cancel,
    expireHolds,
    sendReminders,
    normaliseBarcode,
    completeVisit,
    markMissed,
    receiveSpecimen,
    claimVisits,
    cancelForOrder,
    updateLocation,
    handOver,
    receiveManifest,
    etaOf,
    visitView,
    capacityFor,
    normaliseSerial,
    assignTechnician,
    autoAssignDay,
    startVisit,
    arriveVisit,
    verifyPass,
};
