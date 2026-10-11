/**
 * Effort minutes — the third ring of the home screen's daily readout.
 *
 * Pure arithmetic, no model call, no database. `healthSync.recomputeDay` calls `effortForDay`
 * and stores the result on `DailyMetrics.activity` and `DailyMetrics.heart.zoneMinutes`.
 *
 * **The unit is the guideline's own.** The WHO asks adults for 150 minutes of moderate or 75
 * of vigorous activity a week, so a moderate minute counts 1 and a vigorous minute counts 2.
 * That is linear on purpose: "18 of 30 min" can be read and acted on by somebody who has never
 * seen the app before. A logarithmic 0–21 strain number cannot, and it is another product's
 * signature.
 *
 * **Intensity comes from the heart, then from the workout, never from steps.** In order:
 *   1. the bracelet's continuous stream (`HeartStream` blocks), each block's mean against an
 *      estimated maximum heart rate;
 *   2. a workout the stream did not cover, by its average heart rate;
 *   3. a workout with no heart rate, by the effort the person gave it, then by its type.
 * Steps are a count of something else; a day of pottering is many steps and no effort.
 *
 * **Null, never zero.** A day with no stream and no workout has no effort figure, because
 * nothing measured it. A day the band was worn and nothing rose into the moderate band is a
 * measured zero.
 */

/** ACSM intensity bands, as a share of maximum heart rate. */
const MODERATE_PCT = 0.64;
const VIGOROUS_PCT = 0.77;

/**
 * Lower edges of the five zones, as a share of maximum heart rate. Zone 1 is 50–60%.
 * `zoneMinutes[3] + zoneMinutes[4]` is what `ageProfile.js` reads as vigorous.
 */
const ZONE_EDGES = [0.5, 0.6, 0.7, 0.8, 0.9];

/** Readings in one vendor record — see `models/HeartStream.js`. */
const READINGS_PER_RECORD = 15;

/**
 * Minutes one record spans when the spacing cannot be measured (a day with a single record).
 * The spacing is otherwise read from the data: the vendor does not document the interval,
 * and guessing it wrong would multiply every figure on the ring.
 */
const DEFAULT_RECORD_MIN = 15;
const MAX_RECORD_MIN = 60;

/** Workout types counted by type alone, when nothing measured them. Others count moderate. */
const VIGOROUS_TYPES = new Set(['jogging', 'running', 'rowing', 'soccer', 'hiit', 'skipping', 'squash']);
const UNCOUNTED_TYPES = new Set(['yoga', 'meditation', 'stretching', 'pilates', 'other']);

/** Tanaka (208 − 0.7 × age). Null without an age: zones from a guessed age are a fiction. */
const maxHrFromAge = (age) => {
    if (!Number.isFinite(age) || age < 10 || age > 120) return null;
    return Math.round(208 - 0.7 * age);
};

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

const median = (values) => {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Which intensity a share of maximum heart rate falls in. */
const intensityOf = (fraction) => {
    if (!finite(fraction)) return null;
    if (fraction >= VIGOROUS_PCT) return 'vigorous';
    if (fraction >= MODERATE_PCT) return 'moderate';
    return 'light';
};

/** Zone index 0–4, or -1 below zone 1. */
const zoneOf = (fraction) => {
    let zone = -1;
    ZONE_EDGES.forEach((edge, i) => { if (fraction >= edge) zone = i; });
    return zone;
};

/**
 * How many minutes a record spans, read from the gaps between record start times.
 *
 * The median gap, ignoring gaps longer than an hour (the band off the wrist). A median is
 * used because the band starts a fresh record after every gap, so the odd short one is normal.
 */
const recordMinutes = (startsMs) => {
    const sorted = startsMs.slice().sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
        const gap = (sorted[i] - sorted[i - 1]) / 60000;
        if (gap > 0 && gap <= MAX_RECORD_MIN) gaps.push(gap);
    }
    const m = median(gaps);
    return m ? Math.min(MAX_RECORD_MIN, Math.max(1, m)) : DEFAULT_RECORD_MIN;
};

const validTuple = (t) => Array.isArray(t) && t.length === 4 && t.every(finite) && t[0] > 0;

/**
 * The day's stream as classified records: when each starts and ends, the minutes it stands for,
 * and its mean as a share of maximum heart rate.
 *
 * Each record is classified by its mean. A record holds fifteen readings, and each non-zero
 * reading stands for `recordMinutes / 15` minutes, so a record with half its readings missing
 * (the band slipping) counts half its span.
 */
const streamRecords = (blocks, maxHr) => {
    const entries = Object.entries(blocks || {})
        .map(([key, tuple]) => [Number(key), tuple])
        .filter(([start, tuple]) => finite(start) && validTuple(tuple));
    if (!entries.length || !maxHr) return null;

    const span = recordMinutes(entries.map(([start]) => start));
    const perReading = span / READINGS_PER_RECORD;
    return entries.map(([start, [n, sum]]) => ({
        start,
        end: start + span * 60000,
        minutes: Math.min(n, READINGS_PER_RECORD) * perReading,
        fraction: (sum / n) / maxHr,
    }));
};

/** Moderate and vigorous minutes in a set of records. */
const tally = (records) => {
    let moderate = 0;
    let vigorous = 0;
    for (const r of records) {
        const intensity = intensityOf(r.fraction);
        if (intensity === 'moderate') moderate += r.minutes;
        if (intensity === 'vigorous') vigorous += r.minutes;
    }
    return { moderate, vigorous };
};

/** Minutes per zone, from every record: the zones describe the heart, not the workouts. */
const zonesOf = (records) => {
    const zones = [0, 0, 0, 0, 0];
    for (const r of records) {
        const zone = zoneOf(r.fraction);
        if (zone >= 0) zones[zone] += r.minutes;
    }
    return zones.map((z) => Math.round(z));
};

/** Kept for callers and tests that want the whole stream read on its own. */
const fromStream = (blocks, maxHr) => {
    const records = streamRecords(blocks, maxHr);
    if (!records) return null;
    const { moderate, vigorous } = tally(records);
    return { zoneMinutes: zonesOf(records), moderateMin: moderate, vigorousMin: vigorous };
};

/**
 * Water: a wrist optical sensor reads badly underwater, so the band's heart rate is never the
 * evidence for these. Matched loosely because unmapped store types arrive as words.
 */
const WATER = /swim|surf|water|div(e|ing)|paddl|snorkel|kayak|canoe/;

/**
 * The app's own effort scale (`app/activity/log.tsx`): 1 Very light, 2 Light, 3 Moderate,
 * 4 High effort, 5 Maximum. Light is good for you and is not what the guideline counts.
 */
const intensityFromRating = (rating) => (rating >= 4 ? 'vigorous' : rating >= 3 ? 'moderate' : 'light');

/**
 * One workout's effort, and what decided it. Strongest evidence first:
 *
 *   heart_rate  the workout's own average heart rate (a watch recorded the session)
 *   rating      the effort the person gave it — what they say about their own session
 *   band        the bracelet's stream inside the workout's window (never for water)
 *   type        the kind of workout, when nothing measured or rated it
 *
 * The person's rating outranks the band because a wrist sensor can be wrong (cold hands, a
 * loose strap, water), and somebody who has said how hard it was should not be overruled by it.
 */
const judgeSession = (session, maxHr, inside) => {
    const minutes = (session.durationSec || 0) / 60;
    const type = String(session.type || '').toLowerCase();
    let intensity;
    let basis;
    let moderate = 0;
    let vigorous = 0;

    if (finite(session.avgBpm) && session.avgBpm > 0 && maxHr) {
        intensity = intensityOf(session.avgBpm / maxHr);
        basis = 'heart_rate';
    } else if (finite(session.effort)) {
        intensity = intensityFromRating(session.effort);
        basis = 'rating';
    } else if (inside.length && !WATER.test(type)) {
        // Minute by minute, from the band: a session can be part warm-up, part hard.
        ({ moderate, vigorous } = tally(inside));
        basis = 'band';
        intensity = vigorous > 0 ? 'vigorous' : moderate > 0 ? 'moderate' : 'light';
    } else {
        intensity = UNCOUNTED_TYPES.has(type) ? 'light' : VIGOROUS_TYPES.has(type) ? 'vigorous' : 'moderate';
        basis = 'type';
    }

    if (basis !== 'band') {
        if (intensity === 'moderate') moderate = minutes;
        if (intensity === 'vigorous') vigorous = minutes;
    }

    return {
        id: session._id ? String(session._id) : null,
        type: session.type || 'other',
        durationMin: Math.round(minutes),
        intensity,
        basis,
        moderate,
        vigorous,
        effortMin: Math.round(moderate + 2 * vigorous),
    };
};

/**
 * One day's effort.
 *
 * Workouts are judged one by one (`judgeSession`); the band's records inside a workout's window
 * belong to that workout and are never counted again outside it. What the band recorded outside
 * every workout is the day's other effort — a brisk walk to the station nobody logged.
 *
 * @param {object} args
 * @param {object} [args.blocks]   `HeartStream.blocks` for the day
 * @param {Array}  [args.sessions] the day's `ActivitySession` rows
 * @param {number|null} args.maxHr estimated maximum heart rate, or null without a birth date
 * @returns {{ effortMin, moderateMin, vigorousMin, zoneMinutes, source, note, breakdown }}
 */
const effortForDay = ({ blocks = null, sessions = [], maxHr = null }) => {
    const hasStream = Boolean(blocks && Object.keys(blocks).length);
    const records = streamRecords(blocks, maxHr);

    // A stream with no birth date to read it against: workouts still count by rating and type,
    // and the note tells the screen why the band's own minutes do not.
    const note = hasStream && !maxHr ? 'needs_age' : null;

    const claimed = new Set();
    const judged = [];
    for (const s of sessions || []) {
        const minutes = (s.durationSec || 0) / 60;
        if (minutes <= 0) continue;
        const start = new Date(s.startedAt).getTime();
        const end = s.endedAt ? new Date(s.endedAt).getTime() : start + minutes * 60000;
        const inside = finite(start) && records
            ? records.filter((r) => !claimed.has(r) && r.start < end && r.end > start)
            : [];
        inside.forEach((r) => claimed.add(r));
        judged.push(judgeSession(s, maxHr, inside));
    }

    const outside = records ? tally(records.filter((r) => !claimed.has(r))) : null;

    if (!records && !judged.length) {
        return {
            effortMin: null, moderateMin: null, vigorousMin: null, zoneMinutes: null,
            source: null, note, breakdown: null,
        };
    }

    const moderate = (outside?.moderate ?? 0) + judged.reduce((sum, j) => sum + j.moderate, 0);
    const vigorous = (outside?.vigorous ?? 0) + judged.reduce((sum, j) => sum + j.vigorous, 0);
    const source = records && judged.length ? 'both' : records ? 'stream' : 'sessions';

    return {
        effortMin: Math.round(moderate + 2 * vigorous),
        moderateMin: Math.round(moderate),
        vigorousMin: Math.round(vigorous),
        zoneMinutes: records ? zonesOf(records) : null,
        source,
        note,
        breakdown: {
            // Effort the band saw outside every workout; null when there was no band.
            bandMin: outside ? Math.round(outside.moderate + 2 * outside.vigorous) : null,
            sessions: judged.map(({ moderate: m, vigorous: v, ...rest }) => rest),
        },
    };
};

/** Bump when the rules change, so days stored under the old ones are recomputed on read. */
const EFFORT_VERSION = 2;

module.exports = {
    EFFORT_VERSION,
    MODERATE_PCT,
    VIGOROUS_PCT,
    ZONE_EDGES,
    READINGS_PER_RECORD,
    DEFAULT_RECORD_MIN,
    maxHrFromAge,
    recordMinutes,
    fromStream,
    effortForDay,
};
