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

const reserve = async (market, start) => {
    if (!indexReady) indexReady = CollectionSlot.init();
    await indexReady;
    const filter = { market: market.code, start, count: { $lt: market.visits.capacityPerSlot } };
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
    return M.slotsFor(market, { now, taken });
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
    assignee: visit.assignee?.name ? { name: visit.assignee.name } : null,
    tasks: (visit.tasks || []).map((t) => ({
        _id: String(t._id), kind: t.kind, status: t.status, orderId: String(t.orderId),
    })),
    orderIds: (visit.orderIds || []).map(String),
});

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

/**
 * Record a visit: each task `done` or `not_done`, a collected sample with its barcode.
 *
 * Everything is checked before anything is written, so a mistyped barcode on the third tube
 * does not leave the first two recorded and the visit half-finished.
 */
const completeVisit = async ({ visit, results, by, now = new Date() }) => {
    if (!['booked', 'assigned', 'en_route', 'arrived'].includes(visit.status)) {
        return fail(409, `A visit that is ${visit.status.replace('_', ' ')} cannot be completed.`, 'state');
    }
    const byTask = new Map((Array.isArray(results) ? results : []).map((r) => [String(r?.taskId), r]));
    const plan = [];
    for (const task of visit.tasks.filter((t) => t.status === 'pending')) {
        const r = byTask.get(String(task._id));
        if (!r || !['done', 'not_done'].includes(r.status)) {
            return fail(400, 'Record every item on the visit as done or not done.', 'incomplete');
        }
        const collecting = task.kind !== 'handover_bracelet';
        const barcode = r.barcode ? normaliseBarcode(r.barcode) : null;
        if (r.status === 'done' && collecting && !barcode) {
            return fail(400, 'Each collected sample needs the barcode from its label (6–32 letters and digits).', 'barcode');
        }
        plan.push({ task, status: r.status, barcode, note: clean(r.note, 300) });
    }

    const codes = plan.filter((p) => p.status === 'done' && p.task.kind !== 'handover_bracelet').map((p) => p.barcode);
    if (new Set(codes).size !== codes.length) return fail(400, 'The same barcode was entered twice.', 'duplicate');
    const used = await Specimen.find({ barcode: { $in: codes } }).select('barcode').lean();
    if (used.length) return fail(409, `Barcode ${used[0].barcode} is already on another sample. Check the label.`, 'duplicate');

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
            component.status = to;
            component.statusHistory.push({ status: to, at: now, note: p.barcode ? `Barcode ${p.barcode}` : 'Handed over at the visit' });
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
    if (specimen.status !== 'collected') {
        return fail(409, `Sample ${code} is already ${specimen.status}.`, 'state');
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
    visitView,
};
