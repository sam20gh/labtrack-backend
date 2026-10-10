const mongoose = require('mongoose');
const Technician = require('../models/Technician');
const CollectionVisit = require('../models/CollectionVisit');
const Market = require('../models/Market');
const User = require('../models/userModel');
const M = require('../utils/markets');
const collection = require('../utils/collectionCentre');
const { resolveTechnician } = require('../utils/roster');
const routing = require('../utils/routing');
const TechnicianAction = require('../models/TechnicianAction');
const Specimen = require('../models/Specimen');

/**
 * Technicians: the roster (administrators) and a technician's own working day.
 *
 * **A technician sees only the visits assigned to them.** Anything else answers 404, never
 * 403 — the rule `requireReviewScope` follows, for the same reason: a 403 confirms a visit
 * exists at an id. What a technician is shown is what a door needs and no more: an address, a
 * phone, a first name, what to collect, whether to expect a fasting patient. Never a test
 * result, a condition, an email, or the visit pass code they are there to check.
 */

// ── Validation ───────────────────────────────────────────────────────────────

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : '');

/** Clean a roster edit. Shifts in 15-minute steps in the market's clock; areas from the market's list. */
const cleanTechnician = async (body, existing = null) => {
    const errors = [];
    const out = {};
    const pickText = (key, max, required, message) => {
        if (body[key] === undefined && existing) return;
        const v = text(body[key], max);
        if (required && !v) errors.push(message);
        out[key] = v || undefined;
    };
    pickText('name', 80, true, 'Add the technician’s name.');
    pickText('phone', 30, false);
    if (body.email !== undefined || !existing) {
        const email = text(body.email, 254).toLowerCase();
        if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) errors.push('Add the email their invite goes to.');
        out.email = email;
    }
    const marketCode = body.market !== undefined ? String(body.market).toUpperCase() : existing?.market;
    const market = await Market.resolve(marketCode);
    if (!market) errors.push('Choose a market.');
    else out.market = market.code;

    if (body.areas !== undefined) {
        const areas = Array.isArray(body.areas) ? [...new Set(body.areas.map((a) => String(a).trim()).filter(Boolean))] : null;
        if (!areas) errors.push('Areas must be a list.');
        else if (market && areas.some((a) => !market.visits.serviceAreas.includes(a))) {
            errors.push(`Areas must be from ${market.name}’s service areas.`);
        } else out.areas = areas;
    }
    if (body.visitsPerSlot !== undefined) {
        const n = Number(body.visitsPerSlot);
        if (!Number.isInteger(n) || n < 1 || n > 5) errors.push('Visits per slot must be 1 to 5.');
        else out.visitsPerSlot = n;
    }
    if (body.shifts !== undefined) {
        const shifts = Array.isArray(body.shifts) ? body.shifts : null;
        const clean = (shifts || []).map((s) => ({ day: Number(s?.day), startMinute: Number(s?.startMinute), endMinute: Number(s?.endMinute) }));
        const bad = !shifts || clean.some((s) => !Number.isInteger(s.day) || s.day < 0 || s.day > 6
            || !Number.isInteger(s.startMinute) || !Number.isInteger(s.endMinute)
            || s.startMinute < 0 || s.endMinute > 1440 || s.endMinute <= s.startMinute
            || s.startMinute % 15 || s.endMinute % 15);
        if (bad) errors.push('Each shift needs a day and a start before its end, in 15-minute steps.');
        else out.shifts = clean.slice(0, 21);
    }
    if (body.timeOff !== undefined) {
        const list = Array.isArray(body.timeOff) ? body.timeOff : null;
        const clean = (list || []).map((t) => ({ from: String(t?.from || ''), to: String(t?.to || t?.from || ''), note: text(t?.note, 120) || undefined }));
        if (!list || clean.some((t) => !YMD.test(t.from) || !YMD.test(t.to) || t.to < t.from)) errors.push('Time off needs a from and to date, YYYY-MM-DD.');
        else out.timeOff = clean.slice(0, 60);
    }
    if (body.active !== undefined) out.active = body.active === true;
    if (body.base !== undefined) {
        const b = body.base || {};
        const lat = Number(b.lat);
        const lng = Number(b.lng);
        if (b.lat === null || b.lat === '' || b.lat === undefined) out.base = { label: text(b.label, 80) || undefined };
        else if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) errors.push('The base needs a valid latitude and longitude.');
        else out.base = { label: text(b.label, 80) || undefined, lat, lng };
    }
    return errors.length ? { ok: false, errors } : { ok: true, value: out };
};

const rosterView = (t) => ({
    _id: String(t._id),
    name: t.name,
    email: t.email,
    phone: t.phone || null,
    market: t.market,
    areas: t.areas || [],
    visitsPerSlot: t.visitsPerSlot || 1,
    shifts: t.shifts || [],
    timeOff: t.timeOff || [],
    active: t.active !== false,
    base: t.base && Number.isFinite(t.base.lat) ? { label: t.base.label || null, lat: t.base.lat, lng: t.base.lng } : t.base?.label ? { label: t.base.label, lat: null, lng: null } : null,
    linked: Boolean(t.userId),
});

// ── Admin: the roster ────────────────────────────────────────────────────────

/** GET /api/technicians?market=AE */
exports.list = async (req, res) => {
    try {
        const filter = req.query.market ? { market: String(req.query.market).toUpperCase() } : {};
        const rows = await Technician.find(filter).sort({ active: -1, name: 1 }).lean();
        res.json({ technicians: rows.map(rosterView) });
    } catch (error) {
        res.status(500).json({ message: 'Could not load technicians', error: error.message });
    }
};

/** POST /api/technicians */
exports.create = async (req, res) => {
    try {
        const cleaned = await cleanTechnician(req.body || {});
        if (!cleaned.ok) return res.status(400).json({ message: cleaned.errors[0], errors: cleaned.errors });
        // An account that already exists with this email is linked now rather than at first use.
        const user = await User.findOne({ email: new RegExp(`^${cleaned.value.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).select('_id').lean();
        const tech = await Technician.create({ ...cleaned.value, ...(user ? { userId: user._id } : {}) });
        res.status(201).json({ technician: rosterView(tech) });
    } catch (error) {
        if (error.code === 11000) return res.status(409).json({ message: 'A technician with that email already exists.' });
        res.status(500).json({ message: 'Could not add the technician', error: error.message });
    }
};

/** PUT /api/technicians/:id — partial; a technician moved to another market keeps no visits there. */
exports.update = async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Technician not found' });
        const existing = await Technician.findById(req.params.id);
        if (!existing) return res.status(404).json({ message: 'Technician not found' });
        const cleaned = await cleanTechnician(req.body || {}, existing);
        if (!cleaned.ok) return res.status(400).json({ message: cleaned.errors[0], errors: cleaned.errors });
        Object.assign(existing, Object.fromEntries(Object.entries(cleaned.value).filter(([, v]) => v !== undefined)));
        await existing.save();
        res.json({ technician: rosterView(existing) });
    } catch (error) {
        if (error.code === 11000) return res.status(409).json({ message: 'A technician with that email already exists.' });
        res.status(500).json({ message: 'Could not save the technician', error: error.message });
    }
};

// ── A technician's own day ───────────────────────────────────────────────────

const me = async (req, res) => {
    const tech = await resolveTechnician(req.auth);
    if (!tech || !tech.active) {
        res.status(403).json({ message: 'This account has no active technician profile. Ask an administrator to add you to the roster.' });
        return null;
    }
    return tech;
};

/** What a door needs. See the header for what is deliberately absent. */
const fieldView = (visit) => {
    const base = collection.visitView(visit);
    const firstName = visit.userId && typeof visit.userId === 'object' ? visit.userId.firstName : null;
    return {
        _id: base._id,
        status: base.status,
        label: base.label,
        slot: base.slot,
        timezone: base.timezone,
        address: base.address,
        phone: base.phone,
        name: visit.contactName || firstName || null,
        accessNotes: base.accessNotes,
        requiresFasting: base.requiresFasting,
        identityChecked: Boolean(visit.identity?.method),
        tasks: (visit.tasks || []).map((t) => ({ _id: String(t._id), kind: t.kind, status: t.status, barcode: t.barcode || null })),
    };
};

/** GET /api/technician/me */
exports.getMe = async (req, res) => {
    try {
        const tech = await me(req, res);
        if (!tech) return;
        const market = await Market.resolve(tech.market);
        res.json({
            technician: { _id: String(tech._id), name: tech.name, market: tech.market, areas: tech.areas },
            market: { code: market.code, name: market.name, timezone: market.timezone },
            today: M.localDay(new Date(), market.timezone),
        });
    } catch (error) {
        res.status(500).json({ message: 'Could not load your profile', error: error.message });
    }
};

/** GET /api/technician/visits?date=YYYY-MM-DD — their visits that local day, in slot order. */
exports.myDay = async (req, res) => {
    try {
        const tech = await me(req, res);
        if (!tech) return;
        const market = await Market.resolve(tech.market);
        const today = M.localDay(new Date(), market.timezone);
        const date = YMD.test(String(req.query.date || '')) ? String(req.query.date) : today;
        const visits = await CollectionVisit.find({
            technicianId: tech._id,
            'slot.start': { $gte: M.localToUtc(date, 0, market.timezone), $lt: M.localToUtc(date, 24 * 60, market.timezone) },
            status: { $nin: ['cancelled', 'expired'] },
        }).sort({ 'slot.start': 1 }).populate('userId', 'firstName').lean();
        // The day as a route: how long each leg should take, and which gaps are too tight.
        const legs = routing.legsFor(visits, tech.base);
        res.json({ date, today, timezone: market.timezone, visits: visits.map(fieldView), legs });
    } catch (error) {
        res.status(500).json({ message: 'Could not load your visits', error: error.message });
    }
};

/** One of *their* visits, or 404. */
const myVisit = async (req, res) => {
    const tech = await me(req, res);
    if (!tech) return null;
    if (!mongoose.isValidObjectId(req.params.id)) {
        res.status(404).json({ message: 'Visit not found' });
        return null;
    }
    const visit = await CollectionVisit.findOne({ _id: req.params.id, technicianId: tech._id });
    if (!visit) res.status(404).json({ message: 'Visit not found' });
    return visit ? { tech, visit } : null;
};

const answer = async (res, visitId) => {
    const fresh = await CollectionVisit.findById(visitId).populate('userId', 'firstName').lean();
    res.json({ visit: fieldView(fresh) });
};

/**
 * Answer once per `Idempotency-Key`. The technician app sends one with every action it queues
 * offline; a repeat of a key already answered gets that first answer back and runs nothing. A
 * request with no key behaves as it always did.
 */
const idempotent = async (req, res, techId, run) => {
    const key = String(req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'] || '').trim().slice(0, 120);
    if (!key) return run((status, body) => res.status(status).json(body));
    const seen = await TechnicianAction.findOne({ technicianId: techId, key }).lean();
    if (seen) return res.status(seen.status).json(seen.body);
    return run(async (status, body) => {
        // Only settled outcomes are remembered: a 5xx may succeed on the next try.
        if (status < 500) {
            await TechnicianAction.create({ technicianId: techId, key, route: req.originalUrl || req.url, status, body })
                .catch((e) => { if (e.code !== 11000) throw e; });
        }
        return res.status(status).json(body);
    });
};

const fixFrom = (body) => (body?.location && typeof body.location === 'object' ? body.location : null);

const act = (fn) => async (req, res) => {
    try {
        const found = await myVisit(req, res);
        if (!found) return;
        const by = `technician:${found.tech._id}`;
        await idempotent(req, res, found.tech._id, async (send) => {
            const result = await fn({ ...found, req, by });
            if (!result.ok) return send(result.status, { message: result.message, reason: result.reason });
            const fresh = await CollectionVisit.findById(found.visit._id).populate('userId', 'firstName').lean();
            return send(200, { visit: fieldView(fresh) });
        });
    } catch (error) {
        console.error('❌ Technician action failed:', error);
        res.status(500).json({ message: 'Could not update the visit', error: error.message });
    }
};

/** GET /api/technician/visits/:id */
exports.getVisit = async (req, res) => {
    try {
        const found = await myVisit(req, res);
        if (!found) return;
        await answer(res, found.visit._id);
    } catch (error) {
        res.status(500).json({ message: 'Could not load the visit', error: error.message });
    }
};

exports.start = act(({ visit, by }) => collection.startVisit({ visit, by }));
exports.arrive = act(({ visit, req, by }) => collection.arriveVisit({ visit, by, fix: fixFrom(req.body) }));

/**
 * POST /api/technician/visits/:id/location { lat, lng, accuracy?, at? }
 * While on the way only. Turned into an arrival estimate for the customer, never shown as a
 * position. Not idempotent-keyed: a newer fix simply replaces an older one.
 */
exports.location = async (req, res) => {
    try {
        const found = await myVisit(req, res);
        if (!found) return;
        const result = await collection.updateLocation({ visit: found.visit, fix: req.body || {} });
        if (!result.ok) return res.status(result.status).json({ message: result.message, reason: result.reason });
        res.json({ etaMinutes: found.visit.tracking?.etaMinutes ?? null });
    } catch (error) {
        res.status(500).json({ message: 'Could not update your location', error: error.message });
    }
};

/**
 * POST /api/technician/visits/:id/verify { code }
 *
 * `code` is what the pass QR decodes to (`PQV1:<visitId>:<code>`) or the six characters typed.
 * A QR for a *different* visit is refused as a mismatch — the technician is at the wrong door.
 */
exports.verify = act(({ visit, req, by }) => {
    const raw = String(req.body?.code || '').trim();
    const parts = raw.split(':');
    if (parts.length === 3 && parts[0] === 'PQV1' && parts[1] !== String(visit._id)) {
        return { ok: false, status: 400, message: 'That pass is for a different visit. Check you are at the right address.', reason: 'mismatch' };
    }
    return collection.verifyPass({ visit, code: parts.length === 3 ? parts[2] : raw, by, fix: fixFrom(req.body) });
});

/** POST /api/technician/visits/:id/complete { tasks, identityConfirmed? } */
exports.complete = act(({ visit, req, by }) => collection.completeVisit({
    visit, results: req.body?.tasks, by, identityConfirmed: req.body?.identityConfirmed === true,
}));

/** POST /api/technician/visits/:id/missed { note? } */
exports.missed = act(({ visit, req, by }) => collection.markMissed({ visit, by, note: req.body?.note }));

/**
 * GET /api/technician/specimens — tubes this technician has collected and not yet handed over,
 * grouped by the laboratory each is going to. What goes in which bag.
 */
exports.mySpecimens = async (req, res) => {
    try {
        const tech = await me(req, res);
        if (!tech) return;
        const visitIds = (await CollectionVisit.find({ technicianId: tech._id }).select('_id').lean()).map((v) => v._id);
        const tubes = await Specimen.find({ visitId: { $in: visitIds }, status: 'collected' })
            .select('barcode kind lab createdAt').sort({ createdAt: 1 }).lean();
        const byLab = {};
        for (const t of tubes) (byLab[t.lab || 'UNASSIGNED'] ||= []).push({ barcode: t.barcode, kind: t.kind, collectedAt: t.createdAt });
        res.json({ labs: Object.entries(byLab).map(([lab, list]) => ({ lab, tubes: list })) });
    } catch (error) {
        res.status(500).json({ message: 'Could not load your samples', error: error.message });
    }
};

/** POST /api/technician/handover { lab, barcodes[] } — a sealed bag on its way to a laboratory. */
exports.handOver = async (req, res) => {
    try {
        const tech = await me(req, res);
        if (!tech) return;
        await idempotent(req, res, tech._id, async (send) => {
            const result = await collection.handOver({ technician: tech, lab: req.body?.lab, barcodes: req.body?.barcodes, by: `technician:${tech._id}` });
            if (!result.ok) return send(result.status, { message: result.message, reason: result.reason });
            const m = result.manifest;
            return send(201, { manifest: { code: m.code, lab: m.lab, count: m.barcodes.length, barcodes: m.barcodes, handedOverAt: m.handedOverAt } });
        });
    } catch (error) {
        console.error('❌ Hand-over failed:', error);
        res.status(500).json({ message: 'Could not record the hand-over', error: error.message });
    }
};

exports._internal = { cleanTechnician, fieldView };

// ── Reports ──────────────────────────────────────────────────────────────────

/**
 * A technician's week or month (`utils/fieldReport.js`). Loads this period and the one before
 * it in two queries, so the comparison costs nothing extra. Reads no customer details: the
 * report needs slots, statuses, tasks, pins and the distance total, and selects only those.
 */
const reportFor = async (tech, query) => {
    const fieldReport = require('../utils/fieldReport');
    const SampleManifest = require('../models/SampleManifest');
    const market = await Market.resolve(tech.market);
    const tz = market.timezone;
    const today = M.localDay(new Date(), tz);
    const kind = query.period === 'month' ? 'month' : 'week';
    const date = YMD.test(String(query.date || '')) ? String(query.date) : today;

    const period = fieldReport.periodFor(kind, date);
    const prev = fieldReport.previousOf(period);
    const from = M.localToUtc(prev.from, 0, tz);
    const to = M.localToUtc(fieldReport.addDays(period.to, 1), 0, tz);

    const [visits, manifests] = await Promise.all([
        CollectionVisit.find({
            technicianId: tech._id,
            'slot.start': { $gte: from, $lt: to },
            status: { $nin: ['cancelled', 'expired', 'held'] },
        }).select('slot status tasks.kind tasks.status identity.method address.lat address.lng address.area driven statusHistory.status statusHistory.at').lean(),
        SampleManifest.find({ technicianId: tech._id, handedOverAt: { $gte: from, $lt: to } })
            .select('handedOverAt receivedAt barcodes missing').lean(),
    ]);

    return fieldReport.buildReport({
        kind, date, today, timezone: tz, market: market.code,
        visits, manifests, base: tech.base, localDay: M.localDay,
    });
};

/** GET /api/technician/report?period=week|month&date=YYYY-MM-DD — their own. */
exports.myReport = async (req, res) => {
    try {
        const tech = await me(req, res);
        if (!tech) return;
        res.json(await reportFor(tech, req.query));
    } catch (error) {
        res.status(500).json({ message: 'Could not build your report', error: error.message });
    }
};

/** GET /api/technicians/:id/report — the same report, for an administrator. */
exports.report = async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Technician not found' });
        const tech = await Technician.findById(req.params.id).lean();
        if (!tech) return res.status(404).json({ message: 'Technician not found' });
        res.json({ technician: { _id: String(tech._id), name: tech.name }, ...(await reportFor(tech, req.query)) });
    } catch (error) {
        res.status(500).json({ message: 'Could not build the report', error: error.message });
    }
};

// ── Operations board ─────────────────────────────────────────────────────────

const ORDER_WINDOW_DAYS = 90;
const VISIT_OPEN = ['booked', 'assigned', 'en_route', 'arrived'];

/**
 * Where a market's home-collection orders are, stage by stage. Open orders only (90 days),
 * because the question is "what is stuck", and a resulted order from March is not.
 */
const pipelineFor = async (market, now) => {
    const Order = require('../models/Order');
    const since = new Date(now.getTime() - ORDER_WINDOW_DAYS * 86400000);
    const orders = await Order.find({
        'fulfilment.method': 'home_collection',
        'fulfilment.market': market.code,
        status: { $nin: ['cancelled', 'refunded'] },
        createdAt: { $gte: since },
    }).select('status fulfilment.visitId').lean();
    const visitIds = orders.map((o) => o.fulfilment?.visitId).filter(Boolean);
    const visitStatus = new Map((await CollectionVisit.find({ _id: { $in: visitIds } }).select('status').lean())
        .map((v) => [String(v._id), v.status]));
    const p = { awaitingPayment: 0, toBook: 0, booked: 0, collected: 0, atLab: 0, resulted: 0 };
    for (const o of orders) {
        const vs = o.fulfilment?.visitId ? visitStatus.get(String(o.fulfilment.visitId)) : null;
        // `pending_payment` is the order's own word for unpaid; `payment.status` stays 'unpaid' on
        // orders placed before a payment provider existed, which are not waiting for anything.
        if (o.status === 'pending_payment') p.awaitingPayment += 1;
        else if (o.status === 'resulted') p.resulted += 1;
        else if (['sample_received', 'processing'].includes(o.status)) p.atLab += 1;
        else if (o.status === 'kit_sent' || vs === 'completed') p.collected += 1;
        else if (VISIT_OPEN.includes(vs)) p.booked += 1;
        else p.toBook += 1;
    }
    return { ...p, windowDays: ORDER_WINDOW_DAYS };
};

/** GET /api/technicians/ops?market=AE — the live board (`utils/fieldOps.js`). */
exports.ops = async (req, res) => {
    try {
        const fieldOps = require('../utils/fieldOps');
        const fieldReport = require('../utils/fieldReport');
        const SampleManifest = require('../models/SampleManifest');
        const market = await Market.resolve(String(req.query.market || 'AE').toUpperCase());
        if (!market) return res.status(404).json({ message: 'No such market' });
        const tz = market.timezone;
        const now = new Date();
        const today = M.localDay(now, tz);
        const dayStart = M.localToUtc(today, 0, tz);
        const dayEnd = M.localToUtc(today, 24 * 60, tz);
        const week = fieldReport.periodFor('week', today);
        const weekFrom = M.localToUtc(fieldReport.previousOf(week).from, 0, tz);
        const weekTo = M.localToUtc(fieldReport.addDays(week.to, 1), 0, tz);
        const labs = Object.values(market.labs || {}).filter(Boolean);
        const monthAgo = new Date(now.getTime() - 30 * 86400000);

        const technicians = await Technician.find({ market: market.code, active: true }).lean();
        const techIds = technicians.map((t) => t._id);
        const [visits, weekVisits, manifests, pipeline, specimenCounts, openBags, shortBags] = await Promise.all([
            CollectionVisit.find({ market: market.code, 'slot.start': { $gte: dayStart, $lt: dayEnd }, status: { $nin: ['held', 'expired', 'cancelled'] } })
                .select('slot status address technicianId tasks.kind tasks.status tracking statusHistory.status statusHistory.at').lean(),
            CollectionVisit.find({ technicianId: { $in: techIds }, 'slot.start': { $gte: weekFrom, $lt: weekTo }, status: { $nin: ['cancelled', 'expired', 'held'] } })
                .select('technicianId slot status tasks.kind tasks.status identity.method address.lat address.lng address.area driven statusHistory.status statusHistory.at').lean(),
            SampleManifest.find({ technicianId: { $in: techIds }, handedOverAt: { $gte: weekFrom, $lt: weekTo } }).select('technicianId handedOverAt receivedAt barcodes missing').lean(),
            pipelineFor(market, now),
            labs.length ? Specimen.aggregate([{ $match: { lab: { $in: labs }, status: { $in: ['collected', 'in_transit', 'received', 'processing'] } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]) : [],
            SampleManifest.countDocuments({ market: market.code, receivedAt: null }),
            SampleManifest.countDocuments({ market: market.code, receivedAt: { $gte: monthAgo }, 'missing.0': { $exists: true } }),
        ]);

        // Each technician's week, from the same function their own app reads.
        const reports = {};
        for (const t of technicians) {
            const id = String(t._id);
            reports[id] = fieldReport.buildReport({
                kind: 'week', date: today, today, timezone: tz, market: market.code,
                visits: weekVisits.filter((v) => String(v.technicianId) === id),
                manifests: manifests.filter((m) => String(m.technicianId) === id),
                base: t.base, localDay: M.localDay,
            });
        }
        const s = Object.fromEntries(specimenCounts.map((x) => [x._id, x.n]));

        res.json(fieldOps.board({
            market, technicians, visits, week: reports, now, today,
            pipeline,
            specimens: { withTechnicians: s.collected || 0, inTransit: s.in_transit || 0, atLab: (s.received || 0) + (s.processing || 0) },
            bags: { awaiting: openBags, shortLast30Days: shortBags },
        }));
    } catch (error) {
        res.status(500).json({ message: 'Could not load the operations board', error: error.message });
    }
};
