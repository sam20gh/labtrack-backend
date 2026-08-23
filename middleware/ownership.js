/**
 * Ownership checks.
 *
 * authenticateToken only proves *a* valid token was sent — not that it belongs to the
 * record being addressed. Without these guards any signed-in user could read, modify, or
 * delete any other user's profile, health assessment, or plans by changing the id in the
 * URL. That matters more here than in most apps: these records are medical.
 *
 * Must run after authenticateToken.
 */
const Plan = require('../models/Plan');

const ADMIN_ROLES = ['admin'];

/**
 * Require that the :param in the route matches the authenticated user's id.
 * Admins bypass the check.
 */
const requireSelf = (paramName = 'id') => (req, res, next) => {
    if (!req.auth) return res.status(401).json({ message: 'Authentication required' });
    if (ADMIN_ROLES.includes(req.auth.role)) return next();

    const target = req.params[paramName];
    if (!target) return res.status(400).json({ message: `Missing ${paramName} parameter` });

    if (String(target) !== String(req.auth.userId)) {
        // 404 rather than 403: do not confirm that another user's id exists
        return res.status(404).json({ message: 'Not found' });
    }

    next();
};

/**
 * Require that a query parameter identifying a user matches the caller.
 * Used by collection endpoints filtered with ?user_id=.
 */
const requireSelfQuery = (queryName = 'user_id') => (req, res, next) => {
    if (!req.auth) return res.status(401).json({ message: 'Authentication required' });
    if (ADMIN_ROLES.includes(req.auth.role)) return next();

    const target = req.query[queryName];
    if (!target) return res.status(400).json({ message: `${queryName} is required` });

    if (String(target) !== String(req.auth.userId)) {
        return res.status(403).json({ message: 'Cannot access another user\'s records' });
    }

    next();
};

/**
 * Require that the body identifies the caller — for creates that embed a user id.
 * `path` is a dot-path into req.body (e.g. 'patient.user_id').
 */
const requireSelfBody = (path) => (req, res, next) => {
    if (!req.auth) return res.status(401).json({ message: 'Authentication required' });
    if (ADMIN_ROLES.includes(req.auth.role)) return next();

    const target = path.split('.').reduce((acc, key) => acc?.[key], req.body);
    if (!target) return res.status(400).json({ message: `Missing ${path}` });

    if (String(target) !== String(req.auth.userId)) {
        return res.status(403).json({ message: 'Cannot create records for another user' });
    }

    next();
};

/** Require that the plan named by :planId belongs to the caller. */
const requirePlanOwner = (paramName = 'planId') => async (req, res, next) => {
    try {
        if (!req.auth) return res.status(401).json({ message: 'Authentication required' });
        if (ADMIN_ROLES.includes(req.auth.role)) return next();

        const plan = await Plan.findById(req.params[paramName]).select('userID');
        if (!plan) return res.status(404).json({ message: 'Plan not found' });

        if (String(plan.userID) !== String(req.auth.userId)) {
            return res.status(404).json({ message: 'Plan not found' });
        }

        next();
    } catch (err) {
        console.error('❌ Ownership check failed:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
};

module.exports = { requireSelf, requireSelfQuery, requireSelfBody, requirePlanOwner };
