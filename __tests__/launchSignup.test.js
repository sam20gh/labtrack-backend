const express = require('express');
const request = require('supertest');
const LaunchSignup = require('../models/LaunchSignup');
const User = require('../models/userModel');
const routes = require('../routes/launchSignupRoutes');

const app = express();
app.use(express.json());
app.use('/api/launch-signups', routes);
const signup = (body) => request(app).post('/api/launch-signups').send(body);

beforeAll(() => LaunchSignup.init());

test('saves explicit consent separately from patient accounts', async () => {
    const response = await signup({ email: '  Visitor@Example.com ', consent: true });
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(await LaunchSignup.findOne().lean()).toMatchObject({
        email: 'visitor@example.com', consentVersion: 'launch-notification-v1', source: 'homepage',
    });
    expect(await User.countDocuments()).toBe(0);
    expect(response.body).not.toHaveProperty('email');
});

test('duplicates do not disclose membership or change original consent', async () => {
    const first = await signup({ email: 'person@example.com', consent: true });
    const original = await LaunchSignup.findOne().lean();
    const second = await signup({ email: 'PERSON@example.com', consent: true });
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(await LaunchSignup.countDocuments()).toBe(1);
    expect((await LaunchSignup.findOne().lean()).consentAt).toEqual(original.consentAt);
});

test.each([
    { email: 'not-an-email', consent: true },
    { email: { $ne: null }, consent: true },
    { email: 'person@example.com' },
    { email: 'person@example.com', consent: false },
    { email: `${'a'.repeat(250)}@example.com`, consent: true },
])('rejects malformed submissions without writing', async (body) => {
    expect((await signup(body)).status).toBe(400);
    expect(await LaunchSignup.countDocuments()).toBe(0);
});

test('honeypot submissions write nothing', async () => {
    expect((await signup({ email: 'bot@example.com', consent: true, website: 'spam' })).status).toBe(200);
    expect(await LaunchSignup.countDocuments()).toBe(0);
});

test('storage failure never returns a successful signup or exposes email', async () => {
    const spy = jest.spyOn(LaunchSignup, 'updateOne').mockRejectedValueOnce(new Error('database unavailable'));
    const logger = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
        expect((await signup({ email: 'failure@example.com', consent: true })).status).toBe(503);
        expect(logger).toHaveBeenCalledWith('Launch signup could not be saved');
    } finally {
        spy.mockRestore();
        logger.mockRestore();
    }
});

test('throttles repeated attempts', async () => {
    let response;
    for (let attempt = 0; attempt < 21; attempt += 1) {
        response = await signup({ email: 'limited@example.com', consent: true });
    }
    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBeDefined();
});

test('has no public read or export', async () => {
    expect((await request(app).get('/api/launch-signups')).status).toBe(404);
});