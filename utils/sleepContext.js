/**
 * The sleep tracker's recent nights, as a few lines of the assistant's context.
 *
 * Before this, sleep reached the assistant only through `user.observed` — a fortnight's
 * averages and a count of nights. So "how was my sleep last night?" got an honest refusal:
 * the model could see that 21 nights existed and not one of them. The Sleep Details screen's
 * "Ask Predyqt AI about this night" button led straight into that refusal.
 *
 * What it renders, and why each part is here:
 *
 *   - **Their local date**, so "last night" means the night that ended this morning where
 *     they are, not where the server is. `tzOffset` is the phone's, sent with the message;
 *     an older build sends none and the newest registered device's offset stands in. With
 *     neither, clock times are labelled UTC rather than passed off as local.
 *   - **One line per wake day for `WINDOW_DAYS`**, split into night and naps by
 *     `sleepRecord.classifyDay` — the same split the dashboard and the detail screen use, so
 *     the assistant cannot call a nap "last night".
 *   - **The findings the detail screen shows for that night**, from `sleepAnalysis.analyse`.
 *     Deterministic, and already worded to describe the record rather than the person, so
 *     the assistant explains what the screen said instead of writing a second opinion beside it.
 *
 * Null stages stay "not reported", never zero — the rule `sleepScore.js` holds.
 *
 * Returns null — and the section is omitted — for anybody with no sleep recorded.
 */
const SleepSession = require('../models/SleepSession');
const SleepPlan = require('../models/SleepPlan');
const User = require('../models/userModel');
const { localDay } = require('./healthSync');
const { localMinutes } = require('./sleepInsight');
const { classifyDay, dayTotal } = require('./sleepRecord');
const { analyse, fmtMinutes, fmtClock } = require('./sleepAnalysis');
const { bandFor } = require('./sleepScore');

/** Wake days rendered, newest first. Long enough to cover "last week", short enough to stay cheap. */
const WINDOW_DAYS = 14;
/** How far before a night `analyse` looks for "later than usual" — the detail screen's fortnight. */
const LOOKBACK_DAYS = 14;

const finite = (v) => Number.isFinite(v);

const addDays = (day, n) =>
    new Date(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

const weekday = (day) =>
    new Date(`${day}T00:00:00.000Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });

const SOURCE_NAME = {
    healthkit: 'Apple Health',
    health_connect: 'Health Connect',
    jstyle_bracelet: 'their bracelet',
    manual: 'entered by hand',
    aggregator: 'a health app',
};

/** Minutes west of UTC from the device that registered most recently — `hydrationNudgeJob`'s rule. */
const offsetFromDevices = (user) => {
    const withClock = (user?.pushTokens || [])
        .filter((t) => finite(t.tzOffset))
        .sort((a, b) => new Date(b.registeredAt || 0) - new Date(a.registeredAt || 0));
    return withClock.length ? withClock[0].tzOffset : null;
};

const validOffset = (v) => {
    const n = Number(v);
    return v !== null && v !== undefined && v !== '' && finite(n) && Math.abs(n) <= 14 * 60 ? n : null;
};

/**
 * @param {string} userId
 * @param {{ tzOffset?: number|null, now?: Date }} [options]
 */
const gatherSleep = async (userId, { tzOffset = null, now = new Date() } = {}) => {
    let offset = validOffset(tzOffset);
    let offsetKnown = offset !== null;
    if (!offsetKnown) {
        const user = await User.findById(userId).select('pushTokens').lean();
        offset = offsetFromDevices(user);
        offsetKnown = offset !== null;
    }
    if (!offsetKnown) offset = 0;

    const today = localDay(now, offset);
    const from = addDays(today, -(WINDOW_DAYS + LOOKBACK_DAYS));

    const [rows, plan] = await Promise.all([
        SleepSession.find({ userId, day: { $gte: from, $lte: today } })
            .select('-segments -parts')
            .lean(),
        SleepPlan.findOne({ userId }).select('goalMinutes guidance').lean(),
    ]);
    if (!rows.length) return null;

    const goalMinutes = plan?.goalMinutes ?? null;
    const byDay = new Map();
    for (const r of rows) byDay.set(r.day, [...(byDay.get(r.day) || []), r]);

    const split = new Map();
    for (const [day, sessions] of byDay) split.set(day, classifyDay(sessions, offset, { goalMinutes }));

    const windowStart = addDays(today, -(WINDOW_DAYS - 1));
    const days = [...split.keys()].filter((d) => d >= windowStart).sort().reverse();
    if (!days.length) return null;

    const entries = days.map((day) => {
        const { night, naps } = split.get(day);
        const recentNights = [...split.entries()]
            .filter(([d]) => d >= addDays(day, -LOOKBACK_DAYS) && d < day)
            .map(([, s]) => s.night)
            .filter(Boolean);
        const totals = dayTotal({ night, naps });
        const analysis = night
            ? analyse({
                session: night,
                kind: 'night',
                goalMinutes,
                day: totals,
                recentNights,
                tzOffset: offset,
                guidance: plan?.guidance || [],
            })
            : null;
        return { day, night, naps, totals, analysis };
    });

    return { today, tzOffset: offset, offsetKnown, goalMinutes, entries };
};

const stageText = (stages = {}) => {
    const parts = [
        ['deep', stages.deepMin],
        ['REM', stages.remMin],
        ['light', stages.lightMin],
        ['awake', stages.awakeMin],
    ].filter(([, m]) => finite(m)).map(([label, m]) => `${label} ${fmtMinutes(m)}`);
    return parts.length ? `stages ${parts.join(', ')}` : 'stages not reported';
};

const nightLine = (night, tz) => {
    const bits = [
        `${fmtClock(localMinutes(night.startedAt, tz))} → ${fmtClock(localMinutes(night.endedAt, tz))}`,
        `asleep ${fmtMinutes(night.asleepMin)}${finite(night.inBedMin) ? ` of ${fmtMinutes(night.inBedMin)} in bed` : ''}`,
        stageText(night.stages),
    ];
    if (finite(night.efficiency)) bits.push(`efficiency ${night.efficiency}%`);
    const band = finite(night.score) ? bandFor(night.score) : null;
    bits.push(finite(night.score) ? `score ${night.score}/100${band ? ` (${band.label})` : ''}` : 'no score');
    const device = night.sourceDevice?.name;
    bits.push(`from ${device || SOURCE_NAME[night.source] || night.source}`);
    if (night.notes) bits.push(`their note: "${String(night.notes).slice(0, 200)}"`);
    return bits.join(', ');
};

const renderSleep = (sleep) => {
    if (!sleep) return '';
    const { today, tzOffset, offsetKnown, goalMinutes, entries } = sleep;
    const tz = offsetKnown ? 'their local time' : 'UTC — their time zone is not known';
    const lines = ['', '## Their recent sleep, night by night (from the sleep tracker)'];

    lines.push(`Their local date today is ${today} (${weekday(today)}). Clock times below are ${tz}.`);
    lines.push('Each sleep is filed under the day they woke up, so "last night" is the night filed under today.');
    if (entries[0].day !== today || !entries[0].night) {
        lines.push(`No night is recorded for today yet — the most recent sleep on record is filed under ${entries[0].day}. `
            + 'Their device may not have synced since they woke; say so rather than describing an older night as last night.');
    }
    lines.push(`Sleep goal: ${finite(goalMinutes) ? fmtMinutes(goalMinutes) : 'not set (scored against the default)'}.`);

    for (const { day, night, naps, totals, analysis } of entries) {
        lines.push('');
        lines.push(`### Woke ${day} (${weekday(day)})${day === today ? ' — last night' : ''}`);
        lines.push(night ? `  Night: ${nightLine(night, tzOffset)}` : '  No main night recorded — naps only.');
        for (const nap of naps) {
            lines.push(`  Nap: ${fmtClock(localMinutes(nap.startedAt, tzOffset))}, ${fmtMinutes(nap.asleepMin)}`);
        }
        if (naps.length && totals) lines.push(`  Day total including naps: ${fmtMinutes(totals.totalMin)}.`);
        if (analysis) {
            lines.push(`  What the app showed them for this night: "${analysis.headline}"`);
            for (const f of analysis.findings) lines.push(`    - ${f.title}: ${f.detail}`);
            if (analysis.recommendations.length) {
                lines.push(`    Suggestions shown: ${analysis.recommendations.map((r) => r.title).join('; ')}.`);
            }
        }
    }

    lines.push('');
    lines.push('When they ask about a particular night — "last night", a weekday, a date — answer from that');
    lines.push('night\'s line, and stay consistent with what the app already showed them for it. Sleep stages');
    lines.push('are wrist estimates: describe them as more or less than typical, never as a deficit. Describe');
    lines.push('the record, never the person, and do not diagnose a sleep disorder from it. A stage marked');
    lines.push('"not reported" was not measured — it is not zero.');
    return lines.join('\n');
};

module.exports = { gatherSleep, renderSleep, WINDOW_DAYS };
