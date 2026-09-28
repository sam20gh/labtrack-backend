/**
 * The bracelet ingest path.
 *
 * The J-Style 2208A and V8 are the first sources to report families no phone health store
 * does — blood oxygen, body temperature, a cuffless blood pressure and an ECG waveform —
 * and the first whose storage is destroyed once a sync is acknowledged. What follows is the
 * set of properties that make that safe.
 *
 * What has to hold:
 *   - A bracelet batch reaches `MetricLog` and `EcgRecording` and rebuilds the day's rollup.
 *     Rows that land but never roll up are invisible to every screen, and nothing errors.
 *   - A phone-store batch is completely unaffected by any of this.
 *   - Implausible sensor output is **dropped, never rejected** — one bad optical read must
 *     not cost a batch the other rows in it.
 *   - A cuffless blood pressure is staged like any other reading, and carries `method` so
 *     the record still says where it came from.
 *   - Temperature keeps its site. A wrist reading averaged with an axillary one describes
 *     neither.
 *   - A re-sync upserts rather than duplicating, because the bracelet replays its ring
 *     buffer until the rows are acknowledged.
 */
const mongoose = require('mongoose');
const MetricLog = require('../models/MetricLog');
const EcgRecording = require('../models/EcgRecording');
const DailyMetrics = require('../models/DailyMetrics');
const User = require('../models/userModel');
const { ingestBatch } = require('../utils/healthSync');

const DAY = '2026-09-10';
const at = (hhmm) => new Date(`${DAY}T${hhmm}:00.000Z`).toISOString();

let userId;

beforeEach(async () => {
    userId = new mongoose.Types.ObjectId();
    await User.create({
        _id: userId,
        username: `u${userId}`,
        email: `${userId}@example.com`,
        password: 'x',
    });
});

const bracelet = (extra) => ingestBatch({
    userId,
    platform: 'jstyle_bracelet',
    tzOffset: 0,
    ...extra,
});

describe('a bracelet batch lands and rolls up', () => {
    it('writes spo2, temperature, blood pressure and an ECG, and rebuilds the day', async () => {
        const result = await bracelet({
            spo2: [
                { externalId: 'a1', measuredAt: at('01:00'), spo2: 97, context: 'automatic' },
                { externalId: 'a2', measuredAt: at('02:00'), spo2: 89, context: 'automatic' },
            ],
            temperature: [
                { externalId: 't1', measuredAt: at('07:00'), celsius: 33.4, site: 'wrist' },
                { externalId: 't2', measuredAt: at('07:05'), celsius: 36.8, site: 'axillary' },
            ],
            bloodPressure: [{
                externalId: 'b1', measuredAt: at('08:00'),
                systolic: 152, diastolic: 96, pulse: 71, method: 'optical_estimate',
            }],
            ecg: [{
                externalId: 'e1', measuredAt: at('09:00'), kind: 'ecg',
                samples: [1, 2, 3, 4], sampleRateHz: 125,
                result: { hrBpm: 68, quality: 82 },
            }],
        });

        expect(result.counts).toMatchObject({
            spo2: 2, temperature: 2, bloodPressure: 1, ecg: 1,
        });
        expect(result.days).toContain(DAY);

        const rollup = await DailyMetrics.findOne({ userId, day: DAY }).lean();

        // The whole point of wiring `recomputeMetricDay` into `ingestBatch`: without it the
        // rows exist and every screen that reads the rollup shows nothing.
        expect(rollup.spo2.readings).toBe(2);
        expect(rollup.spo2.avg).toBe(93);
        // The minimum is the reading that matters. An average of 93 hides the 89 entirely.
        expect(rollup.spo2.min).toBe(89);

        expect(rollup.bloodPressure.readings).toBe(1);
        expect(rollup.bloodPressure.category).toBe('stage_2');

        const ecg = await EcgRecording.findOne({ userId }).lean();
        expect(ecg.kind).toBe('ecg');
        expect(ecg.samples).toEqual([1, 2, 3, 4]);
        // Carried, never recomputed. There is no ECG engine here.
        expect(ecg.result.hrBpm).toBe(68);
    });

    it('keeps wrist and axillary temperatures apart', async () => {
        await bracelet({
            temperature: [
                { externalId: 't1', measuredAt: at('07:00'), celsius: 33.0, site: 'wrist' },
                { externalId: 't2', measuredAt: at('08:00'), celsius: 33.4, site: 'wrist' },
                { externalId: 't3', measuredAt: at('09:00'), celsius: 36.9, site: 'axillary' },
            ],
        });

        const rollup = await DailyMetrics.findOne({ userId, day: DAY }).lean();

        // Averaged together these would be 34.4 — a figure describing neither site, and one
        // that reads as hypothermia for an axillary measurement.
        expect(rollup.temperature.wristAvg).toBe(33.2);
        expect(rollup.temperature.axillaryAvg).toBe(36.9);
        expect(rollup.temperature.readings).toBe(3);
    });

    it('leaves the other site null rather than implying a reading', async () => {
        await bracelet({
            temperature: [
                { externalId: 't1', measuredAt: at('07:00'), celsius: 33.0, site: 'wrist' },
            ],
        });

        const rollup = await DailyMetrics.findOne({ userId, day: DAY }).lean();
        expect(rollup.temperature.wristAvg).toBe(33);
        // Null, never zero — the distinction this codebase draws everywhere.
        expect(rollup.temperature.axillaryAvg).toBeNull();
    });
});

describe('a cuffless blood pressure keeps its provenance', () => {
    it('stages it like any other reading and records how it was taken', async () => {
        await bracelet({
            bloodPressure: [{
                externalId: 'b1', measuredAt: at('08:00'),
                systolic: 152, diastolic: 96, method: 'optical_estimate',
            }],
        });

        const row = await MetricLog.findOne({ userId, kind: 'blood_pressure' }).lean();

        // The product decision: an optical estimate is classified like a cuff reading.
        expect(row.category).toBe('stage_2');
        // And this is what keeps that decision reversible. Without it nothing in the record
        // distinguishes this from a cuff reading, and no later screen or clinician could.
        expect(row.method).toBe('optical_estimate');
        expect(row.source).toBe('bracelet');
    });

    it('still files a hand-logged reading as a cuff reading', async () => {
        await bracelet({
            bloodPressure: [{
                externalId: 'b2', measuredAt: at('08:00'), systolic: 118, diastolic: 76,
            }],
        });

        const row = await MetricLog.findOne({ userId, kind: 'blood_pressure' }).lean();
        expect(row.method).toBe('cuff');
    });
});

describe('bad sensor output is dropped, never fatal', () => {
    it('drops implausible readings and keeps everything else in the batch', async () => {
        await bracelet({
            spo2: [
                { externalId: 'ok', measuredAt: at('01:00'), spo2: 96, context: 'automatic' },
                // The vendor's failed-sample value. Storing it would put a reading nobody
                // should act on into a health record.
                { externalId: 'zero', measuredAt: at('02:00'), spo2: 0, context: 'automatic' },
                { externalId: 'high', measuredAt: at('03:00'), spo2: 140, context: 'manual' },
            ],
            temperature: [
                { externalId: 'ok2', measuredAt: at('07:00'), celsius: 33.1, site: 'wrist' },
                { externalId: 'cold', measuredAt: at('07:30'), celsius: 0, site: 'wrist' },
                // No site: a temperature nobody can interpret.
                { externalId: 'nosite', measuredAt: at('07:45'), celsius: 36.5 },
            ],
            bloodPressure: [
                { externalId: 'bpok', measuredAt: at('08:00'), systolic: 120, diastolic: 78 },
                // Transposed, which the metrics API answers 400 for. Here it is dropped,
                // because rejecting the batch would cost the four good rows beside it.
                { externalId: 'flip', measuredAt: at('08:30'), systolic: 80, diastolic: 120 },
            ],
            ecg: [
                // Neither a trace nor a result: a failed attempt, not a measurement.
                { externalId: 'empty', measuredAt: at('09:00'), kind: 'ecg', samples: [], result: {} },
            ],
        });

        expect(await MetricLog.countDocuments({ userId, kind: 'spo2' })).toBe(1);
        expect(await MetricLog.countDocuments({ userId, kind: 'temperature' })).toBe(1);
        expect(await MetricLog.countDocuments({ userId, kind: 'blood_pressure' })).toBe(1);
        expect(await EcgRecording.countDocuments({ userId })).toBe(0);
    });
});

describe('re-syncing the same history does not duplicate it', () => {
    it('upserts on externalId, because the bracelet replays until acknowledged', async () => {
        const batch = {
            spo2: [{ externalId: 'a1', measuredAt: at('01:00'), spo2: 97, context: 'automatic' }],
            ecg: [{
                externalId: 'e1', measuredAt: at('09:00'), kind: 'ecg',
                samples: [1, 2, 3], result: { hrBpm: 70 },
            }],
        };

        await bracelet(batch);
        await bracelet(batch);

        expect(await MetricLog.countDocuments({ userId, kind: 'spo2' })).toBe(1);
        expect(await EcgRecording.countDocuments({ userId })).toBe(1);
    });
});

describe('the phone health stores are untouched', () => {
    it('accepts a batch carrying none of the bracelet families', async () => {
        const result = await ingestBatch({
            userId,
            platform: 'health_connect',
            tzOffset: 0,
            days: [{ day: DAY, steps: 8000 }],
        });

        // Absent, not empty. A store that does not measure these is not a store that
        // measured nothing — and the ingest must not invent rollups for them.
        expect(result.counts.spo2).toBe(0);
        expect(result.days).toContain(DAY);

        const rollup = await DailyMetrics.findOne({ userId, day: DAY }).lean();
        expect(rollup.activity.steps).toBe(8000);
        expect(rollup.spo2.readings).toBe(0);
    });
});

/**
 * Heart rate arrives twice from a bracelet: the continuous stream as the day's spread, and a
 * few timed spot readings as resting samples. The spread is the fuller account of the day
 * and the rebuild must not replace it with the spot readings; the spot readings are the only
 * resting figure and must still set it.
 */
describe('the continuous heart stream survives the day rebuild', () => {
    const batch = {
        days: [{ day: DAY, minBpm: 48, maxBpm: 142, avgBpm: 76 }],
        heart: [
            { externalId: 'h1', measuredAt: at('03:00'), bpm: 58, context: 'resting' },
            { externalId: 'h2', measuredAt: at('15:00'), bpm: 64, context: 'resting' },
        ],
    };

    it('keeps the device spread and still takes resting from the spot readings', async () => {
        await bracelet(batch);

        const { heart } = await DailyMetrics.findOne({ userId, day: DAY }).lean();
        expect(heart).toMatchObject({
            minBpm: 48, maxBpm: 142, avgBpm: 76, restingBpm: 61, spreadSource: 'device',
        });
    });

    it('holds on a re-sync, which reruns the rebuild', async () => {
        await bracelet(batch);
        await bracelet({ heart: batch.heart });

        const { heart } = await DailyMetrics.findOne({ userId, day: DAY }).lean();
        expect(heart.avgBpm).toBe(76);
    });

    it('still derives the spread from samples when no device reported one', async () => {
        await bracelet({ heart: batch.heart });

        const { heart } = await DailyMetrics.findOne({ userId, day: DAY }).lean();
        expect(heart).toMatchObject({ minBpm: 58, maxBpm: 64, avgBpm: 61, spreadSource: 'samples' });
    });
});

/** The overview's own `newest`/`series`, over a fixed set of day rows. */
const overWith = (card) => (rows) => {
        const range = rows.map((r) => r.day);
        const byDay = new Map(rows.map((r) => [r.day, r]));
        const newest = (pick) => {
            for (let i = range.length - 1; i >= 0; i--) {
                const v = pick(byDay.get(range[i]));
                if (v !== null && v !== undefined) return { value: v, day: range[i] };
            }
            return { value: null, day: null };
        };
        const series = (pick) => range.map((day) => ({ day, value: pick(byDay.get(day)) ?? null }));
        return card(newest, series);
};

describe('the Health Metrics heart card', () => {
    const over = overWith(require('../controllers/metricsController')._heartRateCard);

    it('shows today\'s average rather than a resting reading from two days ago', () => {
        const result = over([
            { day: '2026-09-08', heart: { restingBpm: 62 } },
            { day: '2026-09-09', heart: {} },
            { day: '2026-09-10', heart: { avgBpm: 81 } },
        ]);

        expect(result).toMatchObject({ value: 81, at: '2026-09-10', measure: 'average' });
        // Never judged against the resting range: an all-day average is meant to be higher.
        expect(result.status).toBe('Average across the day');
        expect(result.series.map((p) => p.value)).toEqual([null, null, 81]);
    });

    it('prefers resting when it is as fresh as the average', () => {
        const result = over([{ day: '2026-09-10', heart: { restingBpm: 62, avgBpm: 81 } }]);
        expect(result).toMatchObject({ value: 62, measure: 'resting', status: 'Normal resting range' });
    });

    it('says to connect a device when there is nothing', () => {
        const result = over([{ day: '2026-09-10', heart: {} }]);
        expect(result).toMatchObject({ value: null, measure: null, status: 'Connect a device' });
    });
});

describe('the Health Metrics blood-oxygen card', () => {
    const over = overWith(require('../controllers/metricsController')._spo2Card);

    it('shows the newest day with readings, and leads with its lowest', () => {
        const result = over([
            { day: '2026-09-09', spo2: { avg: 97, min: 96, max: 99, readings: 5 } },
            { day: '2026-09-10', spo2: { avg: 96.4, min: 91, max: 99, readings: 3 } },
        ]);
        expect(result).toMatchObject({ key: 'spo2', value: 96, at: '2026-09-10', unit: '%' });
        // The average hides the dip; the status must not.
        expect(result.status).toBe('Lowest 91% of 3 readings · typical is 95–100%');
    });

    it('says typical when even the lowest reading is', () => {
        const result = over([{ day: '2026-09-10', spo2: { avg: 97.2, min: 95, max: 99, readings: 4 } }]);
        expect(result.status).toBe('Typical range · lowest 95%');
    });

    it('treats a day with no readings as absent, not as 0%', () => {
        const result = over([{ day: '2026-09-10', spo2: { avg: null, min: null, max: null, readings: 0 } }]);
        expect(result).toMatchObject({ value: null, status: 'Connect a bracelet' });
        expect(result.series.map((p) => p.value)).toEqual([null]);
    });
});

describe('the Health Metrics temperature card', () => {
    const { _temperatureCard: card } = require('../controllers/metricsController');
    const over = (rows) => {
        const range = rows.map((r) => r.day);
        const byDay = new Map(rows.map((r) => [r.day, r]));
        return overWith((newest, series) => card(newest, series, byDay, range))(rows);
    };

    it('calls a wrist reading skin temperature and passes no verdict on it', () => {
        const result = over([
            { day: '2026-09-09', temperature: { wristAvg: 33.12, wristMax: 34.0, readings: 4 } },
            { day: '2026-09-10', temperature: { wristAvg: 33.46, wristMax: 34.2, readings: 6 } },
        ]);
        expect(result).toMatchObject({
            key: 'temperature', label: 'Skin Temperature', site: 'wrist', value: 33.5, unit: '°C',
            status: 'At the wrist · runs below body temperature',
        });
        expect(result.series.map((p) => p.value)).toEqual([33.1, 33.5]);
    });

    it('uses underarm readings whenever the window has any, and never mixes the sites', () => {
        const result = over([
            { day: '2026-09-09', temperature: { wristAvg: 33.1, axillaryAvg: 36.7, axillaryMax: 36.9, readings: 3 } },
            { day: '2026-09-10', temperature: { wristAvg: 33.4, readings: 2 } },
        ]);
        // The newest day has only a wrist reading; the card still describes one site.
        expect(result).toMatchObject({
            label: 'Body Temperature', site: 'axillary', value: 36.7, at: '2026-09-09',
            status: 'Under the arm · highest 36.9 °C',
        });
        expect(result.series.map((p) => p.value)).toEqual([36.7, null]);
    });

    it('says to connect a bracelet when nothing was measured', () => {
        const result = over([{ day: '2026-09-10', temperature: { readings: 0 } }]);
        expect(result).toMatchObject({ value: null, status: 'Connect a bracelet' });
    });
});
