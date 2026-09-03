/**
 * Authentication and authorisation.
 *
 * Accepts two token families during the Supabase migration:
 *   1. Supabase access tokens (see config/supabase.js) — the target state
 *   2. Legacy tokens signed by this API with SECRET_KEY — existing app builds
 *
 * Legacy acceptance is deliberately time-boxed: set LEGACY_AUTH_DISABLED=true to turn it
 * off once every client ships on Supabase.
 *
 * On success every handler can rely on:
 *   req.auth = { userId, supabaseId, role, source }
 *   req.user = <legacy alias, kept so existing handlers keep working>
 */
const jwt = require('jsonwebtoken');
const User = require('../models/userModel');
const { verifySupabaseToken, roleFromClaims, aalFromClaims } = require('../config/supabase');

/**
 * Read at call time rather than module load.
 *
 * Capturing these in constants meant the values were frozen at first import — before
 * dotenv had necessarily run, depending on require order, and unreachable from a test that
 * sets them in `beforeAll`. Reading per request costs nothing and removes a class of
 * "works locally, not in CI" failure.
 */
const secretKey = () => process.env.SECRET_KEY;
const legacyAuthDisabled = () => process.env.LEGACY_AUTH_DISABLED === 'true';

const bearerToken = (req) => {
    const header = req.header('Authorization') || '';
    const [scheme, token] = header.split(' ');
    return scheme === 'Bearer' && token ? token : null;
};

/**
 * Resolve a Supabase identity to a local User, linking by email on first sight so
 * existing accounts survive the migration instead of being duplicated.
 */
const resolveSupabaseUser = async (claims) => {
    const supabaseId = claims.sub;
    const email = claims.email;

    let user = await User.findOne({ supabaseId }).select('_id');
    if (user) return user;

    if (email) {
        user = await User.findOneAndUpdate(
            { email },
            { $set: { supabaseId } },
            { new: true }
        ).select('_id');
        if (user) return user;
    }

    return null;
};

/** Verify a token without rejecting the request. Returns an auth object or null. */
const resolveAuth = async (req) => {
    const token = bearerToken(req);
    if (!token) return null;

    const claims = await verifySupabaseToken(token);
    if (claims) {
        const user = await resolveSupabaseUser(claims);
        return {
            userId: user ? String(user._id) : null,
            supabaseId: claims.sub,
            email: claims.email,
            role: roleFromClaims(claims),
            // How this session proved identity — 'aal2' means a second factor was completed.
            // See `requireMfa` below.
            aal: aalFromClaims(claims),
            source: 'supabase',
        };
    }

    if (!legacyAuthDisabled() && secretKey()) {
        try {
            const payload = jwt.verify(token, secretKey());
            return {
                userId: payload.id ? String(payload.id) : null,
                supabaseId: null,
                email: payload.email || null,
                role: payload.role || 'user',
                // A legacy token predates MFA entirely and can never carry a second factor.
                aal: null,
                source: 'legacy',
            };
        } catch (err) {
            return null;
        }
    }

    return null;
};

/** Reject the request unless it carries a valid token. */
const authenticateToken = async (req, res, next) => {
    try {
        if (!bearerToken(req)) {
            return res.status(401).json({ message: 'Access Denied: No Token Provided' });
        }

        const auth = await resolveAuth(req);
        if (!auth) return res.status(403).json({ message: 'Invalid Token' });

        // A valid Supabase token with no matching local User means the account was never
        // provisioned here — treat as unauthenticated rather than letting it through.
        if (!auth.userId) {
            return res.status(403).json({ message: 'No LabTrack account linked to this identity' });
        }

        req.auth = auth;
        req.user = { id: auth.userId, role: auth.role };
        next();
    } catch (err) {
        console.error('❌ Auth error:', err);
        res.status(500).json({ message: 'Authentication error' });
    }
};

/** Attach req.auth when a valid token is present, but allow anonymous requests. */
const optionalAuth = async (req, res, next) => {
    try {
        const auth = await resolveAuth(req);
        if (auth) {
            req.auth = auth;
            req.user = { id: auth.userId, role: auth.role };
        }
        next();
    } catch (err) {
        next();
    }
};

/**
 * Verify a Supabase token but do NOT require a linked local User.
 * Used only by the sync endpoint, which is what creates that link.
 */
const requireSupabaseIdentity = async (req, res, next) => {
    try {
        const token = bearerToken(req);
        if (!token) return res.status(401).json({ message: 'Access Denied: No Token Provided' });

        const claims = await verifySupabaseToken(token);
        if (!claims) return res.status(403).json({ message: 'Invalid Supabase token' });

        req.supabaseClaims = claims;
        next();
    } catch (err) {
        console.error('❌ Supabase auth error:', err);
        res.status(500).json({ message: 'Authentication error' });
    }
};

/** Require one of the given roles. Must run after authenticateToken. */
const requireRole = (...roles) => (req, res, next) => {
    if (!req.auth) return res.status(401).json({ message: 'Authentication required' });
    if (!roles.includes(req.auth.role)) {
        return res.status(403).json({ message: 'Insufficient permissions' });
    }
    next();
};

/**
 * Require a second factor on staff sessions.
 *
 * These accounts read other people's medical records, and a password alone is one
 * credential-stuffed login away from all of them. Supabase reports the strength of the
 * session on the token as `aal`; `aal2` means a TOTP challenge was completed in this
 * session, not merely that a factor exists on the account.
 *
 * ## Why this is off by default
 *
 * `STAFF_MFA_REQUIRED` gates it, and it defaults to **off**. Turning enforcement on before
 * every staff account has enrolled locks all of them out at once — including the
 * administrator who would have to turn it back off, whose own console is behind the same
 * check. That is not a hypothetical: the portal is live.
 *
 * The rollout is therefore three steps, in this order, and the middle one is what makes the
 * last one safe:
 *
 *   1. Staff enrol at `/account` in the portal (available now, no flag needed).
 *   2. `NEXT_PUBLIC_REQUIRE_MFA=true` on the portal — the UI stops letting anyone past
 *      enrolment, so `GET /api/staff` shows who is still outstanding.
 *   3. `STAFF_MFA_REQUIRED=true` here. Now it is enforced where it counts, because a portal
 *      redirect protects nothing from anyone holding a token and curl.
 *
 * A patient is deliberately untouched: mobile has no enrolment flow, and requiring a factor
 * there would lock people out of their own results.
 */
const STAFF_ROLES = ['professional', 'admin'];

const requireMfa = (req, res, next) => {
    if (process.env.STAFF_MFA_REQUIRED !== 'true') return next();
    if (!req.auth) return res.status(401).json({ message: 'Authentication required' });
    if (!STAFF_ROLES.includes(req.auth.role)) return next();

    // Null — a legacy token, or a project that mints no `aal` — is read as "not proven".
    // A missing claim must never satisfy a check about strength of authentication.
    if (req.auth.aal !== 'aal2') {
        return res.status(403).json({
            message:
                'This account needs two-factor authentication. Sign in to the portal and ' +
                'complete setup under Account, then sign in again.',
            code: 'mfa_required',
        });
    }

    next();
};

module.exports = { authenticateToken, optionalAuth, requireRole, requireMfa, requireSupabaseIdentity };
