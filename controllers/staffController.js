/**
 * Staff administration — who may sign in to the portal, and as what.
 *
 * A role here is the difference between an account that can read its own records and one
 * that can read everybody's. Every handler is admin-gated at the router, and every change
 * is logged with who made it, because "who granted this person access" is the first
 * question an information-governance review asks.
 */
const mongoose = require('mongoose');
const admin = require('../config/supabaseAdmin');
const AccessLog = require('../models/AccessLog');
const User = require('../models/userModel');
const { recordAccess } = require('../utils/accessLog');
const { sendCsv } = require('../utils/csv');

const ASSIGNABLE_ROLES = ['user', 'professional', 'admin'];

/** GET /api/staff — everyone holding a portal role. */
exports.listStaff = async (req, res, next) => {
    try {
        const users = await admin.listUsers();
        const staff = users
            .map(admin.publicUser)
            .filter((u) => u.role === 'admin' || u.role === 'professional')
            .sort((a, b) => (a.email || '').localeCompare(b.email || ''));

        res.json({ staff, count: staff.length });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/staff/invite — invite a new staff member.
 * Body: { email, role, redirectTo? }
 */
exports.inviteStaff = async (req, res, next) => {
    try {
        const email = String(req.body.email || '').trim().toLowerCase();
        const role = String(req.body.role || '').trim();

        if (!email || !email.includes('@')) {
            return res.status(400).json({ message: 'A valid email address is required' });
        }
        if (!ASSIGNABLE_ROLES.includes(role) || role === 'user') {
            return res.status(400).json({
                message: 'Role must be "professional" or "admin"',
            });
        }

        /**
         * An account that already exists — but "exists" covers two different situations.
         *
         * **Never signed in.** They were invited and the link died: single-use and consumed
         * by a mail scanner, superseded by a later invite, or simply expired. Refusing here
         * left them permanently stuck — the account exists so an invite is refused, and they
         * cannot sign in to fix it. There was no way out of that state from inside the
         * product. Supabase reissues on a second invite, so this resends.
         *
         * **Has signed in.** A fresh invite link to somebody with a working account is a
         * confusing way to say "grant this person a role", and it is the role screen they
         * want. Still a 409.
         */
        const existing = await admin.findByEmail(email);
        const hasSignedIn = Boolean(
            existing && (existing.confirmed_at || existing.email_confirmed_at || existing.last_sign_in_at)
        );

        if (existing && hasSignedIn) {
            return res.status(409).json({
                message:
                    `${email} already has an account. Change their role instead of inviting them.`,
                supabaseId: existing.id,
                role: existing.app_metadata?.role || 'user',
            });
        }

        /**
         * Where the invitee lands.
         *
         * The portal sends its own origin, which is what makes this work on localhost, on a
         * Vercel preview and in production without anybody setting a variable per
         * environment. `PORTAL_URL` is the fallback for a caller that sends nothing.
         *
         * Whatever it resolves to **must be on the Supabase project's URL allow list**. An
         * unlisted redirect is not rejected: Supabase substitutes the project's Site URL,
         * which belongs to the patient app, so the invitee lands in the wrong product holding
         * a valid session and nothing reports a problem.
         *
         * Only an admin reaches this route, and the allow list bounds the value regardless,
         * so a caller-supplied origin grants nothing they do not already have.
         */
        const base = req.body.redirectTo || process.env.PORTAL_URL;
        const redirectTo = base ? `${String(base).replace(/\/$/, '')}/auth/callback` : undefined;

        if (!redirectTo) {
            console.warn(
                `⚠️  Inviting ${email} with no redirect: Supabase will substitute the project's ` +
                'Site URL, which is the patient app. Set PORTAL_URL.'
            );
        }

        const user = await admin.invite(email, { role, redirectTo });

        const resent = Boolean(existing);
        console.log(
            `👤 Staff ${resent ? 're-invited' : 'invited'}: ${email} as ${role} ` +
            `by ${req.auth?.email || req.auth?.userId}`
        );

        res.status(201).json({
            staff: admin.publicUser(user),
            resent,
            /**
             * Said plainly, because it is the thing that makes a resend fail if ignored:
             * issuing a new link cancels the previous one, so an earlier email in the
             * inbox is now dead.
             */
            note: resent
                ? 'A new invitation was sent. Any earlier link for this address no longer works.'
                : undefined,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * PATCH /api/staff/:supabaseId/role — change or revoke a role.
 * Body: { role }  — 'user' revokes portal access without deleting the account.
 */
exports.setStaffRole = async (req, res, next) => {
    try {
        const { supabaseId } = req.params;
        const role = String(req.body.role || '').trim();

        if (!ASSIGNABLE_ROLES.includes(role)) {
            return res.status(400).json({
                message: `Role must be one of: ${ASSIGNABLE_ROLES.join(', ')}`,
            });
        }

        /**
         * An admin may not change their own role.
         *
         * Demoting yourself is irreversible from inside the product: the next request is
         * refused, and the only way back is the database or a script. Blocking it costs an
         * admin nothing — another admin can still do it — and removes the one mistake on
         * this screen that cannot be undone through the UI.
         */
        if (req.auth?.supabaseId && String(req.auth.supabaseId) === String(supabaseId)) {
            return res.status(409).json({
                message:
                    'You cannot change your own role. Ask another administrator, so nobody ' +
                    'can lock themselves out of the portal.',
            });
        }

        const before = await admin.getUser(supabaseId);
        const previous = before?.app_metadata?.role || 'user';

        const user = await admin.setRole(supabaseId, role);

        console.log(
            `🔑 Role change: ${before?.email || supabaseId} ${previous} → ${role} ` +
            `by ${req.auth?.email || req.auth?.userId}`
        );

        res.json({
            staff: admin.publicUser(user),
            previousRole: previous,
            /**
             * The claim lives in the access token, so it does not change until that token is
             * reissued. Saying so here is what stops the next twenty minutes being spent
             * wondering why the change "did not work".
             */
            note: 'Takes effect when they next sign in — the role is carried in their access token.',
        });
    } catch (error) {
        next(error);
    }
};

/** GET /api/staff/status — whether staff administration is available. */
exports.getStaffStatus = async (req, res) => {
    res.json({
        configured: admin.isConfigured(),
        // Named so an operator knows exactly what to set, without reading the source.
        requires: 'SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) and SUPABASE_URL',
    });
};

/* ------------------------------------------------------------------------------------
 * The access log
 *
 * `models/AccessLog.js` has recorded every staff read of patient data since W2. Until now
 * nothing could read it back, which makes it a collection rather than a control: an audit
 * trail nobody can query answers none of the questions it exists for.
 *
 * Two questions, and the filters are shaped around them: **"everything this clinician
 * looked at"** and **"everyone who looked at this patient"** — the two indexes the model
 * declares.
 * ---------------------------------------------------------------------------------- */

/** Query → Mongo filter, shared by the viewer and the export so they can never diverge. */
const accessLogFilter = (query = {}) => {
    const filter = {};

    if (query.actorId && mongoose.Types.ObjectId.isValid(query.actorId)) filter.actorId = query.actorId;
    if (query.patientId && mongoose.Types.ObjectId.isValid(query.patientId)) filter.patientId = query.patientId;
    if (query.resource) filter.resource = query.resource;
    if (query.actorRole) filter.actorRole = query.actorRole;

    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;
    if ((from && !Number.isNaN(from.getTime())) || (to && !Number.isNaN(to.getTime()))) {
        filter.at = {};
        if (from && !Number.isNaN(from.getTime())) filter.at.$gte = from;
        // Inclusive of the whole `to` day: an operator typing a date means that day, and a
        // half-open range silently drops everything after midnight on it.
        if (to && !Number.isNaN(to.getTime())) filter.at.$lte = new Date(to.getTime() + 86_399_999);
    }

    return filter;
};

/**
 * Names for the patient ids in a page of entries.
 *
 * The log stores ids, deliberately — it holds identifiers, never content — but a viewer
 * showing only ids is one nobody can use, so names are joined at read time from the live
 * `User` records. That way a corrected spelling is corrected everywhere, and the log itself
 * still carries nothing that has to be protected twice.
 */
const namesFor = async (ids) => {
    const valid = [...new Set(ids.filter((id) => id && mongoose.Types.ObjectId.isValid(id)).map(String))];
    if (!valid.length) return new Map();
    const users = await User.find({ _id: { $in: valid } }).select('firstName lastName email').lean();
    return new Map(users.map((u) => [String(u._id), {
        name: [u.firstName, u.lastName].filter(Boolean).join(' ') || null,
        email: u.email || null,
    }]));
};

const decorate = (entries, names) => entries.map((e) => {
    const patient = e.patientId ? names.get(String(e.patientId)) : null;
    return {
        _id: e._id,
        at: e.at,
        actorId: e.actorId,
        actorEmail: e.actorEmail || null,
        actorRole: e.actorRole,
        patientId: e.patientId || null,
        patientName: patient?.name || null,
        resource: e.resource,
        resourceId: e.resourceId || null,
        action: e.action,
        count: e.count ?? null,
    };
});

/**
 * GET /api/staff/access-log
 *
 * Query: `actorId`, `patientId`, `resource`, `actorRole`, `from`, `to`, `limit`, `skip`.
 */
exports.getAccessLog = async (req, res, next) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 50, 1), 200);
        const skip = Math.max(parseInt(req.query?.skip, 10) || 0, 0);
        const filter = accessLogFilter(req.query);

        const [entries, total] = await Promise.all([
            AccessLog.find(filter).sort({ at: -1 }).skip(skip).limit(limit).lean(),
            AccessLog.countDocuments(filter),
        ]);

        const names = await namesFor(entries.map((e) => e.patientId));

        /**
         * Reading the audit trail is itself audited.
         *
         * An administrator who can see every clinician's reads is the account with no other
         * check on it, and "who has been through the log" is a question a governance review
         * will ask about them. One entry with a count, the same shape the queue writes.
         */
        await recordAccess({
            actor: req.auth,
            resource: 'access_log',
            patientId: filter.patientId || null,
            count: entries.length,
        });

        res.json({ entries: decorate(entries, names), total, limit, skip });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/staff/access-log/export — the same query, as CSV.
 *
 * Capped at `EXPORT_LIMIT` rows. A governance request is for a period or a person, and an
 * unbounded export is how a request for one clinician's month becomes the whole collection
 * in a spreadsheet on somebody's laptop.
 *
 * **Only the log is exportable, never the records it describes.** There is deliberately no
 * CSV of the queue or of patient context: an exported spreadsheet of patient names has left
 * the audited system, and nothing in this collection — or any other — can record what
 * happens to it next.
 */
const EXPORT_LIMIT = 10_000;

exports.exportAccessLog = async (req, res, next) => {
    try {
        const filter = accessLogFilter(req.query);
        const entries = await AccessLog.find(filter).sort({ at: -1 }).limit(EXPORT_LIMIT).lean();
        const names = await namesFor(entries.map((e) => e.patientId));

        await recordAccess({
            actor: req.auth,
            resource: 'access_log',
            patientId: filter.patientId || null,
            count: entries.length,
        });

        console.log(`📤 Access log exported: ${entries.length} rows by ${req.auth?.email || req.auth?.userId}`);

        const stamp = new Date().toISOString().slice(0, 10);
        sendCsv(
            res,
            `labtrack-access-log-${stamp}.csv`,
            [
                { key: 'at', label: 'When' },
                { key: 'actorEmail', label: 'Staff email' },
                { key: 'actorRole', label: 'Role' },
                { key: 'actorId', label: 'Staff id' },
                { key: 'patientName', label: 'Patient' },
                { key: 'patientId', label: 'Patient id' },
                { key: 'resource', label: 'Resource' },
                { key: 'resourceId', label: 'Record id' },
                { key: 'action', label: 'Action' },
                { key: 'count', label: 'Records returned' },
            ],
            decorate(entries, names),
        );
    } catch (error) {
        next(error);
    }
};
