/**
 * Supabase Admin API client.
 *
 * Staff accounts are Supabase accounts carrying an `app_metadata.role` claim, which is what
 * `roleFromClaims` reads and `requireRole` gates on. Creating one therefore means talking to
 * Supabase, not writing a Mongo document — this module is the only place that happens.
 *
 * `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SECRET_KEY`, the newer name for the same thing)
 * bypasses every row-level policy. It must never be sent to a client, logged, or returned in
 * a response. Nothing here does; keep it that way.
 *
 * Plain fetch rather than `@supabase/supabase-js`: the backend needs four calls and no
 * session handling, and this avoids a dependency whose main job here would be idle.
 */

const SUPABASE_URL = () => (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = () =>
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';

/** Whether staff administration is available at all. */
const isConfigured = () => Boolean(SUPABASE_URL() && SERVICE_KEY());

const request = async (path, options = {}) => {
    if (!isConfigured()) {
        throw Object.assign(
            new Error(
                'Supabase admin is not configured. Set SUPABASE_SERVICE_ROLE_KEY (or ' +
                'SUPABASE_SECRET_KEY) and SUPABASE_URL.'
            ),
            { status: 503 }
        );
    }

    const key = SERVICE_KEY();
    const res = await fetch(`${SUPABASE_URL()}/auth/v1${path}`, {
        ...options,
        headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            ...(options.headers || {}),
        },
    });

    const text = await res.text();
    let body = null;
    if (text) {
        try {
            body = JSON.parse(text);
        } catch {
            body = text;
        }
    }

    if (!res.ok) {
        const message =
            (body && (body.msg || body.message || body.error_description || body.error)) ||
            `Supabase admin request failed (${res.status})`;
        // The status travels so the caller can distinguish "you asked for something
        // impossible" from "Supabase is unavailable" — a 4xx must not surface as a 500.
        throw Object.assign(new Error(message), { status: res.status });
    }

    return body;
};

/** The public shape of a staff account. Never includes tokens or identities. */
const publicUser = (user) => ({
    supabaseId: user.id,
    email: user.email || null,
    role: user.app_metadata?.role || 'user',
    createdAt: user.created_at || null,
    lastSignInAt: user.last_sign_in_at || null,
    // An invited account exists but has never been used; the portal says so rather than
    // showing it as an active member of staff.
    invitedAt: user.invited_at || null,
    confirmedAt: user.confirmed_at || user.email_confirmed_at || null,
});

/**
 * Page through every user.
 *
 * Filtering server-side is avoided deliberately: the admin endpoint's email filter has
 * changed shape between Supabase releases, and a filter that silently matches nothing reads
 * as "no such account" — which sends someone looking in entirely the wrong place.
 */
const listUsers = async ({ maxPages = 20, perPage = 200 } = {}) => {
    const all = [];
    for (let page = 1; page <= maxPages; page += 1) {
        const body = await request(`/admin/users?page=${page}&per_page=${perPage}`);
        const users = Array.isArray(body) ? body : body?.users || [];
        if (users.length === 0) break;
        all.push(...users);
        if (users.length < perPage) break;
    }
    return all;
};

const findByEmail = async (email) => {
    const target = String(email || '').trim().toLowerCase();
    if (!target) return null;
    const users = await listUsers();
    return users.find((u) => (u.email || '').toLowerCase() === target) || null;
};

const getUser = async (supabaseId) => request(`/admin/users/${supabaseId}`);

/**
 * Set a role on an existing account.
 *
 * Spreads the current `app_metadata` rather than replacing it: that object also carries
 * `provider` and `providers`, and dropping them breaks how the account signs in — a failure
 * that appears only at the next login, long after the change that caused it.
 */
const setRole = async (supabaseId, role) => {
    const current = await getUser(supabaseId);
    return request(`/admin/users/${supabaseId}`, {
        method: 'PUT',
        body: JSON.stringify({
            app_metadata: { ...(current.app_metadata || {}), role },
        }),
    });
};

/**
 * Invite someone by email, with their role attached from the start.
 *
 * `redirectTo` must be a URL on the Supabase project's allow list. An unlisted one is not
 * rejected — Supabase quietly falls back to the project's Site URL, which here belongs to
 * the patient app, so the invitee would land in the wrong product holding a valid session.
 */
const invite = async (email, { role, redirectTo }) =>
    request('/admin/invite', {
        method: 'POST',
        body: JSON.stringify({
            email,
            data: {},
            ...(redirectTo ? { redirect_to: redirectTo } : {}),
        }),
    }).then(async (user) => {
        // The invite endpoint does not accept app_metadata, so the role is applied straight
        // after. Done here rather than left to the caller: an invited account with no role
        // reaches the portal and is bounced to /no-access, which looks like a broken invite.
        if (user?.id && role) return setRole(user.id, role);
        return user;
    });

module.exports = { isConfigured, listUsers, findByEmail, getUser, setRole, invite, publicUser };
