/**
 * Staff administration — who may sign in to the portal, and as what.
 *
 * A role here is the difference between an account that can read its own records and one
 * that can read everybody's. Every handler is admin-gated at the router, and every change
 * is logged with who made it, because "who granted this person access" is the first
 * question an information-governance review asks.
 */
const admin = require('../config/supabaseAdmin');

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

        const existing = await admin.findByEmail(email);
        if (existing) {
            // Inviting an existing account would send a fresh invite link to someone who
            // already has one, which is a confusing way to say "grant this person a role".
            return res.status(409).json({
                message:
                    `${email} already has an account. Change their role instead of inviting them.`,
                supabaseId: existing.id,
                role: existing.app_metadata?.role || 'user',
            });
        }

        // Must be on the Supabase URL allow list, or Supabase silently substitutes the
        // project's Site URL — which belongs to the patient app.
        const redirectTo = req.body.redirectTo || process.env.PORTAL_URL
            ? `${(req.body.redirectTo || process.env.PORTAL_URL).replace(/\/$/, '')}/auth/callback`
            : undefined;

        const user = await admin.invite(email, { role, redirectTo });

        console.log(`👤 Staff invited: ${email} as ${role} by ${req.auth?.email || req.auth?.userId}`);
        res.status(201).json({ staff: admin.publicUser(user) });
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
