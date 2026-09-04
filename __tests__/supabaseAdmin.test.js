/**
 * The Supabase Admin API calls themselves.
 *
 * `__tests__/staffAccess.test.js` stubs this whole module to test the controller's rules,
 * which left the one part that actually talks to Supabase with no coverage at all — and it
 * was wrong in two ways at once:
 *
 *  1. The invite went to `/auth/v1/admin/invite`. The endpoint is `/auth/v1/invite`. Almost
 *     every other privileged GoTrue route *is* under `/admin`, so the wrong path is the one
 *     that looks consistent — and it answers **404**, which reads as "no such user" and sends
 *     you looking at the email address.
 *  2. `redirect_to` was sent in the body. GoTrue reads it from the query string and ignores
 *     a body key of the same name, silently, because an invite with no redirect is a valid
 *     invite. Supabase then substitutes the project's Site URL — the *patient app* — so the
 *     invitee lands in the wrong product holding a valid session, with nothing reporting a
 *     fault.
 *
 * The second would have survived fixing the first, and would only ever have shown up as a
 * person clicking an invite and ending up somewhere strange. So these tests pin the URL.
 */
const admin = require('../config/supabaseAdmin');

const ORIGINAL = { ...process.env };
let calls;

const jsonResponse = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
});

beforeEach(() => {
    process.env.SUPABASE_URL = 'https://project.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
    calls = [];

    global.fetch = jest.fn(async (url, options) => {
        calls.push({ url, options });
        // `invite` chains into `setRole`, which reads the account first.
        if (String(url).includes('/admin/users/')) {
            return jsonResponse({ id: 'sb-1', app_metadata: { provider: 'email', role: 'professional' } });
        }
        return jsonResponse({ id: 'sb-1', email: 'new@example.com', app_metadata: {} });
    });
});

afterEach(() => {
    process.env = { ...ORIGINAL };
    delete global.fetch;
});

const inviteCall = () => calls.find((c) => String(c.url).includes('/invite'));

describe('invite', () => {
    it('posts to /auth/v1/invite, not /auth/v1/admin/invite', async () => {
        await admin.invite('new@example.com', { role: 'professional' });

        const call = inviteCall();
        expect(call.url).toContain('/auth/v1/invite');
        // The bug. `/admin/invite` does not exist and answers 404.
        expect(call.url).not.toContain('/admin/invite');
        expect(call.options.method).toBe('POST');
    });

    it('sends redirect_to as a query parameter, where GoTrue reads it', async () => {
        await admin.invite('new@example.com', {
            role: 'professional',
            redirectTo: 'https://labtrack-web.vercel.app/auth/callback',
        });

        const call = inviteCall();
        const url = new URL(call.url);
        expect(url.searchParams.get('redirect_to')).toBe(
            'https://labtrack-web.vercel.app/auth/callback'
        );

        // In the body it is ignored silently, and the invitee lands on the patient app.
        expect(JSON.parse(call.options.body).redirect_to).toBeUndefined();
    });

    it('omits the parameter entirely when there is no redirect', async () => {
        // Rather than sending an empty one, which GoTrue would treat as a URL to validate.
        await admin.invite('new@example.com', { role: 'professional' });
        expect(inviteCall().url).not.toContain('redirect_to');
    });

    it('never puts the role in user_metadata', async () => {
        await admin.invite('new@example.com', { role: 'admin' });

        /**
         * `data` is user_metadata, which the account holder can edit. A role there would be
         * self-assignable; `roleFromClaims` reads app_metadata for exactly that reason.
         *
         * Asserted as "no role", not as "empty": user_metadata legitimately carries
         * `password_set`, and an equality check against `{}` made adding that field look like
         * a regression in role handling, which it is not.
         */
        const data = JSON.parse(inviteCall().options.body).data;
        expect(data.role).toBeUndefined();
        expect(Object.keys(data)).not.toContain('role');
        // An invited account has no password at all until it chooses one.
        expect(data.password_set).toBe(false);

        const roleCall = calls.find((c) => c.options.method === 'PUT');
        expect(JSON.parse(roleCall.options.body).app_metadata.role).toBe('admin');
    });

    it('preserves provider metadata when attaching the role', async () => {
        // Dropping `provider`/`providers` breaks how the account signs in, and only at the
        // next login — long after the change that caused it.
        await admin.invite('new@example.com', { role: 'professional' });

        const roleCall = calls.find((c) => c.options.method === 'PUT');
        expect(JSON.parse(roleCall.options.body).app_metadata.provider).toBe('email');
    });
});

describe('error reporting', () => {
    it('carries the HTTP status so a 4xx does not surface as a 500', async () => {
        global.fetch = jest.fn(async () => jsonResponse({ msg: 'User already registered' }, 422));

        await expect(admin.invite('taken@example.com', { role: 'admin' })).rejects.toMatchObject({
            status: 422,
            message: 'User already registered',
        });
    });

    it('refuses with 503 rather than calling out when unconfigured', async () => {
        delete process.env.SUPABASE_SERVICE_ROLE_KEY;
        delete process.env.SUPABASE_SECRET_KEY;

        await expect(admin.listUsers()).rejects.toMatchObject({ status: 503 });
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

describe('the other admin routes', () => {
    it('reads and writes users under /admin/users, which is where they do live', async () => {
        await admin.getUser('sb-1');
        expect(calls.at(-1).url).toContain('/auth/v1/admin/users/sb-1');

        calls = [];
        await admin.listUsers({ maxPages: 1, perPage: 200 });
        expect(calls[0].url).toContain('/auth/v1/admin/users?page=1');
    });

    it('sends the service key as both apikey and bearer, and never in a response', async () => {
        await admin.getUser('sb-1');
        const { headers } = calls.at(-1).options;
        expect(headers.apikey).toBe('service-key');
        expect(headers.Authorization).toBe('Bearer service-key');

        // publicUser is the only shape that reaches a client.
        expect(JSON.stringify(admin.publicUser({ id: 'sb-1', app_metadata: {} })))
            .not.toContain('service-key');
    });
});
