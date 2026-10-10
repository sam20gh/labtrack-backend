const mongoose = require('mongoose');
const Market = require('../models/Market');
const Order = require('../models/Order');
const CollectionVisit = require('../models/CollectionVisit');
const Specimen = require('../models/Specimen');
const M = require('../utils/markets');
const collection = require('../utils/collectionCentre');
const { normaliseCurrency } = require('../utils/currency');
const roster = require('../utils/roster');
const QRCode = require('qrcode');

/**
 * Home sample collection — the HTTP surface. The rules live in `utils/collectionCentre.js`;
 * these handlers find the records, check who may touch them, and answer.
 *
 * Three audiences:
 *   - **public**     what a market offers and which slots are free — the website shows both
 *                    to people with no account
 *   - **customer**   their own visits: list, book, move, cancel
 *   - **admin**      the timetable, assignment, completion with barcodes, lab receipt
 */

const marketFromQuery = async (req) => {
    const code = req.query.market
        ? String(req.query.market).toUpperCase()
        : M.marketCodeForCurrency(normaliseCurrency(req.query.currency) || 'GBP');
    return Market.resolve(code);
};

/** What a storefront needs to draw the choice and the form. Nothing internal. */
const publicMarket = (market) => ({
    code: market.code,
    name: market.name,
    currency: market.currency,
    timezone: market.timezone,
    options: M.fulfilmentOptions(market),
    visits: market.fulfilment.homeCollection
        ? {
            price: market.visits.price,
            slotMinutes: market.visits.slotMinutes,
            serviceAreas: market.visits.serviceAreas,
            rescheduleCutoffHours: market.visits.rescheduleCutoffHours,
        }
        : null,
});

/** GET /api/collection/market?currency=AED — how this market is served. */
exports.getMarket = async (req, res) => {
    try {
        const market = await marketFromQuery(req);
        if (!market) return res.status(404).json({ message: 'We do not sell there yet.' });
        res.json(publicMarket(market));
    } catch (error) {
        console.error('❌ Market lookup failed:', error);
        res.status(500).json({ message: 'Could not load delivery options' });
    }
};

/**
 * GET /api/collection/slots?currency=AED — every bookable slot, with what is left.
 * A full slot is returned with `remaining: 0` rather than dropped, so a person can see the
 * morning is busy rather than wonder why 09:00 is missing.
 */
exports.getSlots = async (req, res) => {
    try {
        const market = await marketFromQuery(req);
        if (!market) return res.status(404).json({ message: 'We do not sell there yet.' });
        if (!market.fulfilment.homeCollection) {
            return res.status(404).json({ message: `Home collection is not available in ${market.name}.` });
        }
        const days = await collection.availability(market, new Date());
        res.json({ market: publicMarket(market), days });
    } catch (error) {
        console.error('❌ Slot lookup failed:', error);
        res.status(500).json({ message: 'Could not load visit times' });
    }
};

// ── Customer ─────────────────────────────────────────────────────────────────

const ownVisit = async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
        res.status(404).json({ message: 'Visit not found' });
        return null;
    }
    const visit = await CollectionVisit.findOne({ _id: req.params.id, userId: req.auth.userId }).populate('technicianId', 'name');
    if (!visit) res.status(404).json({ message: 'Visit not found' });
    return visit;
};

/** GET /api/collection/visits — the person's visits, the next one first. */
exports.listMine = async (req, res) => {
    try {
        const visits = await CollectionVisit.find({ userId: req.auth.userId, status: { $ne: 'expired' } })
            .sort({ 'slot.start': -1 })
            .limit(30)
            .populate('technicianId', 'name')
            .lean();
        const now = Date.now();
        const view = visits.map(collection.visitView);
        const upcoming = view.filter((v) => new Date(v.slot.start).getTime() >= now).reverse();
        const past = view.filter((v) => new Date(v.slot.start).getTime() < now);
        res.json({ visits: [...upcoming, ...past] });
    } catch (error) {
        res.status(500).json({ message: 'Could not load your visits', error: error.message });
    }
};

/** GET /api/collection/visits/:id */
exports.getMine = async (req, res) => {
    try {
        const visit = await ownVisit(req, res);
        if (!visit) return;
        const market = await Market.resolve(visit.market);
        res.json({
            visit: collection.visitView(visit),
            canChange: ['booked', 'assigned', 'needs_rebooking'].includes(visit.status)
                && (visit.status === 'needs_rebooking'
                    || new Date(visit.slot.start).getTime() - Date.now() >= market.visits.rescheduleCutoffHours * 3600000),
            cutoffHours: market.visits.rescheduleCutoffHours,
        });
    } catch (error) {
        res.status(500).json({ message: 'Could not load the visit', error: error.message });
    }
};

/**
 * POST /api/collection/visits { orderId, slotStart, address, phone, ... }
 *
 * Book a visit for a paid order that has none — chosen "later" at checkout, or after a visit
 * was missed or cancelled. Every unfinished home-collection parcel on the order goes on it.
 */
exports.bookMine = async (req, res) => {
    try {
        const { orderId, slotStart } = req.body || {};
        if (!mongoose.isValidObjectId(orderId)) return res.status(400).json({ message: 'Choose the order this visit is for.' });
        const order = await Order.findOne({ _id: orderId, userId: req.auth.userId });
        if (!order) return res.status(404).json({ message: 'Order not found' });
        if (order.payment?.status !== 'paid' && order.status === 'pending_payment') {
            return res.status(409).json({ message: 'Finish paying for this order first.' });
        }
        if (['cancelled', 'refunded'].includes(order.status)) {
            return res.status(409).json({ message: `This order was ${order.status}.` });
        }
        const live = order.fulfilment?.visitId
            ? await CollectionVisit.findOne({ _id: order.fulfilment.visitId, status: { $in: CollectionVisit.HOLDING } })
            : null;
        if (live) return res.status(409).json({ message: 'This order already has a visit booked.', visitId: String(live._id) });

        const market = await Market.resolve(order.fulfilment?.market || M.marketCodeForCurrency(order.currency));
        if (!market?.fulfilment.homeCollection) return res.status(409).json({ message: 'Home collection is not available for this order.' });
        const details = collection.cleanVisitDetails(req.body, market);
        if (!details.ok) return res.status(400).json({ message: details.errors[0], errors: details.errors });

        const result = await collection.bookForOrders({
            orders: [order], market, start: slotStart, details: details.value, userId: order.userId,
        });
        if (!result.ok) return res.status(result.status).json({ message: result.message, reason: result.reason });
        res.status(201).json({ visit: collection.visitView(result.visit) });
    } catch (error) {
        console.error('❌ Booking a visit failed:', error);
        res.status(500).json({ message: 'Could not book the visit', error: error.message });
    }
};

/**
 * GET /api/collection/visits/:id/pass — the visit pass: a QR code and the same six characters.
 *
 * Only for a visit a technician is still coming to. The QR carries the visit's id and the code
 * (`PQV1:<visitId>:<code>`) — no name, no address, nothing a stranger could use — so the
 * technician's scan proves both that this is the right visit and the right person's phone.
 * The SVG is drawn here so the app needs no QR library (and no new native build).
 */
exports.getPass = async (req, res) => {
    try {
        const visit = await ownVisit(req, res);
        if (!visit) return;
        if (!['booked', 'assigned', 'en_route', 'arrived'].includes(visit.status) || !visit.passCode) {
            return res.status(409).json({ message: 'This visit has no pass to show.' });
        }
        const payload = `PQV1:${visit._id}:${visit.passCode}`;
        const svg = await QRCode.toString(payload, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
        res.set('Cache-Control', 'no-store');
        res.json({ code: `${visit.passCode.slice(0, 3)} ${visit.passCode.slice(3)}`, svg, checked: Boolean(visit.identity?.method) });
    } catch (error) {
        res.status(500).json({ message: 'Could not load your visit pass', error: error.message });
    }
};

/** POST /api/collection/visits/:id/reschedule { slotStart } */
exports.rescheduleMine = async (req, res) => {
    try {
        const visit = await ownVisit(req, res);
        if (!visit) return;
        const result = await collection.reschedule({ visit, start: req.body?.slotStart, by: 'customer' });
        if (!result.ok) return res.status(result.status).json({ message: result.message, reason: result.reason });
        res.json({ visit: collection.visitView(result.visit) });
    } catch (error) {
        res.status(500).json({ message: 'Could not move the visit', error: error.message });
    }
};

/** POST /api/collection/visits/:id/cancel — the order stands; its kits wait for a new booking. */
exports.cancelMine = async (req, res) => {
    try {
        const visit = await ownVisit(req, res);
        if (!visit) return;
        const result = await collection.cancel({ visit, by: 'customer', note: 'Cancelled in the app' });
        if (!result.ok) return res.status(result.status).json({ message: result.message, reason: result.reason });
        res.json({ visit: collection.visitView(result.visit) });
    } catch (error) {
        res.status(500).json({ message: 'Could not cancel the visit', error: error.message });
    }
};

// ── Admin ────────────────────────────────────────────────────────────────────

const adminVisitView = (visit) => ({
    ...collection.visitView(visit),
    customer: visit.userId && typeof visit.userId === 'object' && visit.userId.email
        ? { _id: String(visit.userId._id), name: [visit.userId.firstName, visit.userId.lastName].filter(Boolean).join(' '), email: visit.userId.email }
        : null,
    technician: visit.technicianId && typeof visit.technicianId === 'object' && visit.technicianId.name
        ? { _id: String(visit.technicianId._id), name: visit.technicianId.name }
        : null,
    assignee: visit.technicianId && typeof visit.technicianId === 'object' && visit.technicianId.name
        ? { name: visit.technicianId.name, phone: visit.technicianId.phone || null }
        : visit.assignee?.name ? { name: visit.assignee.name, phone: visit.assignee.phone || null } : null,
    identity: visit.identity?.method ? { method: visit.identity.method, at: visit.identity.at } : null,
    tasks: (visit.tasks || []).map((t) => ({
        _id: String(t._id), kind: t.kind, status: t.status, barcode: t.barcode || null, note: t.note || null,
        orderId: String(t.orderId), itemId: String(t.itemId), componentId: String(t.componentId),
    })),
    statusHistory: visit.statusHistory || [],
    createdAt: visit.createdAt,
});

/**
 * GET /api/collection/admin/visits?market=AE&date=2026-10-14
 *
 * One market, one local day — the technicians' timetable. Every slot of the day is returned
 * with its visits, including empty slots, so the grid shows where there is room. Expired holds
 * are left out; holds still running are in, because they occupy a place.
 */
exports.adminDay = async (req, res) => {
    try {
        const market = await Market.resolve(String(req.query.market || 'AE').toUpperCase());
        if (!market) return res.status(400).json({ message: 'Unknown market' });
        const today = M.localDay(new Date(), market.timezone);
        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : today;
        const from = M.localToUtc(date, 0, market.timezone);
        const to = M.localToUtc(date, 24 * 60, market.timezone);

        const visits = await CollectionVisit.find({
            market: market.code,
            'slot.start': { $gte: from, $lt: to },
            status: { $ne: 'expired' },
        }).sort({ 'slot.start': 1 }).populate('userId', 'firstName lastName email').populate('technicianId', 'name phone').lean();
        const technicians = await roster.rosterFor(market.code);

        // The day's slot grid in the market's clock, whatever the booking window says today.
        const c = market.visits;
        const slots = [];
        for (let m = c.openMinute; m + c.slotMinutes <= c.closeMinute; m += c.slotMinutes) {
            const start = M.localToUtc(date, m, market.timezone);
            const iso = start.toISOString();
            const here = visits.filter((v) => new Date(v.slot.start).toISOString() === iso);
            slots.push({
                start: iso,
                label: M.describeSlot(start, new Date(start.getTime() + c.slotMinutes * 60000), market.timezone).split(', ').pop(),
                capacity: roster.capacityAt(market, technicians, start),
                taken: here.filter((v) => CollectionVisit.HOLDING.includes(v.status)).length,
                // Who could take a visit here — the assign picker offers these first.
                onShift: technicians.filter((t) => roster.onShift(t, market, start)).map((t) => String(t._id)),
                visits: here.map(adminVisitView),
            });
        }
        res.json({
            market: { code: market.code, name: market.name, timezone: market.timezone, capacityMode: c.capacityMode },
            technicians: technicians.map((t) => ({ _id: String(t._id), name: t.name, areas: t.areas || [], visitsPerSlot: t.visitsPerSlot || 1 })),
            date,
            today,
            totals: {
                visits: visits.filter((v) => !['cancelled'].includes(v.status)).length,
                completed: visits.filter((v) => v.status === 'completed').length,
                unassigned: visits.filter((v) => v.status === 'booked').length,
                onShift: technicians.filter((t) => (t.shifts || []).length && slots.some((sl) => sl.onShift.includes(String(t._id)))).length,
            },
            slots,
        });
    } catch (error) {
        console.error('❌ Collection timetable failed:', error);
        res.status(500).json({ message: 'Could not load the timetable', error: error.message });
    }
};

const findVisit = async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
        res.status(404).json({ message: 'Visit not found' });
        return null;
    }
    const visit = await CollectionVisit.findById(req.params.id);
    if (!visit) res.status(404).json({ message: 'Visit not found' });
    return visit;
};

const answerAdmin = async (res, visitId, extra = {}) => {
    const fresh = await CollectionVisit.findById(visitId).populate('userId', 'firstName lastName email').populate('technicianId', 'name phone').lean();
    res.json({ visit: adminVisitView(fresh), ...extra });
};

/** GET /api/collection/admin/visits/:id */
exports.adminGet = async (req, res) => {
    try {
        const visit = await findVisit(req, res);
        if (!visit) return;
        const orders = await Order.find({ _id: { $in: visit.orderIds } })
            .select('items.name items._id items.components total currency status claimCode guestEmail').lean();
        const fresh = await CollectionVisit.findById(visit._id).populate('userId', 'firstName lastName email').populate('technicianId', 'name phone').lean();
        res.json({
            visit: adminVisitView(fresh),
            orders: orders.map((o) => ({
                _id: String(o._id), status: o.status, total: o.total, currency: o.currency,
                guestEmail: o.guestEmail || null, items: (o.items || []).map((i) => ({ _id: String(i._id), name: i.name })),
            })),
        });
    } catch (error) {
        res.status(500).json({ message: 'Could not load the visit', error: error.message });
    }
};

/**
 * PATCH /api/collection/admin/visits/:id { technicianId | null, force? }
 *
 * Refused (409, with the reason) when the technician is off shift or already busy in that slot;
 * `force` overrides both, for the administrator who knows better. See `assignTechnician`.
 */
exports.adminAssign = async (req, res) => {
    try {
        const visit = await findVisit(req, res);
        if (!visit) return;
        const technicianId = req.body?.technicianId || null;
        if (technicianId && !mongoose.isValidObjectId(technicianId)) return res.status(400).json({ message: 'Unknown technician' });
        const result = await collection.assignTechnician({ visit, technicianId, by: 'admin', force: req.body?.force === true });
        if (!result.ok) return res.status(result.status).json({ message: result.message, reason: result.reason });
        await answerAdmin(res, visit._id);
    } catch (error) {
        res.status(500).json({ message: 'Could not assign the visit', error: error.message });
    }
};

/**
 * POST /api/collection/admin/assign-day { market, date }
 *
 * Assign every unassigned visit that day by the deterministic rule (on shift, covers the area,
 * free in the slot, least loaded). Answers what it did and, for each visit it could not place,
 * why — so the timetable can show the gap rather than a silent "unassigned".
 */
exports.adminAutoAssign = async (req, res) => {
    try {
        const market = await Market.resolve(String(req.body?.market || 'AE').toUpperCase());
        if (!market) return res.status(400).json({ message: 'Unknown market' });
        const date = String(req.body?.date || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ message: 'Choose a day.' });
        const plan = await collection.autoAssignDay({ market, date, by: 'admin:auto' });
        res.json({ assigned: plan.assignments.length, unassigned: plan.unassigned });
    } catch (error) {
        console.error('❌ Auto-assign failed:', error);
        res.status(500).json({ message: 'Could not assign the day', error: error.message });
    }
};

/** POST /api/collection/admin/visits/:id/complete { tasks: [{ taskId, status, barcode?, note? }] } */
exports.adminComplete = async (req, res) => {
    try {
        const visit = await findVisit(req, res);
        if (!visit) return;
        const result = await collection.completeVisit({
            visit, results: req.body?.tasks, by: `admin:${req.auth.userId}`, identityConfirmed: req.body?.identityConfirmed === true,
        });
        if (!result.ok) return res.status(result.status).json({ message: result.message, reason: result.reason });
        await answerAdmin(res, visit._id, { specimens: result.specimens.map((s) => s.barcode) });
    } catch (error) {
        console.error('❌ Completing a visit failed:', error);
        res.status(500).json({ message: 'Could not record the visit', error: error.message });
    }
};

/** POST /api/collection/admin/visits/:id/missed { note? } */
exports.adminMissed = async (req, res) => {
    try {
        const visit = await findVisit(req, res);
        if (!visit) return;
        const result = await collection.markMissed({ visit, by: 'admin', note: req.body?.note });
        if (!result.ok) return res.status(result.status).json({ message: result.message });
        await answerAdmin(res, visit._id);
    } catch (error) {
        res.status(500).json({ message: 'Could not update the visit', error: error.message });
    }
};

/** POST /api/collection/admin/visits/:id/reschedule { slotStart } — no customer cut-off. */
exports.adminReschedule = async (req, res) => {
    try {
        const visit = await findVisit(req, res);
        if (!visit) return;
        const result = await collection.reschedule({ visit, start: req.body?.slotStart, by: 'admin' });
        if (!result.ok) return res.status(result.status).json({ message: result.message });
        await answerAdmin(res, visit._id);
    } catch (error) {
        res.status(500).json({ message: 'Could not move the visit', error: error.message });
    }
};

/** POST /api/collection/admin/visits/:id/cancel { note? } */
exports.adminCancel = async (req, res) => {
    try {
        const visit = await findVisit(req, res);
        if (!visit) return;
        const result = await collection.cancel({ visit, by: 'admin', note: req.body?.note });
        if (!result.ok) return res.status(result.status).json({ message: result.message });
        await answerAdmin(res, visit._id);
    } catch (error) {
        res.status(500).json({ message: 'Could not cancel the visit', error: error.message });
    }
};

/**
 * POST /api/collection/admin/specimens/receive { barcode }
 *
 * The laboratory has the tube. A scan at the bench moves the kit to "at the lab" and tells the
 * customer. Until the labs send this themselves (docs/LAB-INTEGRATION.md), it is done here.
 */
exports.adminReceive = async (req, res) => {
    try {
        const result = await collection.receiveSpecimen({ barcode: req.body?.barcode, by: `admin:${req.auth.userId}` });
        if (!result.ok) return res.status(result.status).json({ message: result.message, reason: result.reason });
        res.json({ specimen: { barcode: result.specimen.barcode, kind: result.specimen.kind, status: result.specimen.status, lab: result.specimen.lab || null } });
    } catch (error) {
        res.status(500).json({ message: 'Could not record the sample', error: error.message });
    }
};

/**
 * GET /api/collection/admin/manifests/:code — a bag as its manifest describes it, so the bench
 * can scan each tube against the list before receiving it. Barcodes only: nothing about whose
 * blood is in the tube, which the bench has no reason to see.
 */
exports.adminManifest = async (req, res) => {
    try {
        const SampleManifest = require('../models/SampleManifest');
        const Technician = require('../models/Technician');
        const m = await SampleManifest.findOne({ code: String(req.params.code || '').trim().toUpperCase() }).lean();
        if (!m) return res.status(404).json({ message: 'No bag with that code.' });
        const t = await Technician.findById(m.technicianId).select('name').lean();
        res.json({
            manifest: {
                code: m.code, lab: m.lab, market: m.market, technician: t?.name ?? null,
                handedOverAt: m.handedOverAt, receivedAt: m.receivedAt ?? null, barcodes: m.barcodes, missing: m.missing ?? [],
            },
        });
    } catch (error) {
        res.status(500).json({ message: 'Could not load the bag', error: error.message });
    }
};

/**
 * POST /api/collection/admin/manifests/:code/receive { missing?: [barcode] }
 *
 * A technician's bag has reached the bench: every tube on its manifest is received at once,
 * except any the bench names as missing, which stay in transit and visible.
 */
exports.adminReceiveManifest = async (req, res) => {
    try {
        const result = await collection.receiveManifest({ code: req.params.code, missing: req.body?.missing, by: `admin:${req.auth.userId}` });
        if (!result.ok) return res.status(result.status).json({ message: result.message, reason: result.reason });
        res.json({ code: result.manifest.code, lab: result.manifest.lab, received: result.received, missing: result.manifest.missing });
    } catch (error) {
        res.status(500).json({ message: 'Could not receive the bag', error: error.message });
    }
};

/** GET /api/collection/admin/specimens/:barcode — where a tube is, for support. */
exports.adminSpecimen = async (req, res) => {
    try {
        const code = collection.normaliseBarcode(req.params.barcode);
        const specimen = code ? await Specimen.findOne({ barcode: code }).lean() : null;
        if (!specimen) return res.status(404).json({ message: 'No sample with that barcode' });
        res.json({ specimen });
    } catch (error) {
        res.status(500).json({ message: 'Could not look up the sample', error: error.message });
    }
};

// ── Markets (admin) ──────────────────────────────────────────────────────────

/** GET /api/markets — every market, resolved, with whether each setting was ever chosen. */
exports.listMarkets = async (req, res) => {
    try {
        const markets = await Market.resolveAll();
        res.json({ markets: markets.map((m) => ({ ...m, countries: M.countriesFor(m) })) });
    } catch (error) {
        res.status(500).json({ message: 'Could not load markets', error: error.message });
    }
};

/**
 * PUT /api/markets/:code { fulfilment?, visits?, labs? }
 *
 * Validated whole (`cleanMarketPatch`) and recorded in `history`. Changing hours or capacity
 * moves no visit already booked.
 */
exports.updateMarket = async (req, res) => {
    try {
        const code = String(req.params.code || '').toUpperCase();
        const cleaned = M.cleanMarketPatch(code, req.body || {});
        if (!cleaned.ok) return res.status(400).json({ message: cleaned.errors[0], errors: cleaned.errors });

        // Merge over what is stored, not over the defaults, so a partial edit keeps the rest.
        const current = await Market.resolve(code);
        const merged = M.cleanMarketPatch(code, {
            fulfilment: { ...current.fulfilment, ...(req.body.fulfilment || {}) },
            visits: { ...current.visits, ...(req.body.visits || {}) },
            ...(req.body.labs ? { labs: { ...current.labs, ...req.body.labs } } : {}),
        });
        if (!merged.ok) return res.status(400).json({ message: merged.errors[0], errors: merged.errors });

        await Market.findOneAndUpdate(
            { code },
            {
                $set: { ...merged.value, updatedBy: req.auth.userId },
                $push: { history: { $each: [{ at: new Date(), by: req.auth.userId, change: req.body }], $slice: -50 } },
            },
            { upsert: true, new: true, runValidators: true }
        );
        const market = await Market.resolve(code);
        res.json({ market: { ...market, countries: M.countriesFor(market) } });
    } catch (error) {
        console.error('❌ Market update failed:', error);
        res.status(500).json({ message: 'Could not save the market', error: error.message });
    }
};
