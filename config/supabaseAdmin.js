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
        //
        // `supabaseCode` and `errorId` travel too. Supabase's own failures are the ones an
        // operator has to act on, and its `error_id` is what a support request or an Auth
        // Logs search is keyed on — losing it means the only copy is in a browser console
        // that has since been closed.
        throw Object.assign(new Error(message), {
            status: res.status,
            supabaseCode: body?.error_code || null,
            errorId: body?.error_id || null,
        });
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
 * Two things about this call are easy to get wrong, and both were wrong here:
 *
 * 1. **The path is `/invite`, not `/admin/invite`.** Almost every other privileged GoTrue
 *    route lives under `/admin` — `/admin/users`, `/admin/users/{id}` — so the wrong path is
 *    the one that looks consistent. It answers **404**, which reads as "no such user" rather
 *    than "no such endpoint" and sends you looking at the email address.
 *
 * 2. **`redirect_to` is a query parameter, not a body field.** GoTrue reads it off the query
 *    string and ignores a body key of the same name — silently, because an invite with no
 *    redirect is a valid invite. It then falls back to the project's Site URL, which here
 *    belongs to the *patient app*: the invitee follows the link, lands in the wrong product
 *    holding a valid session, and nothing anywhere reports a problem. This is the failure the
 *    comment below already warned about, caused by the code the comment was attached to.
 *
 * `redirectTo` must also be on the Supabase project's URL allow list, or Supabase performs
 * the same substitution for its own reasons — see `.env.example`.
 */
const invite = async (email, { role, redirectTo }) =>
    request(`/invite${redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : ''}`, {
        method: 'POST',
        /**
         * `data` is user_metadata — user-writable, so never a role. The role is applied below
         * via app_metadata, which only this key can write.
         *
         * `password_set: false` marks an account that has arrived by invitation and therefore
         * **has no password at all**. Accepting an invite establishes a session directly, so
         * an invitee who signs out has no way back in and no way to ask for one: a password
         * reset for an account with no password is still an email, and the portal cannot
         * offer them anything else. The portal reads this flag and makes setting a password
         * part of accepting the invitation.
         *
         * A UX gate, not a security control — the account holder can edit their own
         * user_metadata. Nothing is protected by it; it decides which screen they see.
         */
        body: JSON.stringify({ email, data: { password_set: false } }),
    }).then(async (user) => {
        // The invite endpoint does not accept app_metadata, so the role is applied straight
        // after. Done here rather than left to the caller: an invited account with no role
        // reaches the portal and is bounced to /no-access, which looks like a broken invite.
        if (user?.id && role) return setRole(user.id, role);
        return user;
    });

module.exports = { isConfigured, listUsers, findByEmail, getUser, setRole, invite, publicUser };
