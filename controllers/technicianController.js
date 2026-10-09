const mongoose = require('mongoose');
const Technician = require('../models/Technician');
const CollectionVisit = require('../models/CollectionVisit');
const Market = require('../models/Market');
const User = require('../models/userModel');
const M = require('../utils/markets');
const collection = require('../utils/collectionCentre');
const { resolveTechnician } = require('../utils/roster');

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
        res.json({ date, today, timezone: market.timezone, visits: visits.map(fieldView) });
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

const act = (fn) => async (req, res) => {
    try {
        const found = await myVisit(req, res);
        if (!found) return;
        const by = `technician:${found.tech._id}`;
        const result = await fn({ ...found, req, by });
        if (!result.ok) return res.status(result.status).json({ message: result.message, reason: result.reason });
        await answer(res, found.visit._id);
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
exports.arrive = act(({ visit, by }) => collection.arriveVisit({ visit, by }));

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
    return collection.verifyPass({ visit, code: parts.length === 3 ? parts[2] : raw, by });
});

/** POST /api/technician/visits/:id/complete { tasks, identityConfirmed? } */
exports.complete = act(({ visit, req, by }) => collection.completeVisit({
    visit, results: req.body?.tasks, by, identityConfirmed: req.body?.identityConfirmed === true,
}));

/** POST /api/technician/visits/:id/missed { note? } */
exports.missed = act(({ visit, req, by }) => collection.markMissed({ visit, by, note: req.body?.note }));

exports._internal = { cleanTechnician, fieldView };
