/**
 * Regeneration rate limiting.
 *
 * The gate is "has anything changed", not "how many requests" — an interpretation is a
 * function of the person's data, so regenerating over identical inputs spends a model call
 * to produce the same answer and asks a clinician to review it twice. These lock that in,
 * including the deliberate escape hatch after the cooldown.
 */
const mongoose = require('mongoose');
const Interpretation = require('../models/Interpretation');
const Biomarker = require('../models/Biomarker');
const TestResult = require('../models/testResultModel');
const User = require('../models/userModel');
const { assessRegeneration, DAILY_LIMIT, UNCHANGED_COOLDOWN_HOURS } = require('../utils/regenerationGuard');

const HOUR = 60 * 60 * 1000;
const userId = new mongoose.Types.ObjectId();
const ago = (ms) => new Date(Date.now() - ms);

const interpretation = (generatedAt) => Interpretation.create({
    userId, generatedAt, content: { summary: 'x' }, covers: [],
});

describe('assessRegeneration', () => {
    it('allows the first ever generation', async () => {
        const v = await assessRegeneration({ userId });
        expect(v.allowed).toBe(true);
        expect(v.reason).toBe('first');
    });

    it('refuses when nothing has changed since the last analysis', async () => {
        await interpretation(ago(2 * HOUR));

        const v = await assessRegeneration({ userId });
        expect(v.allowed).toBe(false);
        expect(v.reason).toBe('no_new_data');
        // The client keeps showing what the person already has.
        expect(v.existing).toBeTruthy();
        expect(v.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('allows immediately once a new biomarker arrives', async () => {
        await interpretation(ago(2 * HOUR));
        await Biomarker.create({
            userId, name: 'ferritin', value: 253, unit: 'ng/mL',
            measuredAt: new Date(), flag: 'normal',
        });

        const v = await assessRegeneration({ userId });
        expect(v.allowed).toBe(true);
        expect(v.reason).toBe('new_data');
    });

    it('counts an uploaded old report as new data', async () => {
        await interpretation(ago(2 * HOUR));
        // Clinical date two years ago, but it arrived just now — that is new information.
        await TestResult.create({
            patient: {
                user_id: userId, date_of_test: new Date('2024-01-01'),
                lab_name: 'Lab', test_type: 'Lipid Panel',
            },
            results: {},
        });

        const v = await assessRegeneration({ userId });
        expect(v.allowed).toBe(true);
        expect(v.reason).toBe('new_data');
    });

    it('treats a completed health assessment as new input', async () => {
        await interpretation(ago(2 * HOUR));
        await User.create({
            _id: userId, username: 'guard-test', email: 'a@b.co', password: 'x',
            healthAssessment: { isComplete: true, completedAt: new Date() },
        });

        const v = await assessRegeneration({ userId });
        expect(v.allowed).toBe(true);
        expect(v.reason).toBe('new_data');
    });

    it('allows a deliberate re-read once the cooldown has passed', async () => {
        await interpretation(ago((UNCHANGED_COOLDOWN_HOURS + 1) * HOUR));

        const v = await assessRegeneration({ userId });
        expect(v.allowed).toBe(true);
        expect(v.reason).toBe('cooldown_elapsed');
    });

    it('stops at the daily limit even when data keeps changing', async () => {
        for (let i = 0; i < DAILY_LIMIT; i++) {
            await interpretation(ago((i + 1) * 60 * 1000));
        }
        await Biomarker.create({
            userId, name: 'hba1c', value: 5.69, unit: '%', measuredAt: new Date(), flag: 'normal',
        });

        const v = await assessRegeneration({ userId });
        expect(v.allowed).toBe(false);
        expect(v.reason).toBe('daily_limit');
        expect(v.dailyCount).toBe(DAILY_LIMIT);
        expect(v.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('ignores generations older than the rolling window', async () => {
        for (let i = 0; i < DAILY_LIMIT; i++) {
            await interpretation(ago(25 * HOUR + i * 60 * 1000));
        }

        const v = await assessRegeneration({ userId });
        expect(v.dailyCount).toBe(0);
        // Old enough that the cooldown has also elapsed.
        expect(v.allowed).toBe(true);
    });

    it('does not count another user\'s generations', async () => {
        const other = new mongoose.Types.ObjectId();
        for (let i = 0; i < DAILY_LIMIT; i++) {
            await Interpretation.create({
                userId: other, generatedAt: ago((i + 1) * 60 * 1000), content: {}, covers: [],
            });
        }

        const v = await assessRegeneration({ userId });
        expect(v.dailyCount).toBe(0);
        expect(v.allowed).toBe(true);
    });
});
