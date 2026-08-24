/**
 * Authentication and ownership.
 *
 * These cover the failures found in Phase 1: routes that accepted any valid token for any
 * user's data. They exist to stop that regressing.
 */
const jwt = require('jsonwebtoken');
const User = require('../models/userModel');

const { authenticateToken, requireRole } = require('../middleware/authMiddleware');
const { requireSelf, requireSelfQuery } = require('../middleware/ownership');

const mockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
};

const tokenFor = (id, role = 'user') =>
    jwt.sign({ id, role }, process.env.SECRET_KEY, { expiresIn: '1h' });

describe('authenticateToken', () => {
    it('rejects a request with no token', async () => {
        const res = mockRes();
        await authenticateToken({ header: () => undefined }, res, jest.fn());
        expect(res.status).toHaveBeenCalledWith(401);
    });

    it('rejects a token signed with the wrong secret', async () => {
        const bad = jwt.sign({ id: 'x' }, 'not-the-secret');
        const res = mockRes();
        await authenticateToken({ header: () => `Bearer ${bad}` }, res, jest.fn());
        expect(res.status).toHaveBeenCalledWith(403);
    });

    it('rejects an expired token', async () => {
        const expired = jwt.sign({ id: 'x' }, process.env.SECRET_KEY, { expiresIn: '-1h' });
        const res = mockRes();
        await authenticateToken({ header: () => `Bearer ${expired}` }, res, jest.fn());
        expect(res.status).toHaveBeenCalledWith(403);
    });

    it('accepts a valid token and populates req.auth', async () => {
        const user = await User.create({ username: 'a@b.c', email: 'a@b.c', password: 'x' });
        const req = { header: () => `Bearer ${tokenFor(user._id)}` };
        const next = jest.fn();
        await authenticateToken(req, mockRes(), next);
        expect(next).toHaveBeenCalled();
        expect(req.auth.userId).toBe(String(user._id));
    });
});

describe('requireSelf — the Phase 1 ownership hole', () => {
    it("returns 404 for another user's id, not 403", () => {
        // 404 rather than 403 on purpose: a 403 confirms the record exists
        const res = mockRes();
        requireSelf()(
            { auth: { userId: 'aaa', role: 'user' }, params: { id: 'bbb' } },
            res,
            jest.fn(),
        );
        expect(res.status).toHaveBeenCalledWith(404);
    });

    it('allows a user to reach their own record', () => {
        const next = jest.fn();
        requireSelf()({ auth: { userId: 'aaa', role: 'user' }, params: { id: 'aaa' } }, mockRes(), next);
        expect(next).toHaveBeenCalled();
    });

    it('lets an admin through', () => {
        const next = jest.fn();
        requireSelf()({ auth: { userId: 'aaa', role: 'admin' }, params: { id: 'bbb' } }, mockRes(), next);
        expect(next).toHaveBeenCalled();
    });
});

describe('requireSelfQuery', () => {
    it("blocks reading another user's records by query parameter", () => {
        const res = mockRes();
        requireSelfQuery('user_id')(
            { auth: { userId: 'aaa', role: 'user' }, query: { user_id: 'bbb' } },
            res,
            jest.fn(),
        );
        expect(res.status).toHaveBeenCalledWith(403);
    });
});

describe('requireRole', () => {
    it('blocks a patient from a clinician route', () => {
        const res = mockRes();
        requireRole('professional', 'admin')({ auth: { role: 'user' } }, res, jest.fn());
        expect(res.status).toHaveBeenCalledWith(403);
    });

    it('allows a professional', () => {
        const next = jest.fn();
        requireRole('professional', 'admin')({ auth: { role: 'professional' } }, mockRes(), next);
        expect(next).toHaveBeenCalled();
    });
});
