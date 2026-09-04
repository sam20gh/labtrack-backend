const PlanItem = require('../models/PlanItem');
const { advanceRecurringItem } = require('../utils/planGeneratorV2');

/** GET /api/plan-items — the caller's timeline, optionally filtered by status. */
exports.getPlanItems = async (req, res) => {
    try {
        const query = { userId: req.auth.userId };
        if (req.query.status) query.status = { $in: String(req.query.status).split(',') };
        if (req.query.type) query.type = { $in: String(req.query.type).split(',') };

        const items = await PlanItem.find(query).sort({ dueDate: 1 }).lean();

        // Grouped the way the timeline renders: overdue first, then by year
        const grouped = items.reduce((acc, item) => {
            const key = ['urgent', 'due'].includes(item.status)
                ? 'urgent'
                : String(new Date(item.dueDate).getFullYear());
            (acc[key] = acc[key] || []).push(item);
            return acc;
        }, {});

        res.json({ items, grouped });
    } catch (error) {
        console.error('❌ Error fetching plan items:', error);
        res.status(500).json({ message: 'Error fetching plan items', error: error.message });
    }
};

/** POST /api/plan-items — add an item manually. */
exports.createPlanItem = async (req, res) => {
    try {
        const item = await PlanItem.create({
            ...req.body,
            userId: req.auth.userId,
            source: req.body.source || 'user',
            status: PlanItem.deriveStatus(req.body.dueDate),
        });
        res.status(201).json({ message: 'Plan item created', item });
    } catch (error) {
        res.status(400).json({ message: 'Error creating plan item', error: error.message });
    }
};

/**
 * PATCH /api/plan-items/:id/status — move an item through its lifecycle.
 * Only the transitions a user can legitimately drive are accepted; `urgent`/`due` are
 * derived from the due date by the daily sweep and cannot be set by hand.
 */
const USER_SETTABLE = ['ordered', 'booked', 'completed', 'dismissed'];

exports.updateStatus = async (req, res) => {
    try {
        const { status, orderId, appointmentId, resultingTestResultId } = req.body;

        if (!USER_SETTABLE.includes(status)) {
            return res.status(400).json({
                message: `status must be one of: ${USER_SETTABLE.join(', ')}`,
            });
        }

        const updates = { status };
        if (orderId) updates.orderId = orderId;
        if (appointmentId) updates.appointmentId = appointmentId;
        if (resultingTestResultId) updates.resultingTestResultId = resultingTestResultId;
        if (status === 'completed') updates.completedAt = new Date();

        const item = await PlanItem.findOneAndUpdate(
            { _id: req.params.id, userId: req.auth.userId },
            { $set: updates },
            { new: true, runValidators: true }
        );
        if (!item) return res.status(404).json({ message: 'Plan item not found' });

        // Completing a recurring screening schedules the next one, so a short horizon
        // never leaves the plan empty
        let next = null;
        if (status === 'completed') {
            next = await advanceRecurringItem(item);
        }

        res.json({ message: 'Plan item updated', item, nextOccurrence: next });
    } catch (error) {
        res.status(400).json({ message: 'Error updating plan item', error: error.message });
    }
};

/** DELETE /api/plan-items/:id */
exports.deletePlanItem = async (req, res) => {
    try {
        const deleted = await PlanItem.findOneAndDelete({ _id: req.params.id, userId: req.auth.userId });
        if (!deleted) return res.status(404).json({ message: 'Plan item not found' });
        res.json({ message: 'Plan item deleted' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting plan item', error: error.message });
    }
};

/* ------------------------------------------------------------------------- *
 * Administrative oversight (admin only)
 *
 * The plan is the product's output: everything the interpretation engine and every
 * clinician has ordered, for everybody. Nothing could read it across users until now,
 * which meant the two ways it fails were both invisible.
 *
 * These handlers are **read-only, and deliberately so**. A plan item is a clinical
 * instruction; the people who may change one are the clinician who ordered it
 * (`POST /reviews/:id/plan-items`) and the patient acting on it
 * (`PATCH /plan-items/:id/status`). An administrator editing it would be an unattributed
 * clinical change on an append-only record — the same line the portal takes with
 * `Interpretation`.
 * ------------------------------------------------------------------------- */

const mongoose = require('mongoose');
const { recordAccess } = require('../utils/accessLog');

/**
 * Items nobody has acted on yet.
 *
 * `ordered`, `booked`, `completed` and `dismissed` are all decisions somebody made; only
 * these three are still waiting. Every "is this plan working" question is about them.
 */
const OPEN_STATUSES = ['upcoming', 'due', 'urgent'];

/**
 * Types that have to resolve to something purchasable or bookable.
 *
 * `lifestyle` is guidance and `assessment` is answered in the app — neither has a product
 * or a professional behind it, so counting them as unactionable would be reporting a gap
 * that does not exist.
 */
const ORDERABLE_TYPES = ['test', 'scan'];

/**
 * An item the person cannot act on, and why.
 *
 * `planGeneratorV2.matchProduct` links a recommended screening to a `Product` by substring
 * in both directions, and `matchProfessionals` needs an exact enum match on speciality.
 * When either misses, the item is still created — correctly, because the recommendation is
 * real — but there is nothing to tap. `buildPlanItems` returns that as `unmatched`, and the
 * only consumer is one field of the interpretation response that no client renders. So a
 * catalogue gap has been reported exactly once, to nobody, at generation time.
 *
 * Derived here from the stored row instead, which means it stays true afterwards: a product
 * renamed away from the wording the engine uses breaks items that matched when they were
 * written, and nothing regenerates them.
 */
const blockedReason = (item) => {
    if (ORDERABLE_TYPES.includes(item.type) && !item.productId) {
        return 'No catalogue product matches this test';
    }
    if (item.type === 'consultation' && !item.professionalId) {
        return item.speciality
            ? `No professional listed under ${item.speciality}`
            : 'No professional linked';
    }
    return null;
};

/**
 * GET /api/plan-items/admin/all — every plan item, for the staff portal (admin only).
 *
 * Separate from `getPlanItems` rather than a `?scope=all` flag on it, for the reason
 * `listAllOrders` is separate: this one crosses the user boundary, and a flag that widens a
 * self-scoped endpoint is one refactor away from being reachable without the role check.
 *
 * Sorted by due date ascending, so the most overdue row is first. The fulfilment queue
 * sorts newest-first because an order is work that arrives; a plan item is work that falls
 * due, and the oldest one is the one that has been waiting longest.
 *
 * Query: ?status= &type= &source= &blocked=true &search= &page= &limit=
 */
exports.listAllPlanItems = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));

        const filter = {};

        // Enum-validated rather than passed through: an unknown value must be a 400, not a
        // filter that silently matches nothing and reads as "no items exist".
        const enumFilter = (field, value) => {
            const allowed = PlanItem.schema.path(field).enumValues;
            if (!allowed.includes(value)) {
                return `Unknown ${field} "${value}". Expected one of: ${allowed.join(', ')}`;
            }
            filter[field] = value;
            return null;
        };

        for (const field of ['status', 'type', 'source', 'urgency']) {
            const value = (req.query[field] || '').trim();
            if (!value || value === 'all') continue;
            const problem = enumFilter(field, value);
            if (problem) return res.status(400).json({ message: problem });
        }

        // `open` is not a status — it is the three the daily sweep still owns. Offered as a
        // filter because "what is outstanding" is the question this screen exists for and
        // it is otherwise three separate chips nobody would think to combine.
        if (req.query.open === 'true') filter.status = { $in: OPEN_STATUSES };

        if (req.query.blocked === 'true') {
            filter.status = filter.status || { $in: OPEN_STATUSES };
            filter.$or = [
                { type: { $in: ORDERABLE_TYPES }, productId: null },
                { type: 'consultation', professionalId: null },
            ];
        }

        /**
         * One box, three things an administrator might paste into it: a patient's email, a
         * user id from another screen, or the wording of a recommendation.
         */
        const search = (req.query.search || '').trim();
        if (search) {
            if (mongoose.isValidObjectId(search)) {
                filter.$and = [{ $or: [{ userId: search }, { _id: search }] }];
            } else {
                const User = require('../models/userModel');
                const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const rx = new RegExp(safe, 'i');
                const matches = await User.find({
                    $or: [{ email: rx }, { firstName: rx }, { lastName: rx }],
                })
                    .select('_id')
                    .limit(50)
                    .lean();

                // `$and` rather than a second `$or`, which the blocked filter may already
                // hold — two `$or` keys in one object and the later silently wins.
                filter.$and = [{
                    $or: [
                        { userId: { $in: matches.map((m) => m._id) } },
                        { title: rx },
                        { condition: rx },
                        { speciality: rx },
                    ],
                }];
            }
        }

        const [items, total] = await Promise.all([
            PlanItem.find(filter)
                .sort({ dueDate: 1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .populate('userId', 'firstName lastName email')
                .lean(),
            PlanItem.countDocuments(filter),
        ]);

        res.json({
            items: items.map((item) => ({
                _id: item._id,
                type: item.type,
                title: item.title,
                condition: item.condition || null,
                frequency: item.frequency || null,
                dueDate: item.dueDate,
                status: item.status,
                urgency: item.urgency,
                source: item.source,
                productName: item.productName || null,
                professionalName: item.professionalName || null,
                speciality: item.speciality || null,
                orderedByProfessionalId: item.orderedByProfessionalId || null,
                // Whether the loop closed, not the ids it closed through — this screen has
                // no order or appointment view to link into.
                fulfilled: Boolean(item.orderId || item.appointmentId),
                completedAt: item.completedAt || null,
                createdAt: item.createdAt,
                blockedReason: blockedReason(item),
                patient: item.userId
                    ? {
                        _id: item.userId._id,
                        name: [item.userId.firstName, item.userId.lastName].filter(Boolean).join(' '),
                        email: item.userId.email,
                    }
                    // A deleted account can leave items behind — the row must still render,
                    // and an orphan is itself worth seeing.
                    : null,
            })),
            page,
            limit,
            total,
            pages: Math.max(1, Math.ceil(total / limit)),
            hasMore: page * limit < total,
        });

        // One entry with a count, after the response — a bulk browse stays distinguishable
        // from opening a single patient, and the audit write never delays the read.
        await recordAccess({
            actor: req.auth,
            resource: 'plan',
            count: items.length,
        });
    } catch (error) {
        console.error('❌ listAllPlanItems failed:', error);
        res.status(500).json({ message: 'Error fetching plan items', error: error.message });
    }
};

/**
 * GET /api/plan-items/admin/stats — the shape of the plan across everybody (admin only).
 *
 * Aggregated, and naming no patient: like `GET /reviews/metrics`, it reads no patient
 * content and therefore writes no access-log entry. Adding a name to this response would
 * change both facts.
 */
exports.getPlanItemStats = async (req, res) => {
    try {
        const countsBy = async (field) => {
            const rows = await PlanItem.aggregate([
                { $group: { _id: `$${field}`, count: { $sum: 1 } } },
            ]);
            // Every enum value, including the zeroes: a board that hides `dismissed`
            // because nobody has dismissed anything is not a complete picture.
            const counts = {};
            for (const value of PlanItem.schema.path(field).enumValues) counts[value] = 0;
            for (const row of rows) if (row._id in counts) counts[row._id] = row.count;
            return counts;
        };

        /** Recommendations with nothing behind them, grouped by what is missing. */
        const gapsFor = async (match, label) => {
            const rows = await PlanItem.aggregate([
                { $match: { status: { $in: OPEN_STATUSES }, ...match } },
                { $group: { _id: `$${label}`, count: { $sum: 1 }, patients: { $addToSet: '$userId' } } },
                { $project: { _id: 0, label: '$_id', count: 1, patients: { $size: '$patients' } } },
                { $sort: { patients: -1, count: -1 } },
                { $limit: 25 },
            ]);
            return rows.filter((row) => row.label);
        };

        const [status, type, source, total, patients, dueRows, productGaps, specialityGaps] =
            await Promise.all([
                countsBy('status'),
                countsBy('type'),
                countsBy('source'),
                PlanItem.countDocuments({}),
                PlanItem.distinct('userId', { status: { $in: OPEN_STATUSES } }),
                /**
                 * Completion measured only over items that have actually come due, and
                 * never over `lifestyle`, which is written with `dueDate: today` and no
                 * reminder because it is guidance rather than an appointment. Counting it
                 * would put a permanently unclearable denominator under every figure.
                 *
                 * `dismissed` leaves the denominator too: declining a screening is a
                 * decision, not a failure to act on one.
                 */
                PlanItem.aggregate([
                    {
                        $match: {
                            type: { $ne: 'lifestyle' },
                            status: { $ne: 'dismissed' },
                            dueDate: { $lte: new Date() },
                        },
                    },
                    {
                        $group: {
                            _id: null,
                            due: { $sum: 1 },
                            completed: {
                                $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] },
                            },
                        },
                    },
                ]),
                gapsFor({ type: { $in: ORDERABLE_TYPES }, productId: null }, 'title'),
                gapsFor({ type: 'consultation', professionalId: null }, 'speciality'),
            ]);

        const dueTotals = dueRows[0] || { due: 0, completed: 0 };

        res.json({
            total,
            counts: { status, type, source },
            /** People with something outstanding — not people with a plan. */
            patientsWithOpenItems: patients.length,
            overdue: status.urgent,
            dueToday: status.due,
            /**
             * Null, never zero. Nothing has come due yet means there is nothing to measure,
             * not that nobody is acting on their plan — the distinction
             * `alignment: 'unassessed'` and `medicationSchedule.adherence` already make.
             */
            completion: dueTotals.due
                ? {
                    due: dueTotals.due,
                    completed: dueTotals.completed,
                    rate: Math.round((dueTotals.completed / dueTotals.due) * 100),
                }
                : { due: 0, completed: 0, rate: null },
            /**
             * The catalogue gaps, which is the only place in the product they are visible.
             * `count` is items, `patients` is people — one person with a ten-year screening
             * schedule produces ten items, and a gap affecting ten people is the more
             * urgent of the two.
             */
            gaps: { products: productGaps, specialities: specialityGaps },
        });
    } catch (error) {
        console.error('❌ getPlanItemStats failed:', error);
        res.status(500).json({ message: 'Error computing plan stats', error: error.message });
    }
};
