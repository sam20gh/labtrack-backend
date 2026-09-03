/**
 * Staff access — who may sign in to the portal, and as what.
 *
 * A role is the difference between an account that reads its own records and one that reads
 * everybody's, so the guards here matter more than the happy path. Supabase is stubbed:
 * these assert this service's rules, not Supabase's behaviour.
 *
 * The rule worth the most is the self-demotion guard. Demoting yourself is irreversible
 * from inside the product — the next request is refused and the only way back is a script
 * or the database — so it is the single mistake on that screen a person cannot undo.
 */
jest.mock('../config/supabaseAdmin');

const admin = require('../config/supabaseAdmin');
const { listStaff, inviteStaff, setStaffRole } = require('../controllers/staffController');

const mockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
};

const next = jest.fn();

const supabaseUser = (over = {}) => ({
    id: 'sb-1',
    email: 'someone@example.com',
    app_metadata: { provider: 'email', providers: ['email'], role: 'professional' },
    created_at: '2026-01-01T00:00:00Z',
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    admin.publicUser.mockImplementation((u) => ({
        supabaseId: u.id,
        email: u.email,
        role: u.app_metadata?.role || 'user',
        createdAt: u.created_at || null,
        lastSignInAt: u.last_sign_in_at || null,
        invitedAt: u.invited_at || null,
        confirmedAt: u.confirmed_at || null,
    }));
});

describe('listStaff', () => {
    it('returns only accounts holding a portal role', async () => {
        admin.listUsers.mockResolvedValue([
            supabaseUser({ id: 'a', email: 'admin@x.co', app_metadata: { role: 'admin' } }),
            supabaseUser({ id: 'p', email: 'doc@x.co', app_metadata: { role: 'professional' } }),
            // A patient. The overwhelming majority of accounts, and none of them staff.
            supabaseUser({ id: 'u', email: 'patient@x.co', app_metadata: { role: 'user' } }),
        ]);

        const res = mockRes();
        await listStaff({}, res, next);

        const { staff, count } = res.json.mock.calls[0][0];
        expect(count).toBe(2);
        expect(staff.map((s) => s.email).sort()).toEqual(['admin@x.co', 'doc@x.co']);
    });
});

describe('inviteStaff', () => {
    it('rejects an invite with no usable email', async () => {
        const res = mockRes();
        await inviteStaff({ body: { email: 'nope', role: 'admin' }, auth: {} }, res, next);
        expect(res.status).toHaveBeenCalledWith(400);
    });

    it('refuses to invite somebody as a patient', async () => {
        const res = mockRes();
        await inviteStaff({ body: { email: 'a@x.co', role: 'user' }, auth: {} }, res, next);

        // "Invite someone with no portal access" is not a coherent request; it would send an
        // invitation to an account that is then bounced at the door.
        expect(res.status).toHaveBeenCalledWith(400);
    });

    it('refuses an unknown role', async () => {
        const res = mockRes();
        await inviteStaff({ body: { email: 'a@x.co', role: 'superuser' }, auth: {} }, res, next);
        expect(res.status).toHaveBeenCalledWith(400);
    });

    it('will not re-invite somebody who already has a working account', async () => {
        admin.findByEmail.mockResolvedValue(
            supabaseUser({ email: 'already@x.co', confirmed_at: '2026-02-01T00:00:00Z' })
        );

        const res = mockRes();
        await inviteStaff({ body: { email: 'already@x.co', role: 'admin' }, auth: {} }, res, next);

        // Sending a fresh invite link to someone who can already sign in is a confusing way
        // to say "grant this person a role" — the role screen is what they want.
        expect(res.status).toHaveBeenCalledWith(409);
        expect(admin.invite).not.toHaveBeenCalled();
    });

    it('resends to an account that was invited and never signed in', async () => {
        /**
         * The state this rescues: the account exists, so an invite used to be refused; the
         * person cannot sign in, so they could not fix it themselves. There was no way out
         * from inside the product, and an invite link dies easily — single-use and spent by
         * a mail scanner, superseded by a later invite, or simply expired.
         */
        admin.findByEmail.mockResolvedValue(
            supabaseUser({ email: 'pending@x.co', invited_at: '2026-02-01T00:00:00Z' })
        );
        admin.invite.mockResolvedValue(supabaseUser({ email: 'pending@x.co' }));

        const res = mockRes();
        await inviteStaff({ body: { email: 'pending@x.co', role: 'admin' }, auth: {} }, res, next);

        expect(admin.invite).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(201);

        const body = res.json.mock.calls[0][0];
        expect(body.resent).toBe(true);
        // Reissuing cancels the earlier link, and an admin who does not know that will tell
        // the invitee to try the first email again.
        expect(body.note).toMatch(/no longer works/i);
    });

    it('prefers the configured portal URL over whatever the browser reports', async () => {
        /**
         * The failure this prevents, which happened: an administrator opened the portal on a
         * Vercel deployment URL rather than the production alias, the browser sent that origin
         * as `redirectTo`, and it is not on Supabase's redirect allow list. Supabase does not
         * reject an unlisted redirect — it **silently substitutes the project's Site URL** —
         * so the invitation pointed somewhere nobody chose. Nothing in that chain errors.
         */
        const previous = process.env.PORTAL_URL;
        process.env.PORTAL_URL = 'https://labtrack-web.vercel.app';

        admin.findByEmail.mockResolvedValue(null);
        admin.invite.mockResolvedValue(supabaseUser({ email: 'new@x.co' }));

        const res = mockRes();
        await inviteStaff(
            {
                body: {
                    email: 'new@x.co',
                    role: 'admin',
                    redirectTo: 'https://labtrack-web-grub24.vercel.app',
                },
                auth: {},
            },
            res,
            next
        );

        expect(admin.invite).toHaveBeenCalledWith(
            'new@x.co',
            expect.objectContaining({
                redirectTo: 'https://labtrack-web.vercel.app/auth/callback',
            })
        );
        // Echoed back, because a silent substitution is only catchable if somebody is shown
        // where the link actually points.
        expect(res.json.mock.calls[0][0].redirectTo).toBe(
            'https://labtrack-web.vercel.app/auth/callback'
        );

        if (previous === undefined) delete process.env.PORTAL_URL;
        else process.env.PORTAL_URL = previous;
    });

    it('falls back to the caller origin when no portal URL is configured', async () => {
        // Local development, where there is no PORTAL_URL to prefer.
        const previous = process.env.PORTAL_URL;
        delete process.env.PORTAL_URL;

        admin.findByEmail.mockResolvedValue(null);
        admin.invite.mockResolvedValue(supabaseUser({ email: 'new@x.co' }));

        await inviteStaff(
            { body: { email: 'new@x.co', role: 'admin', redirectTo: 'http://localhost:3000' }, auth: {} },
            mockRes(),
            next
        );

        expect(admin.invite).toHaveBeenCalledWith(
            'new@x.co',
            expect.objectContaining({ redirectTo: 'http://localhost:3000/auth/callback' })
        );

        if (previous !== undefined) process.env.PORTAL_URL = previous;
    });

    it('reports a Supabase email failure as an upstream problem, with its reason', async () => {
        /**
         * The failure this rescues from silence. Supabase answers `500 Error sending invite
         * email` when its mailer is rate-limited or unconfigured — and a 500 handed to the
         * global error handler is deliberately stripped of its message, because a 5xx there
         * means *our* fault and must not leak internals. So a completely actionable problem
         * on somebody else's side reached the admin as "Something went wrong on our side".
         */
        admin.findByEmail.mockResolvedValue(null);
        admin.invite.mockRejectedValue(
            Object.assign(new Error('Error sending invite email'), {
                status: 500,
                errorId: '01a068b9-df33-7863',
            })
        );

        const res = mockRes();
        await inviteStaff({ body: { email: 'new@x.co', role: 'admin' }, auth: {} }, res, next);

        // 502, not 500: the upstream did not do its job. And not `next(error)`, which is what
        // discarded the message.
        expect(res.status).toHaveBeenCalledWith(502);
        expect(next).not.toHaveBeenCalled();

        const body = res.json.mock.calls[0][0];
        expect(body.message).toMatch(/custom SMTP/i);
        expect(body.providerMessage).toBe('Error sending invite email');
        // Keyed on by an Auth Logs search; the console holding it will be closed by then.
        expect(body.errorId).toBe('01a068b9-df33-7863');
        // GoTrue rolls the account back, and saying so stops a hunt for a half-made one.
        expect(body.accountCreated).toBe(false);
    });

    it('does not swallow a failure that is not about email', async () => {
        // A bad request must keep its own status and reach the error handler unchanged.
        admin.findByEmail.mockResolvedValue(null);
        admin.invite.mockRejectedValue(Object.assign(new Error('Invalid role'), { status: 400 }));

        const res = mockRes();
        await inviteStaff({ body: { email: 'new@x.co', role: 'admin' }, auth: {} }, res, next);

        expect(res.status).not.toHaveBeenCalledWith(502);
        expect(next).toHaveBeenCalled();
    });

    it('treats a past sign-in as a working account even without a confirmation date', async () => {
        admin.findByEmail.mockResolvedValue(
            supabaseUser({ email: 'oauth@x.co', last_sign_in_at: '2026-02-02T00:00:00Z' })
        );

        const res = mockRes();
        await inviteStaff({ body: { email: 'oauth@x.co', role: 'admin' }, auth: {} }, res, next);
        expect(res.status).toHaveBeenCalledWith(409);
    });

    it('invites with the role attached, so the first sign-in already works', async () => {
        admin.findByEmail.mockResolvedValue(null);
        admin.invite.mockResolvedValue(
            supabaseUser({ id: 'new', email: 'new@x.co', app_metadata: { role: 'admin' } })
        );

        const res = mockRes();
        await inviteStaff(
            { body: { email: 'New@X.co', role: 'admin' }, auth: { email: 'me@x.co' } },
            res,
            next
        );

        expect(admin.invite).toHaveBeenCalledWith(
            'new@x.co', // normalised
            expect.objectContaining({ role: 'admin' })
        );
        expect(res.status).toHaveBeenCalledWith(201);
    });
});

describe('setStaffRole', () => {
    it('refuses to let an admin change their own role', async () => {
        const res = mockRes();
        await setStaffRole(
            {
                params: { supabaseId: 'sb-me' },
                body: { role: 'user' },
                auth: { supabaseId: 'sb-me', email: 'me@x.co' },
            },
            res,
            next
        );

        expect(res.status).toHaveBeenCalledWith(409);
        // The point of the guard: nothing was written, so access survives.
        expect(admin.setRole).not.toHaveBeenCalled();
    });

    it('allows changing somebody else', async () => {
        admin.getUser.mockResolvedValue(supabaseUser({ id: 'sb-other', email: 'them@x.co' }));
        admin.setRole.mockResolvedValue(
            supabaseUser({ id: 'sb-other', email: 'them@x.co', app_metadata: { role: 'admin' } })
        );

        const res = mockRes();
        await setStaffRole(
            {
                params: { supabaseId: 'sb-other' },
                body: { role: 'admin' },
                auth: { supabaseId: 'sb-me', email: 'me@x.co' },
            },
            res,
            next
        );

        expect(admin.setRole).toHaveBeenCalledWith('sb-other', 'admin');
        const payload = res.json.mock.calls[0][0];
        expect(payload.previousRole).toBe('professional');
        // The claim rides in the access token, so it is stale until the next sign-in.
        // Saying so is what stops the change being reported as broken.
        expect(payload.note).toMatch(/next sign in/i);
    });

    it('refuses a role outside the known set', async () => {
        const res = mockRes();
        await setStaffRole(
            {
                params: { supabaseId: 'sb-other' },
                body: { role: 'root' },
                auth: { supabaseId: 'sb-me' },
            },
            res,
            next
        );

        expect(res.status).toHaveBeenCalledWith(400);
        expect(admin.setRole).not.toHaveBeenCalled();
    });

    it('supports revoking access by setting the role back to user', async () => {
        admin.getUser.mockResolvedValue(supabaseUser({ id: 'sb-other' }));
        admin.setRole.mockResolvedValue(
            supabaseUser({ id: 'sb-other', app_metadata: { role: 'user' } })
        );

        const res = mockRes();
        await setStaffRole(
            {
                params: { supabaseId: 'sb-other' },
                body: { role: 'user' },
                auth: { supabaseId: 'sb-me' },
            },
            res,
            next
        );

        expect(admin.setRole).toHaveBeenCalledWith('sb-other', 'user');
    });
});
