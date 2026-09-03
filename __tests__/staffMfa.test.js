/**
 * Two-factor authentication on staff sessions.
 *
 * These accounts read other people's medical records; a password alone is one
 * credential-stuffed login away from all of them. What has to be true:
 *
 *  - the check reads the **session's** strength (`aal`), not whether a factor exists on the
 *    account — an enrolled factor that is never challenged protects nothing;
 *  - a **missing** claim is "not proven", never "fine";
 *  - it is **off by default**, because turning it on before staff have enrolled locks out
 *    every one of them, including the administrator who would turn it off again;
 *  - patients are untouched — mobile has no enrolment flow.
 */
const { requireMfa } = require('../middleware/authMiddleware');
const { aalFromClaims } = require('../config/supabase');

const mockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
};

const run = (auth) => {
    const res = mockRes();
    const next = jest.fn();
    requireMfa({ auth }, res, next);
    return { res, next };
};

describe('aalFromClaims', () => {
    it('reads the level Supabase puts on the token', () => {
        expect(aalFromClaims({ aal: 'aal2' })).toBe('aal2');
        expect(aalFromClaims({ aal: 'aal1' })).toBe('aal1');
    });

    it('is null when the token carries no claim', () => {
        // A legacy LabTrack-signed token, or an older Supabase project. Null, so the check
        // below has something explicit to refuse rather than an absent value to interpret.
        expect(aalFromClaims({})).toBeNull();
        expect(aalFromClaims(null)).toBeNull();
    });
});

describe('requireMfa', () => {
    const original = process.env.STAFF_MFA_REQUIRED;
    afterEach(() => {
        if (original === undefined) delete process.env.STAFF_MFA_REQUIRED;
        else process.env.STAFF_MFA_REQUIRED = original;
    });

    it('is inert unless the flag is exactly "true"', () => {
        delete process.env.STAFF_MFA_REQUIRED;
        expect(run({ role: 'admin', aal: 'aal1' }).next).toHaveBeenCalled();

        // Not truthy-checked: "false", "0" and "no" must all leave it off, because the
        // failure mode of switching it on by accident is every staff account locked out.
        for (const value of ['false', '0', 'no', '']) {
            process.env.STAFF_MFA_REQUIRED = value;
            expect(run({ role: 'admin', aal: 'aal1' }).next).toHaveBeenCalled();
        }
    });

    describe('when enforced', () => {
        beforeEach(() => { process.env.STAFF_MFA_REQUIRED = 'true'; });

        it('lets a stepped-up staff session through', () => {
            expect(run({ role: 'professional', aal: 'aal2' }).next).toHaveBeenCalled();
            expect(run({ role: 'admin', aal: 'aal2' }).next).toHaveBeenCalled();
        });

        it('refuses a staff session that only proved a password', () => {
            const { res, next } = run({ role: 'admin', aal: 'aal1' });
            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(403);
            // The code is what lets the portal route to enrolment rather than showing a
            // generic refusal the person cannot act on.
            expect(res.json.mock.calls[0][0].code).toBe('mfa_required');
        });

        it('treats a missing claim as not proven', () => {
            // The dangerous reading is the other one: a token with no `aal` satisfying a
            // check about strength of authentication.
            const { res, next } = run({ role: 'admin', aal: null });
            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(403);
        });

        it('leaves patients alone', () => {
            // Mobile has no enrolment flow; requiring a factor there would lock people out
            // of their own results.
            expect(run({ role: 'user', aal: 'aal1' }).next).toHaveBeenCalled();
        });

        it('refuses an unauthenticated request rather than passing it on', () => {
            const res = mockRes();
            const next = jest.fn();
            requireMfa({}, res, next);
            expect(res.status).toHaveBeenCalledWith(401);
            expect(next).not.toHaveBeenCalled();
        });
    });
});
