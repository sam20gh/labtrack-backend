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
 * Minutes per zone and per intensity from one day's stream.
 *
 * Each record is classified by its mean. A record holds fifteen readings, and each non-zero
 * reading stands for `recordMinutes / 15` minutes, so a record with half its readings missing
 * (the band slipping) counts half its span.
 */
const fromStream = (blocks, maxHr) => {
    const entries = Object.entries(blocks || {})
        .map(([key, tuple]) => [Number(key), tuple])
        .filter(([start, tuple]) => finite(start) && validTuple(tuple));
    if (!entries.length || !maxHr) return null;

    const span = recordMinutes(entries.map(([start]) => start));
    const perReading = span / READINGS_PER_RECORD;
    const zones = [0, 0, 0, 0, 0];
    let moderate = 0;
    let vigorous = 0;

    for (const [, [n, sum]] of entries) {
        const fraction = (sum / n) / maxHr;
        const minutes = Math.min(n, READINGS_PER_RECORD) * perReading;
        const zone = zoneOf(fraction);
        if (zone >= 0) zones[zone] += minutes;
        const intensity = intensityOf(fraction);
        if (intensity === 'moderate') moderate += minutes;
        if (intensity === 'vigorous') vigorous += minutes;
    }

    return {
        zoneMinutes: zones.map((z) => Math.round(z)),
        moderateMin: moderate,
        vigorousMin: vigorous,
        covered: entries.map(([start]) => [start, start + span * 60000]),
    };
};

/** Whether any stream record overlaps a workout, so the workout is not counted twice. */
const coveredBy = (covered, startMs, endMs) =>
    covered.some(([from, to]) => from < endMs && to > startMs);

/** A workout the stream did not see. */
const sessionIntensity = (session, maxHr) => {
    // The person's own rating outranks a type: a gentle swim and a hard one are both "swimming".
    if (finite(session.effort)) {
        if (session.effort <= 1) return 'light';
        return session.effort >= 4 ? 'vigorous' : 'moderate';
    }
    if (finite(session.avgBpm) && session.avgBpm > 0 && maxHr) return intensityOf(session.avgBpm / maxHr);
    const type = String(session.type || '').toLowerCase();
    if (UNCOUNTED_TYPES.has(type)) return 'light';
    return VIGOROUS_TYPES.has(type) ? 'vigorous' : 'moderate';
};

const fromSessions = (sessions, maxHr, covered) => {
    let moderate = 0;
    let vigorous = 0;
    let counted = 0;

    for (const s of sessions || []) {
        const minutes = (s.durationSec || 0) / 60;
        if (minutes <= 0) continue;
        const start = new Date(s.startedAt).getTime();
        const end = s.endedAt ? new Date(s.endedAt).getTime() : start + minutes * 60000;
        if (finite(start) && covered.length && coveredBy(covered, start, end)) continue;

        counted += 1;
        const intensity = sessionIntensity(s, maxHr);
        if (intensity === 'moderate') moderate += minutes;
        if (intensity === 'vigorous') vigorous += minutes;
    }
    return { moderateMin: moderate, vigorousMin: vigorous, counted };
};

/**
 * One day's effort.
 *
 * @param {object} args
 * @param {object} [args.blocks]   `HeartStream.blocks` for the day
 * @param {Array}  [args.sessions] the day's `ActivitySession` rows
 * @param {number|null} args.maxHr estimated maximum heart rate, or null without a birth date
 * @returns {{ effortMin, moderateMin, vigorousMin, zoneMinutes, source, note }}
 */
const effortForDay = ({ blocks = null, sessions = [], maxHr = null }) => {
    const hasStream = Boolean(blocks && Object.keys(blocks).length);
    const stream = fromStream(blocks, maxHr);
    const worn = fromSessions(sessions, maxHr, stream?.covered ?? []);

    // A stream with no birth date to read it against: the workouts still count by type, and
    // the note tells the screen why the band's own minutes do not.
    const note = hasStream && !maxHr ? 'needs_age' : null;

    if (!stream && !worn.counted) {
        return { effortMin: null, moderateMin: null, vigorousMin: null, zoneMinutes: null, source: null, note };
    }

    const moderate = (stream?.moderateMin ?? 0) + worn.moderateMin;
    const vigorous = (stream?.vigorousMin ?? 0) + worn.vigorousMin;
    const source = stream && worn.counted ? 'both' : stream ? 'stream' : 'sessions';

    return {
        effortMin: Math.round(moderate + 2 * vigorous),
        moderateMin: Math.round(moderate),
        vigorousMin: Math.round(vigorous),
        zoneMinutes: stream?.zoneMinutes ?? null,
        source,
        note,
    };
};

module.exports = {
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
