/**
 * One temperature per night: the median wrist reading taken while somebody was asleep.
 *
 * The cycle tracker's temperature signal needs this and nothing coarser. Skin temperature at
 * the wrist moves with the room, a walk in the cold, a hot shower and a meal; during sleep it
 * settles, and that settled figure is where the small rise after ovulation — about 0.2–0.5 °C —
 * can show. `DailyMetrics.temperature.wristAvg` averages the whole day together and cannot.
 *
 * Three rules:
 *
 * 1. **The night is the sleep session, not a clock window.** A fixed 23:00–07:00 is wrong for
 *    a shift worker every night and for everyone at the weekend. The main `SleepSession` filed
 *    under a day — the longest, as `healthSync.recomputeDay` chooses — is what "last night"
 *    means everywhere else in this app.
 * 2. **The median, not the mean.** A band that slipped for twenty minutes reads the air, and
 *    one reading several degrees low drags a mean in a way it cannot drag a median.
 * 3. **Too few readings is null, not a number.** Below `MIN_READINGS` the figure is left
 *    empty rather than computed from two samples. The same line `alignment: 'unassessed'`
 *    holds: a night nobody measured is not a cool night.
 *
 * Only wrist readings. An axillary reading is a different measurement of a different thing,
 * and mixing the two is the error `TemperatureTotalsSchema` exists to prevent.
 */
const SleepSession = require('../models/SleepSession');
const MetricLog = require('../models/MetricLog');
const DailyMetrics = require('../models/DailyMetrics');
const { median, addDays } = require('./cycleEngine');

/** At 30-minute sampling a six-hour night gives twelve; four is a night with real gaps. */
const MIN_READINGS = 4;

/** Pure: the median of the readings inside the night, or null. Exported for the tests. */
const nightMedian = (readings = [], night) => {
    if (!night?.startedAt || !night?.endedAt) return { median: null, readings: 0 };
    const from = new Date(night.startedAt).getTime();
    const to = new Date(night.endedAt).getTime();
    const inside = readings
        .filter((r) => {
            const at = new Date(r.measuredAt).getTime();
            return at >= from && at <= to && Number.isFinite(r.celsius);
        })
        .map((r) => r.celsius);
    if (inside.length < MIN_READINGS) return { median: null, readings: inside.length };
    return { median: Math.round(median(inside) * 100) / 100, readings: inside.length };
};

/** Recompute one wake day's night figure. Safe to call repeatedly. */
const recomputeNight = async (userId, day) => {
    const nights = await SleepSession.find({ userId, day }).select('startedAt endedAt asleepMin').lean();
    const main = nights.slice().sort((a, b) => (b.asleepMin || 0) - (a.asleepMin || 0))[0] || null;

    let result = { median: null, readings: 0 };
    if (main) {
        const readings = await MetricLog.find({
            userId,
            kind: 'temperature',
            site: 'wrist',
            measuredAt: { $gte: main.startedAt, $lte: main.endedAt },
        }).select('measuredAt celsius').lean();
        result = nightMedian(readings, main);
    }

    await DailyMetrics.updateOne(
        { userId, day },
        {
            $set: {
                'temperature.wristSleepMedian': result.median,
                'temperature.wristSleepReadings': result.readings,
            },
            $setOnInsert: { userId, day },
        },
        { upsert: true },
    );
    return result;
};

/**
 * The wake days a sync could have changed.
 *
 * A reading taken at 23:30 is filed under the day it was taken, but belongs to the night filed
 * under the *next* day — so each temperature day brings its successor with it.
 */
const affectedDays = ({ tempDays = [], sleepDays = [] }) => {
    const out = new Set(sleepDays);
    for (const d of tempDays) {
        out.add(d);
        out.add(addDays(d, 1));
    }
    return [...out].sort();
};

/** `{ day, celsius }` for every night in a range that has a figure — the tracker's input. */
const nightsBetween = async (userId, from, to) => {
    const rows = await DailyMetrics.find({
        userId,
        day: { $gte: from, $lte: to },
        'temperature.wristSleepMedian': { $ne: null },
    }).select('day temperature.wristSleepMedian').sort({ day: 1 }).lean();
    return rows.map((r) => ({ day: r.day, celsius: r.temperature.wristSleepMedian }));
};

module.exports = { MIN_READINGS, nightMedian, recomputeNight, affectedDays, nightsBetween };
