const CycleDay = require('../models/CycleDay');
const CyclePlan = require('../models/CyclePlan');
const User = require('../models/userModel');
const { FLOWS, SYMPTOMS } = require('../models/CycleDay');
const { STATUSES } = require('../models/CyclePlan');
const {
    isDay, isBleeding, addDays, diffDays, localDay, mergeDays,
} = require('../utils/cycleEngine');
const {
    forecast, nextFertile, regularityNotes, backtest, stats, marksForRange, symptomPattern,
    temperatureSignalOn, fertileAllowed, NORMAL, USABLE,
} = require('../utils/cycleForecast');
const { nightsBetween } = require('../utils/nightTemperature');

/**
 * The cycle tracker's read and write API.
 *
 * **Every date is the person's local calendar day**, sent by the client as `YYYY-MM-DD` or
 * resolved from `tzOffset`. Nothing here converts a day to an instant and back, which is the
 * way a period logged at 11pm in New York ends up filed under the next morning.
 *
 * **Every figure comes off `utils/cycleForecast.js`**, which is deterministic and tested. No
 * model reads or writes anything on this router.
 *
 * **Nothing here reaches a clinician.** No `/api/reviews` route reads these collections and
 * `interpretationController.gatherContext` does not gather them, by the product decision
 * recorded in `CLAUDE.md` under "Cycle tracker". Only the patient's own assistant sees a
 * summary — see `utils/assistantEngine.js`.
 */

/** How far back the tracker reads. Two years is 24+ cycles, far more than the forecast uses. */
const LOOKBACK_DAYS = 730;

/** A range edit this large is a client bug, not a period. */
const MAX_RANGE_EDIT = 62;

const todayFor = (req) => {
    const tz = req.query?.tzOffset ?? req.body?.tzOffset;
    return localDay(new Date(), Number(tz) || 0);
};

/**
 * What the app should offer this person, decided once here so the home screen, the profile
 * and the tracker cannot disagree.
 *
 *   enabled   — set up and switched on
 *   off       — set up once, then switched off; reachable from the profile only
 *   dismissed — said "Not now" to the offer; profile only
 *   suggested — `Female`, never set up: the home screen invites them
 *   offer     — `Other` or not recorded, never set up: invited once
 *   hidden    — `Male`, never set up: nothing proactive, but the profile row still works
 *
 * Gender decides the offer and nothing else. `CyclePlan.enabled` is the switch.
 */
const accessFor = (user, plan) => {
    if (plan?.enabled) return 'enabled';
    if (plan?.onboarded) return 'off';
    if (plan?.offerDismissedAt) return 'dismissed';
    if (user?.gender === 'Female') return 'suggested';
    if (user?.gender === 'Male') return 'hidden';
    return 'offer';
};

const planView = (plan) => ({
    enabled: Boolean(plan?.enabled),
    onboarded: Boolean(plan?.onboarded),
    seed: {
        lastPeriodStart: plan?.seed?.lastPeriodStart ?? null,
        periodLength: plan?.seed?.periodLength ?? null,
        cycleLength: plan?.seed?.cycleLength ?? null,
    },
    status: plan?.status ?? 'none',
    showFertileWindow: Boolean(plan?.showFertileWindow),
    fertileAllowed: fertileAllowed(plan),
    reminders: {
        periodSoon: plan?.reminders?.periodSoon ?? true,
        late: plan?.reminders?.late ?? true,
    },
    discreetPush: plan?.discreetPush ?? true,
});

/** Everything a reading needs, in three queries. */
const load = async (userId, today) => {
    const from = addDays(today, -LOOKBACK_DAYS);
    const [plan, user, rows, nights] = await Promise.all([
        CyclePlan.findOne({ userId }).lean(),
        User.findById(userId).select('gender').lean(),
        CycleDay.find({ userId, day: { $gte: from, $lte: addDays(today, 1) } }).lean(),
        temperatureSignalOn() ? nightsBetween(userId, from, today) : Promise.resolve([]),
    ]);
    const days = mergeDays(rows);
    const reading = forecast({ days, plan: plan || {}, today, nights });
    return { plan, user, days, reading, nights };
};

/** The one-tap "when did it end?" question, for a period somebody only logged the start of. */
const endPrompt = (reading, today) => {
    const latest = reading.periods[reading.periods.length - 1];
    if (!latest || reading.currentPeriod || latest.loggedDays !== 1) return null;
    const age = diffDays(latest.start, today);
    if (age < 2 || age > 14) return null;
    const suggested = addDays(latest.start, reading.periodLength.length - 1);
    const yesterday = addDays(today, -1);
    return { kind: 'confirm_end', start: latest.start, suggestedEnd: suggested < yesterday ? suggested : yesterday };
};

/** The reading, shaped for a screen. Arrays of periods and cycles stay on `/history`. */
const readingView = (reading, today) => ({
    state: reading.state,
    reason: reading.reason,
    cycleDay: reading.cycleDay,
    lastStart: reading.lastStart,
    lastStartSource: reading.lastStartSource,
    currentPeriod: reading.currentPeriod,
    prediction: reading.prediction,
    daysUntil: reading.daysUntil ?? null,
    daysLate: reading.daysLate ?? null,
    daysSinceStart: reading.daysSinceStart ?? null,
    periodLength: reading.periodLength,
    luteal: reading.luteal,
    next: reading.projected?.[0] ?? null,
    fertile: nextFertile(reading.projected, today),
});

const dayView = (row) => (row ? {
    day: row.day, flow: row.flow, symptoms: row.symptoms, mood: row.mood, note: row.note, source: row.source,
} : null);

/* ----------------------------------------------------------------- plan */

/** How many days each health store has contributed. For the settings screen's import row. */
const importedCounts = async (userId) => {
    const rows = await CycleDay.aggregate([
        { $match: { userId: new (require('mongoose').Types.ObjectId)(String(userId)), source: { $ne: 'manual' } } },
        { $group: { _id: '$source', days: { $sum: 1 } } },
    ]);
    return Object.fromEntries(rows.map((r) => [r._id, r.days]));
};

/** GET /api/cycle/plan */
exports.getPlan = async (req, res) => {
    try {
        const userId = req.user.id;
        const [plan, user, imported] = await Promise.all([
            CyclePlan.findOne({ userId }).lean(),
            User.findById(userId).select('gender').lean(),
            importedCounts(userId),
        ]);
        res.json({ access: accessFor(user, plan), plan: planView(plan), statuses: STATUSES, imported });
    } catch (err) {
        console.error('❌ Loading cycle plan failed:', err);
        res.status(500).json({ message: 'Could not load your cycle settings' });
    }
};

/**
 * PUT /api/cycle/plan
 *
 * Partial: only the fields sent are changed. Out-of-range numbers are a 400 rather than a
 * clamp, because a cycle length somebody typed as 280 is a typo worth telling them about, and
 * clamping it to 60 would quietly forecast from a number they never gave.
 */
exports.updatePlan = async (req, res) => {
    try {
        const userId = req.user.id;
        const body = req.body || {};
        const set = {};

        for (const key of ['enabled', 'onboarded', 'showFertileWindow', 'discreetPush']) {
            if (body[key] !== undefined) set[key] = Boolean(body[key]);
        }
        if (body.status !== undefined) {
            if (!STATUSES.includes(body.status)) return res.status(400).json({ message: 'Unknown status' });
            set.status = body.status;
        }
        if (body.reminders && typeof body.reminders === 'object') {
            for (const key of ['periodSoon', 'late']) {
                if (body.reminders[key] !== undefined) set[`reminders.${key}`] = Boolean(body.reminders[key]);
            }
        }
        if (body.seed && typeof body.seed === 'object') {
            const { lastPeriodStart, periodLength, cycleLength } = body.seed;
            if (lastPeriodStart !== undefined) {
                if (lastPeriodStart !== null && (!isDay(lastPeriodStart) || lastPeriodStart > addDays(todayFor(req), 1))) {
                    return res.status(400).json({ message: 'The last period has to be a date that has happened' });
                }
                set['seed.lastPeriodStart'] = lastPeriodStart;
            }
            const number = (value, lo, hi, label) => {
                if (value === null) return null;
                const n = Number(value);
                if (!Number.isInteger(n) || n < lo || n > hi) throw Object.assign(new Error(label), { status: 400 });
                return n;
            };
            if (periodLength !== undefined) set['seed.periodLength'] = number(periodLength, 1, 14, 'A period length is between 1 and 14 days');
            if (cycleLength !== undefined) set['seed.cycleLength'] = number(cycleLength, 15, 60, 'A cycle length is between 15 and 60 days');
        }

        const plan = await CyclePlan.findOneAndUpdate(
            { userId },
            { $set: set, $setOnInsert: { userId } },
            { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
        ).lean();
        const user = await User.findById(userId).select('gender').lean();

        console.log(`🌸 Cycle plan updated u=${userId} fields=${Object.keys(set).join(',') || 'none'}`);
        res.json({ access: accessFor(user, plan), plan: planView(plan), statuses: STATUSES });
    } catch (err) {
        if (err.status === 400) return res.status(400).json({ message: err.message });
        console.error('❌ Updating cycle plan failed:', err);
        res.status(500).json({ message: 'Could not save your cycle settings' });
    }
};

/** POST /api/cycle/offer/dismiss — "Not now" on the home screen's offer. It is not made again. */
exports.dismissOffer = async (req, res) => {
    try {
        const userId = req.user.id;
        const plan = await CyclePlan.findOneAndUpdate(
            { userId },
            { $set: { offerDismissedAt: new Date() }, $setOnInsert: { userId } },
            { upsert: true, new: true, setDefaultsOnInsert: true },
        ).lean();
        const user = await User.findById(userId).select('gender').lean();
        res.json({ access: accessFor(user, plan) });
    } catch (err) {
        console.error('❌ Dismissing cycle offer failed:', err);
        res.status(500).json({ message: 'Could not save that' });
    }
};

/* ------------------------------------------------------------ dashboard */

/**
 * GET /api/cycle/overview?tzOffset=
 *
 * The dashboard in one round trip: where somebody is in their cycle, when the next period is
 * likely, the week strip, today's log, the stats and the notes. Also what the home screen's
 * card reads, so the two say the same thing.
 */
exports.getOverview = async (req, res) => {
    try {
        const userId = req.user.id;
        const today = todayFor(req);
        const { plan, user, days, reading } = await load(userId, today);

        const byDay = new Map(days.map((d) => [d.day, d]));
        res.json({
            access: accessFor(user, plan),
            plan: planView(plan),
            today,
            reading: readingView(reading, today),
            week: marksForRange({ from: addDays(today, -3), to: addDays(today, 3), days, reading, today }),
            todayLog: dayView(byDay.get(today)),
            stats: stats(reading),
            notes: regularityNotes(reading, plan, today),
            prompt: endPrompt(reading, today),
            temperatureSignal: temperatureSignalOn(),
        });
    } catch (err) {
        console.error('❌ Loading cycle overview failed:', err);
        res.status(500).json({ message: 'Could not load your cycle' });
    }
};

/** GET /api/cycle/calendar?month=YYYY-MM&tzOffset= */
exports.getCalendar = async (req, res) => {
    try {
        const userId = req.user.id;
        const today = todayFor(req);
        const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today.slice(0, 7);
        const from = `${month}-01`;
        const to = addDays(addDays(`${month}-28`, 4).slice(0, 7) + '-01', -1);

        const { plan, days, reading } = await load(userId, today);
        res.json({
            month,
            today,
            days: marksForRange({ from, to, days, reading, today }),
            fertileShown: fertileAllowed(plan),
            prediction: reading.prediction,
        });
    } catch (err) {
        console.error('❌ Loading cycle calendar failed:', err);
        res.status(500).json({ message: 'Could not load your calendar' });
    }
};

/* ---------------------------------------------------------------- days */

/** GET /api/cycle/days/:day */
exports.getDay = async (req, res) => {
    try {
        const userId = req.user.id;
        const { day } = req.params;
        if (!isDay(day)) return res.status(400).json({ message: 'Not a date' });
        res.json({ entry: dayView(await mergedDay(userId, day)) });
    } catch (err) {
        console.error('❌ Loading cycle day failed:', err);
        res.status(500).json({ message: 'Could not load that day' });
    }
};

/**
 * Write the manual row for a day, or remove it when nothing is left on it.
 *
 * Shared by the day log and the range edit, so a day that ends up with nothing on it is
 * deleted by both — an empty row would still be "a day somebody logged" to anything that
 * counts rows. The one exception is `flowCleared`: a manual row that says "not a period day"
 * about a day a health store says was is kept, empty or not, because it is the only thing
 * standing between the person's correction and the mirrored flow (see `cycleEngine.mergeDays`).
 */
const writeManual = async (userId, day, fields) => {
    const mirrored = await CycleDay.findOne({ userId, day, source: { $ne: 'manual' }, flow: { $ne: null } }).lean();
    const flowCleared = fields.flow === null && fields.keepStoreFlow !== true && Boolean(mirrored);
    const { keepStoreFlow, ...stored } = fields;
    const empty = !stored.flow && !stored.symptoms?.length && !stored.mood && !stored.note;
    if (empty && !flowCleared) {
        await CycleDay.deleteOne({ userId, day, source: 'manual' });
        return null;
    }
    return CycleDay.findOneAndUpdate(
        { userId, day, source: 'manual' },
        { $set: { ...stored, flowCleared }, $setOnInsert: { userId, day, source: 'manual' } },
        { upsert: true, new: true, runValidators: true },
    ).lean();
};

/** The day as a screen reads it — the manual row merged with any store rows. */
const mergedDay = async (userId, day) => mergeDays(await CycleDay.find({ userId, day }).lean())[0] || null;

/**
 * PUT /api/cycle/days/:day
 *
 * The whole day, replaced: `{ flow, symptoms, mood, note }`. A future day is refused — a
 * period that has not happened is a prediction, and predictions are this API's to draw.
 */
exports.putDay = async (req, res) => {
    try {
        const userId = req.user.id;
        const { day } = req.params;
        if (!isDay(day)) return res.status(400).json({ message: 'Not a date' });
        if (day > todayFor(req)) return res.status(400).json({ message: 'You can only log days that have happened' });

        // `flow` omitted means "whatever the health store says" — the log screen sends it only
        // when somebody touched it, so saving a headache does not freeze an imported flow.
        const { symptoms = [], mood = null, note = null } = req.body || {};
        const flowGiven = Object.prototype.hasOwnProperty.call(req.body || {}, 'flow');
        const flow = flowGiven ? req.body.flow : null;
        if (flow !== null && !FLOWS.includes(flow)) return res.status(400).json({ message: 'Unknown flow' });
        if (!Array.isArray(symptoms)) return res.status(400).json({ message: 'symptoms must be a list' });
        const cleanSymptoms = [...new Set(symptoms)].filter((s) => SYMPTOMS.includes(s));
        const cleanMood = mood === null ? null : Number(mood);
        if (cleanMood !== null && (!Number.isInteger(cleanMood) || cleanMood < 1 || cleanMood > 5)) {
            return res.status(400).json({ message: 'Mood is 1 to 5' });
        }
        const cleanNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, 500) : null;

        const row = await writeManual(userId, day, {
            flow, symptoms: cleanSymptoms, mood: cleanMood, note: cleanNote, keepStoreFlow: !flowGiven,
        });
        console.log(`🌸 Cycle day ${row ? 'saved' : 'cleared'} u=${userId}`);
        res.json({ entry: dayView(await mergedDay(userId, day)) });
    } catch (err) {
        console.error('❌ Saving cycle day failed:', err);
        res.status(500).json({ message: 'Could not save that day' });
    }
};

/** DELETE /api/cycle/days/:day — the manual row goes; anything else on the day is kept. */
exports.deleteDay = async (req, res) => {
    try {
        const userId = req.user.id;
        const { day } = req.params;
        if (!isDay(day)) return res.status(400).json({ message: 'Not a date' });
        await CycleDay.deleteOne({ userId, day, source: 'manual' });
        res.json({ ok: true });
    } catch (err) {
        console.error('❌ Deleting cycle day failed:', err);
        res.status(500).json({ message: 'Could not delete that day' });
    }
};

/**
 * PUT /api/cycle/period-days  `{ add: [day], remove: [day] }`
 *
 * The calendar's "edit period dates" mode, and the one-tap "started" / "ended on" buttons.
 * Adding marks a day as a period day with `flow: 'unspecified'` unless it already has a
 * bleeding flow — a flow somebody chose is never overwritten by a range. Removing clears the
 * flow and keeps the day's symptoms and note, which were about the day, not the bleeding.
 */
exports.putPeriodDays = async (req, res) => {
    try {
        const userId = req.user.id;
        const today = todayFor(req);
        const add = Array.isArray(req.body?.add) ? req.body.add : [];
        const remove = Array.isArray(req.body?.remove) ? req.body.remove : [];

        if (add.length + remove.length > MAX_RANGE_EDIT) {
            return res.status(400).json({ message: 'That is more days than one edit can change' });
        }
        if ([...add, ...remove].some((d) => !isDay(d))) return res.status(400).json({ message: 'Not a date' });
        if (add.some((d) => d > today)) return res.status(400).json({ message: 'You can only log days that have happened' });

        const touched = [...new Set([...add, ...remove])];
        const rows = await CycleDay.find({ userId, day: { $in: touched } }).lean();
        const existing = new Map(rows.filter((r) => r.source === 'manual').map((r) => [r.day, r]));
        // Merged, so a day a health store already has as a period day is not overwritten
        // with "unspecified" and lose the flow the store recorded.
        const merged = new Map(mergeDays(rows).map((d) => [d.day, d]));

        let added = 0;
        let removed = 0;
        for (const day of new Set(add)) {
            const row = existing.get(day);
            if (isBleeding(merged.get(day)?.flow)) continue;
            // A store row with bleeding that the person had cleared: undo the clear rather
            // than invent a flow over the one the store recorded.
            const storeBleeds = rows.some((r) => r.day === day && r.source !== 'manual' && isBleeding(r.flow));
            if (storeBleeds && row?.flowCleared) {
                await writeManual(userId, day, {
                    flow: null, symptoms: row.symptoms || [], mood: row.mood ?? null, note: row.note ?? null, keepStoreFlow: true,
                });
                added += 1;
                continue;
            }
            await writeManual(userId, day, {
                flow: 'unspecified',
                symptoms: row?.symptoms || [],
                mood: row?.mood ?? null,
                note: row?.note ?? null,
            });
            added += 1;
        }
        for (const day of new Set(remove)) {
            if (add.includes(day)) continue;
            const row = existing.get(day);
            await writeManual(userId, day, {
                flow: null,
                symptoms: row?.symptoms || [],
                mood: row?.mood ?? null,
                note: row?.note ?? null,
            });
            removed += 1;
        }

        console.log(`🌸 Period days edited u=${userId} +${added} -${removed}`);
        res.json({ added, removed });
    } catch (err) {
        console.error('❌ Editing period days failed:', err);
        res.status(500).json({ message: 'Could not save those days' });
    }
};

/* ------------------------------------------------------ history, insight */

/** GET /api/cycle/history — every period and cycle, newest first, with the stats. */
exports.getHistory = async (req, res) => {
    try {
        const userId = req.user.id;
        const today = todayFor(req);
        const { plan, reading } = await load(userId, today);

        const periods = reading.periods.slice().reverse();
        const cycles = reading.cycles.map((c) => ({
            ...c,
            usable: c.length >= USABLE.min && c.length <= USABLE.max,
            outsideUsual: c.length < NORMAL.cycleMin || c.length > NORMAL.cycleMax,
        })).reverse();

        res.json({
            periods,
            cycles,
            openCycle: reading.lastStart ? { start: reading.lastStart, day: reading.cycleDay } : null,
            stats: stats(reading),
            accuracy: backtest(reading.periods, plan),
            normal: NORMAL,
        });
    } catch (err) {
        console.error('❌ Loading cycle history failed:', err);
        res.status(500).json({ message: 'Could not load your history' });
    }
};

/**
 * GET /api/cycle/insight?tzOffset=
 *
 * Cycle and period lengths against the usual band, which symptoms land on which cycle days,
 * how the forecast would have done, and the night-time temperature since the previous period.
 * The temperature chart is always sent when there are nights; the shift it may show is
 * marked only when `CYCLE_TEMPERATURE_SIGNAL` is on.
 */
exports.getInsight = async (req, res) => {
    try {
        const userId = req.user.id;
        const today = todayFor(req);
        const { plan, days, reading } = await load(userId, today);

        const previousStart = reading.periods.length >= 2
            ? reading.periods[reading.periods.length - 2].start
            : reading.lastStart || addDays(today, -35);
        const nights = await nightsBetween(userId, previousStart, today);

        res.json({
            cycles: reading.cycles.slice(-12).map((c) => ({
                start: c.start, length: c.length, periodLength: c.periodLength,
                usable: c.length >= USABLE.min && c.length <= USABLE.max,
            })),
            normal: NORMAL,
            stats: stats(reading),
            symptoms: symptomPattern(days, reading.periods),
            accuracy: backtest(reading.periods, plan),
            temperature: {
                signal: temperatureSignalOn(),
                from: previousStart,
                nights,
                periodStarts: reading.periods.filter((p) => p.start >= previousStart).map((p) => p.start),
                confirmedOvulations: reading.confirmedOvulations,
            },
        });
    } catch (err) {
        console.error('❌ Loading cycle insight failed:', err);
        res.status(500).json({ message: 'Could not load your cycle insight' });
    }
};

/**
 * DELETE /api/cycle/imported?source=health_connect|apple_health
 *
 * The days a health store contributed, and nothing the person logged. For somebody who
 * switches the import off and does not want what it brought in either. The store still holds
 * its own copy; switching the import back on brings them back.
 */
exports.deleteImported = async (req, res) => {
    try {
        const userId = req.user.id;
        const { source } = req.query;
        if (!['health_connect', 'apple_health'].includes(source)) {
            return res.status(400).json({ message: 'source must be health_connect or apple_health' });
        }
        const { deletedCount } = await CycleDay.deleteMany({ userId, source });
        // A manual "not a period day" only meant something against a store row.
        await CycleDay.updateMany({ userId, source: 'manual', flowCleared: true }, { $set: { flowCleared: false } });
        await CycleDay.deleteMany({
            userId, source: 'manual', flow: null, symptoms: { $size: 0 }, mood: null, note: null,
        });
        console.log(`🌸 Imported cycle days removed u=${userId} source=${source} (${deletedCount})`);
        res.json({ deletedDays: deletedCount });
    } catch (err) {
        console.error('❌ Removing imported cycle days failed:', err);
        res.status(500).json({ message: 'Could not remove the imported days' });
    }
};

/**
 * DELETE /api/cycle/data — everything, gone.
 *
 * Every logged day and every setting. The plan is recreated empty with the offer marked as
 * answered, so the home screen does not immediately invite somebody who just erased their
 * data to start again.
 */
exports.deleteAll = async (req, res) => {
    try {
        const userId = req.user.id;
        const { deletedCount } = await CycleDay.deleteMany({ userId });
        await CyclePlan.deleteOne({ userId });
        await CyclePlan.create({ userId, offerDismissedAt: new Date() });
        console.log(`🌸 Cycle data deleted u=${userId} (${deletedCount} days)`);
        res.json({ deletedDays: deletedCount });
    } catch (err) {
        console.error('❌ Deleting cycle data failed:', err);
        res.status(500).json({ message: 'Could not delete your cycle data' });
    }
};

exports._accessFor = accessFor;
exports._load = load;
exports._endPrompt = endPrompt;
