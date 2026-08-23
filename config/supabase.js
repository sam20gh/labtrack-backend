/**
 * Supabase JWT verification.
 *
 * Supabase signs access tokens two ways depending on project age and settings:
 *   - HS256 with the project's "JWT secret"      → set SUPABASE_JWT_SECRET
 *   - RS256/ES256 with rotating asymmetric keys  → set SUPABASE_URL (JWKS is discovered)
 *
 * Both are supported; configure whichever the project uses. If neither env var is set,
 * Supabase verification is inert and `verifySupabaseToken` returns null, so the legacy
 * SECRET_KEY path in authMiddleware keeps working. That is what makes this deployable
 * before the Supabase project exists.
 *
 * `jose` v6 is ESM-only and this service is CommonJS, so it is loaded through a cached
 * dynamic import rather than require().
 *
 * WebCrypto: jose's webapi build resolves a bare `crypto` global. Node 20+ provides one;
 * Node 18 does not expose it to module scope, and without the shim below every signature
 * check throws `ReferenceError: crypto is not defined` — which this module would catch and
 * report as "invalid token". The failure mode is nasty: Supabase auth silently degrades to
 * the legacy path, and flipping LEGACY_AUTH_DISABLED would lock every user out. The engines
 * field pins Node >= 20; the shim keeps it correct if it ever runs on 18 anyway.
 */
const { webcrypto } = require('node:crypto');
if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

// Supabase sets `aud: "authenticated"` on user access tokens
const EXPECTED_AUDIENCE = 'authenticated';
const ISSUER = SUPABASE_URL ? `${SUPABASE_URL}/auth/v1` : null;

const isConfigured = () => Boolean(SUPABASE_URL || SUPABASE_JWT_SECRET);

let josePromise = null;
let jwks = null;
let hsKey = null;

/** Load jose once and build the key sources. */
const getJose = async () => {
    if (!josePromise) {
        josePromise = import('jose').then((jose) => {
            if (SUPABASE_URL) {
                // Caches keys and refetches on rotation / unknown kid
                jwks = jose.createRemoteJWKSet(
                    new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`)
                );
            }
            if (SUPABASE_JWT_SECRET) {
                hsKey = new TextEncoder().encode(SUPABASE_JWT_SECRET);
            }
            return jose;
        });
    }
    return josePromise;
};

/**
 * Verify a Supabase access token.
 * @returns {Promise<object|null>} the JWT claims, or null when the token is not a valid
 *   Supabase token (or Supabase is not configured). Never throws.
 */
const verifySupabaseToken = async (token) => {
    if (!isConfigured()) return null;

    const { jwtVerify } = await getJose();

    const options = { audience: EXPECTED_AUDIENCE };
    if (ISSUER) options.issuer = ISSUER;

    // Asymmetric first — the mode Supabase steers new projects toward
    if (jwks) {
        try {
            const { payload } = await jwtVerify(token, jwks, options);
            return payload;
        } catch (err) {
            // Fall through to the shared-secret attempt below
        }
    }

    if (hsKey) {
        try {
            const { payload } = await jwtVerify(token, hsKey, options);
            return payload;
        } catch (err) {
            return null;
        }
    }

    return null;
};

/**
 * Supabase carries app-specific claims in app_metadata (server-controlled) and
 * user_metadata (user-writable — never trust it for authorisation).
 */
const roleFromClaims = (claims) => claims?.app_metadata?.role || 'user';

module.exports = { verifySupabaseToken, isConfigured, roleFromClaims, SUPABASE_URL };
