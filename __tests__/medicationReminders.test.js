/**
 * The dose reminder sweep — the part of the medication feature that has to *arrive*.
 *
 * Everything else about a schedule is testable by reading a row back. Delivery is not, and
 * this is where it went wrong in production: doses were materialised correctly, the sweep
 * ran on time and found them, and every one was dropped because the account had no
 * registered device. The medication screens promise "LabTrack will remind you", so a
 * schedule that silently notifies nobody is the feature not working.
 *
 * Two properties are asserted here because both were real defects:
 *
 *   - **A dose nobody could be told about is not written off.** Marking `remindedAt` on a
 *     dose that was never announced means enabling notifications at 21:05 still loses the
 *     21:00 reminder — the failure looks identical after the fix as before it.
 *   - **Quiet hours are the person's hours.** `inQuietHours` read the server's clock, which
 *     in production is UTC. For anyone not on UTC that silences the wrong half of the day.
 */
const mongoose = require('mongoose');
const Medication = require('../models/Medication');
const MedicationDose = require('../models/MedicationDose');
const User = require('../models/userModel');

jest.mock('../utils/pushSender', () => {
    const actual = jest.requireActual('../utils/pushSender');
    return {
        ...actual,
        send: jest.fn(async (messages) => ({ sent: messages.length, failed: 0, pruned: 0 })),
    };
});

const pushSender = require('../utils/pushSender');
const { runMedicationReminders } = require('../jobs/medicationReminderJob');

/** A valid-looking Expo token, so `send` is reached rather than filtered as malformed. */
const TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';

const makeUser = (over = {}) => User.create({
    username: `u${new mongoose.Types.ObjectId()}`,
    email: `${new mongoose.Types.ObjectId()}@example.com`,
    supabaseId: String(new mongoose.Types.ObjectId()),
    ...over,
});

const makeMedication = (userId, over = {}) => Medication.create({
    userId,
    name: 'rosuvastatin',
    frequency: 'daily',
    times: ['21:00'],
    startDay: '2026-03-02',
    tzOffset: 0,
    ...over,
});

const makeDose = (medication, scheduledFor, over = {}) => MedicationDose.create({
    userId: medication.userId,
    medicationId: medication._id,
    day: '2026-03-02',
    time: '21:00',
    medicationName: medication.name,
    scheduledFor,
    ...over,
});

beforeEach(() => pushSender.send.mockClear());

describe('a dose that could not be delivered', () => {
    it('is not written off when the account has no registered device', async () => {
        const user = await makeUser();
        const med = await makeMedication(user._id);
        const now = new Date('2026-03-02T21:00:00Z');
        const dose = await makeDose(med, now);

        const result = await runMedicationReminders(now);

        expect(result.undeliverable).toBe(1);
        expect(result.sent).toBe(0);
        expect(pushSender.send).not.toHaveBeenCalled();

        // The row is untouched, so it is still reachable once a device appears
        const after = await MedicationDose.findById(dose._id).lean();
        expect(after.remindedAt).toBeNull();
    });

    it('is delivered on the next sweep once a device registers', async () => {
        const user = await makeUser();
        const med = await makeMedication(user._id);
        const dueAt = new Date('2026-03-02T21:00:00Z');
        const dose = await makeDose(med, dueAt);

        await runMedicationReminders(dueAt);

        // The person grants permission five minutes later — the case that was silently lost
        await User.updateOne(
            { _id: user._id },
            { $push: { pushTokens: { token: TOKEN, platform: 'ios' } } }
        );

        const result = await runMedicationReminders(new Date('2026-03-02T21:05:00Z'));

        expect(result.sent).toBe(1);
        expect(pushSender.send).toHaveBeenCalledTimes(1);
        expect(pushSender.send.mock.calls[0][0][0].to).toBe(TOKEN);

        const after = await MedicationDose.findById(dose._id).lean();
        expect(after.remindedAt).not.toBeNull();
    });

    it('is announced only once, however many sweeps run', async () => {
        const user = await makeUser({ pushTokens: [{ token: TOKEN, platform: 'ios' }] });
        const med = await makeMedication(user._id);
        const dueAt = new Date('2026-03-02T21:00:00Z');
        await makeDose(med, dueAt);

        await runMedicationReminders(dueAt);
        const second = await runMedicationReminders(new Date('2026-03-02T21:05:00Z'));

        expect(pushSender.send).toHaveBeenCalledTimes(1);
        expect(second.considered).toBe(0);
    });
});

describe('quiet hours', () => {
    // UTC+4. `tzOffset` follows the client's getTimezoneOffset(): minutes west of UTC.
    const DUBAI = -240;
    const quiet = { quietHours: { start: 22, end: 8 } };

    it('suppresses a late reminder by the person\'s clock, not the server\'s', async () => {
        const user = await makeUser({
            pushTokens: [{ token: TOKEN, platform: 'ios' }],
            notificationPreferences: quiet,
        });
        const med = await makeMedication(user._id, { tzOffset: DUBAI });
        // Due at 22:30 local, considered 40 minutes late at 23:10 local (19:10 UTC)
        await makeDose(med, new Date('2026-03-02T18:30:00Z'));

        const result = await runMedicationReminders(new Date('2026-03-02T19:10:00Z'));

        expect(result.sent).toBe(0);
        expect(result.suppressed).toBe(1);
    });

    it('lets a late reminder through in the person\'s morning, though it is night in UTC', async () => {
        const user = await makeUser({
            pushTokens: [{ token: TOKEN, platform: 'ios' }],
            notificationPreferences: quiet,
        });
        const med = await makeMedication(user._id, { tzOffset: DUBAI });
        // Due at 08:30 local (04:30 UTC), considered 40 minutes late at 09:10 local.
        // 05:10 UTC sits inside a 22→8 window read on a UTC server, and must not matter.
        await makeDose(med, new Date('2026-03-02T04:30:00Z'));

        const result = await runMedicationReminders(new Date('2026-03-02T05:10:00Z'));

        expect(result.sent).toBe(1);
    });

    it('never suppresses a punctual dose, even one the person put inside their quiet hours', async () => {
        const user = await makeUser({
            pushTokens: [{ token: TOKEN, platform: 'ios' }],
            notificationPreferences: quiet,
        });
        const med = await makeMedication(user._id, { tzOffset: DUBAI, times: ['23:00'] });
        await makeDose(med, new Date('2026-03-02T19:00:00Z'), { time: '23:00' });

        const result = await runMedicationReminders(new Date('2026-03-02T19:02:00Z'));

        expect(result.sent).toBe(1);
    });
});
