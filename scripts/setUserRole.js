#!/usr/bin/env node
/**
 * Grant or revoke a portal role on a Supabase account.
 *
 *   node scripts/setUserRole.js sam20gh@gmail.com admin
 *   node scripts/setUserRole.js sam20gh@gmail.com professional
 *   node scripts/setUserRole.js sam20gh@gmail.com user       # revoke — back to patient
 *
 * Writes `app_metadata.role`, which is the ONLY place a role may live.
 * `user_metadata` is writable by the account holder, so a role stored there would let
 * anyone promote themselves by editing their own profile. `config/supabase.js:roleFromClaims`
 * reads `app_metadata` for exactly this reason.
 *
 * Needs SUPABASE_SERVICE_ROLE_KEY (Dashboard → Project Settings → API → service_role).
 * That key bypasses every row-level policy, so it belongs in .env on a trusted machine and
 * nowhere near a client bundle or a NEXT_PUBLIC_ variable.
 *
 * No new dependency: this speaks the Supabase Admin REST API over plain fetch.
 *
 * Without the key, the same edit runs in the dashboard's SQL Editor. The user detail page
 * renders `raw_app_meta_data` read-only, so the JSON cannot be edited where you can see it:
 *
 *   update auth.users
 *   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'::jsonb
 *   where email = 'someone@example.com';
 *
 * `||` merges rather than replaces, which is what keeps `provider` and `providers` intact.
 */
require('dotenv').config();

const ROLES = ['user', 'professional', 'admin'];

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');

/**
 * Supabase renamed its keys: `anon` became `publishable`, `service_role` became `secret`.
 * Projects created through the Vercel integration carry both generations, so accept either
 * name rather than making someone rename a variable that is already correct.
 */
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

const die = (message) => {
    console.error(`\n❌ ${message}\n`);
    process.exit(1);
};

const [, , email, role] = process.argv;

if (!email || !role) {
    die('Usage: node scripts/setUserRole.js <email> <user|professional|admin>');
}
if (!ROLES.includes(role)) {
    die(`Unknown role "${role}". Expected one of: ${ROLES.join(', ')}`);
}
if (!SUPABASE_URL) die('SUPABASE_URL is not set in .env');
if (!SERVICE_KEY) {
    die(
        'Neither SUPABASE_SERVICE_ROLE_KEY nor SUPABASE_SECRET_KEY is set in .env.\n' +
        '   Supabase dashboard → Project Settings → API. Newer projects call this key\n' +
        '   "secret"; older ones call it "service_role". Either works here.\n' +
        '   It bypasses row-level security — never expose it to a client.'
    );
}

const admin = (path, options = {}) =>
    fetch(`${SUPABASE_URL}/auth/v1/admin${path}`, {
        ...options,
        headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json',
            ...(options.headers || {}),
        },
    });

/**
 * Find a user by email.
 *
 * Paged rather than filtered: the admin endpoint's email filter has changed shape between
 * Supabase releases, and silently returning nothing for a user who exists would be read as
 * "wrong email" — which is the one conclusion that sends someone looking in the wrong place.
 */
const findUser = async (wanted) => {
    const target = wanted.trim().toLowerCase();

    for (let page = 1; page <= 20; page += 1) {
        const res = await admin(`/users?page=${page}&per_page=200`);
        if (!res.ok) {
            die(`Supabase returned ${res.status} listing users: ${await res.text()}`);
        }
        const body = await res.json();
        const users = Array.isArray(body) ? body : body.users || [];
        if (users.length === 0) return null;

        const hit = users.find((u) => (u.email || '').toLowerCase() === target);
        if (hit) return hit;
    }
    return null;
};

(async () => {
    const user = await findUser(email);
    if (!user) die(`No Supabase account found for ${email}`);

    const previous = user.app_metadata?.role || 'user';

    const res = await admin(`/users/${user.id}`, {
        method: 'PUT',
        // Spread the existing app_metadata: it also carries `provider` and `providers`,
        // and replacing the object wholesale would drop them.
        body: JSON.stringify({
            app_metadata: { ...(user.app_metadata || {}), role },
        }),
    });

    if (!res.ok) die(`Supabase returned ${res.status} updating the user: ${await res.text()}`);

    const updated = await res.json();
    const applied = updated.app_metadata?.role;

    console.log(`\n✅ ${email}`);
    console.log(`   role: ${previous} → ${applied}`);
    console.log(`   supabase id: ${user.id}`);
    console.log(
        '\n⚠️  Sign out and sign in again before testing.\n' +
        '   The role is baked into the access token when it is issued, so an existing\n' +
        '   session keeps the OLD role until its token is reissued. The portal will keep\n' +
        '   refusing you, and nothing about the error will mention a stale token.\n'
    );

    if (role === 'admin') {
        console.log(
            'ℹ️  An admin bypasses `requireSelf` in middleware/ownership.js — this account\n' +
            '   can now read any patient\'s records through the API, in the mobile app too.\n' +
            '   Revoke with:  node scripts/setUserRole.js ' + email + ' user\n'
        );
    }
})().catch((err) => die(err.message));
