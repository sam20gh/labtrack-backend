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
const { verifySupabaseToken, roleFromClaims } = require('../config/supabase');

const SECRET_KEY = process.env.SECRET_KEY;
const LEGACY_AUTH_DISABLED = process.env.LEGACY_AUTH_DISABLED === 'true';

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
            source: 'supabase',
        };
    }

    if (!LEGACY_AUTH_DISABLED && SECRET_KEY) {
        try {
            const payload = jwt.verify(token, SECRET_KEY);
            return {
                userId: payload.id ? String(payload.id) : null,
                supabaseId: null,
                email: payload.email || null,
                role: payload.role || 'user',
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

module.exports = { authenticateToken, optionalAuth, requireRole, requireSupabaseIdentity };
