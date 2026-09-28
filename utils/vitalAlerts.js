/**
 * When a vital-sign reading is worth somebody's attention, as a table.
 *
 * The tenth deterministic table in the series with `medicationCatalogue.js`,
 * `bloodPressure.js`, `nutritionSafety.js`, `reviewSla.js`, `predictionForecast.js`,
 * `achievementCatalogue.js`, `sleepTargets.js`, `appState.ts` and `notificationCatalogue.js`,
 * and for the same reason: you cannot assert that a model will always flag an oxygen
 * saturation of 88%, and a threshold each screen picks for itself is one the patient's
 * card and the clinician's worklist eventually disagree about.
 *
 * **Pure.** No database, no clock it was not handed. `vitalAlertCentre.js` does the writing,
 * and passes in the person's `VitalTarget` when a clinician has set one.
 *
 * Two levels, and they are about *who needs to act how soon*, never a diagnosis:
 *
 *   - `attention`: outside the range a clinician would want to know about. The patient is
 *     told during waking hours, and the reading goes on their record for review.
 *   - `urgent`: the range where the advice is "seek care now if you feel unwell". The
 *     patient is told even inside quiet hours, which is what the `vitals` notification
 *     category's `critical` priority exists for.
 *
 * Seven rules the table holds:
 *
 * 1. **Blood pressure delegates to `bloodPressure.classify`.** A reading must never alert
 *    more leniently than the same reading is staged on the metrics screen, so this file
 *    has no blood-pressure thresholds of its own. Stage 2 is `attention` and crisis is
 *    `urgent`. Stage 1 and "Elevated" do not alert: between them they cover a large share
 *    of adults, and an alert that fires for most people is one everybody learns to ignore.
 * 2. **Heart rate only counts at rest.** 140 bpm on a run is the point of the run. Only
 *    `resting`, `sleeping` and `manual` readings are evaluated. `active`, `recovery` and
 *    the day's max (which includes exercise) never are.
 * 3. **Oxygen alerts go down, not up.** SpO2 cannot be too high, so the concern is a low
 *    reading.
 * 4. **Thresholds follow NEWS2 where it has an opinion.** A score of 3 on one parameter is
 *    `urgent` and a score of 2 is `attention`: SpO2 ≤91 and 92–93 on scale 1, and a resting
 *    heart rate ≥131. A clinician reading the record will recognise those numbers, where
 *    invented ones would need explaining. Resting heart rate >100 is `attention` because
 *    that is the definition of tachycardia.
 * 5. **Low heart rate departs from NEWS2 on purpose.** NEWS2 scores ≤40 as 3, but NEWS2 was
 *    written for people already in hospital. The bracelet labels its overnight timed
 *    readings `resting`, and fit adults routinely sleep below 40. Treating that as urgent
 *    would push a critical alert through the quiet hours of every runner who wears one. So
 *    ≤40 at rest is `attention` (a clinician sees it at normal priority), and ≤30 is `urgent`,
 *    which is below what sleep or training explain.
 * 6. **Some people's normal is outside the default, and only a clinician may say so.** A
 *    `VitalTarget` can move SpO2 to NEWS2 scale 2 (the 88–92% target for somebody at risk of
 *    hypercapnic respiratory failure, e.g. COPD), where 85 and below alerts rather than 93.
 *    It can also mark a low resting heart rate as expected (an athlete, a beta blocker),
 *    which drops the ≤40 band and keeps the ≤30 one. Neither is a patient setting. Moving
 *    your own alarm threshold is a clinical decision, and NEWS2 itself requires scale 2 to
 *    be prescribed.
 * 7. **A consumer sensor misreads, so the copy says so.** A wrist oximeter reads low in cold
 *    hands, and the bracelet's blood pressure is a cuffless estimate. The alert still fires:
 *    the product decision recorded on `MetricLog.method` is that an optical crisis reading
 *    raises a crisis. But the patient is told to re-measure, and the clinician sees the
 *    method.
 */
const bp = require('./bloodPressure');

const METRICS = ['blood_pressure', 'heart_rate', 'spo2'];
const LEVELS = ['attention', 'urgent'];
const LEVEL_RANK = { attention: 1, urgent: 2 };

/** Heart-rate contexts where the number means something. See rule 2. */
const RESTING_CONTEXTS = ['resting', 'sleeping', 'manual'];

const HEART_RATE = {
    /** NEWS2 scores 3 from 131. */
    urgentAtLeast: 131,
    /** Tachycardia is defined as a resting rate over 100. */
    attentionAtLeast: 101,
    /** See rule 5. */
    lowAttentionAtMost: 40,
    lowUrgentAtMost: 30,
};

/**
 * The two NEWS2 SpO2 scales. Scale 1 is everybody unless a clinician says otherwise.
 * Scale 2's high-side scores only apply to somebody on supplemental oxygen, which nothing
 * here records, so only its low side is used.
 */
const SPO2_SCALES = {
    standard: { label: 'Standard (94–98%)', target: '94–98%', attentionAtMost: 93, urgentAtMost: 91 },
    hypercapnic: { label: 'Hypercapnic risk (88–92%)', target: '88–92%', attentionAtMost: 85, urgentAtMost: 83 },
};

/** What a person gets when no clinician has set anything. */
const DEFAULT_TARGETS = { spo2Scale: 'standard', lowHeartRateExpected: false };

/**
 * A reading older than this still goes on the record but does not notify the patient.
 *
 * A first bracelet sync backfills weeks of history, and "your oxygen was low on the 3rd"
 * three weeks later is not something anyone can act on. The clinician still sees it,
 * because a pattern is exactly what they are there to read.
 */
const FRESH_HOURS = 24;

/** Clock drift allowance. A bracelet reset to 1970 is filtered elsewhere; this is minutes. */
const FUTURE_SLACK_MS = 60 * 60 * 1000;

/**
 * How far out of range a reading is, within its level. Picks the "worst reading" a card
 * and a worklist row show, and nothing else. Heart rate is scored in both directions, so a
 * 32 and a 135 in one episode are compared by distance from the normal band.
 */
const magnitude = (metric, r) => {
    if (metric === 'blood_pressure') return Number(r.systolic) || 0;
    if (metric === 'spo2') return 100 - (Number(r.spo2) || 100);
    const bpm = Number(r.bpm) || 0;
    return Math.max(bpm - 100, (50 - bpm) * 2, 0);
};

const severity = (metric, r, level) => (LEVEL_RANK[level] || 0) * 1000 + magnitude(metric, r);

const hit = (metric, reading, level, rule, category = null) =>
    ({ level, rule, category, severity: severity(metric, reading, level) });

/**
 * Evaluate one reading against the table and, where set, the person's targets. Returns null
 * when the reading is fine or cannot be read.
 */
const evaluateOne = (reading, targets = DEFAULT_TARGETS) => {
    if (!reading || !METRICS.includes(reading.metric)) return null;
    const t = { ...DEFAULT_TARGETS, ...(targets || {}) };

    if (reading.metric === 'blood_pressure') {
        const category = bp.classify(Number(reading.systolic), Number(reading.diastolic));
        if (!category) return null;
        const level = category.key === 'crisis' ? 'urgent' : category.key === 'stage_2' ? 'attention' : null;
        if (!level) return null;
        return hit('blood_pressure', reading, level, `blood_pressure.${category.key}`, category.key);
    }

    if (reading.metric === 'spo2') {
        const spo2 = Number(reading.spo2);
        // The ingest's own plausibility band. Below 70 is a sensor fault, not a finding.
        if (!Number.isFinite(spo2) || spo2 < 70 || spo2 > 100) return null;
        const scaleKey = SPO2_SCALES[t.spo2Scale] ? t.spo2Scale : 'standard';
        const scale = SPO2_SCALES[scaleKey];
        const level = spo2 <= scale.urgentAtMost ? 'urgent'
            : spo2 <= scale.attentionAtMost ? 'attention' : null;
        if (!level) return null;
        const prefix = scaleKey === 'hypercapnic' ? 'spo2.scale2_at_most_' : 'spo2.at_most_';
        const bound = level === 'urgent' ? scale.urgentAtMost : scale.attentionAtMost;
        return hit('spo2', reading, level, `${prefix}${bound}`);
    }

    // heart_rate
    const bpm = Number(reading.bpm);
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) return null;
    if (!RESTING_CONTEXTS.includes(reading.context)) return null;

    if (bpm >= HEART_RATE.urgentAtLeast) return hit('heart_rate', reading, 'urgent', 'heart_rate.resting_at_least_131');
    if (bpm >= HEART_RATE.attentionAtLeast) return hit('heart_rate', reading, 'attention', 'heart_rate.resting_over_100');
    if (bpm <= HEART_RATE.lowUrgentAtMost) return hit('heart_rate', reading, 'urgent', 'heart_rate.resting_at_most_30');
    if (bpm <= HEART_RATE.lowAttentionAtMost && !t.lowHeartRateExpected) {
        return hit('heart_rate', reading, 'attention', 'heart_rate.resting_at_most_40');
    }
    return null;
};

/**
 * Every reading in a batch that breaches a threshold, each with its level and rule.
 *
 * @param {object[]} readings  `{ metric, measuredAt, ...value fields }`
 * @param {object} [targets]   `{ spo2Scale, lowHeartRateExpected }` from `VitalTarget`
 * @returns {object[]}         the breaching readings, with `level`, `rule`, `category`,
 *                             `severity` added
 */
const evaluate = (readings = [], targets = DEFAULT_TARGETS) =>
    readings
        .map((r) => {
            const at = new Date(r?.measuredAt);
            if (Number.isNaN(at.getTime())) return null;
            const found = evaluateOne(r, targets);
            return found ? { ...r, measuredAt: at, ...found } : null;
        })
        .filter(Boolean);

/** Whether a reading is recent enough to tell the patient about. */
const isFresh = (measuredAt, now = new Date()) => {
    const age = now.getTime() - new Date(measuredAt).getTime();
    return age >= -FUTURE_SLACK_MS && age <= FRESH_HOURS * 3600_000;
};

const higherLevel = (a, b) => ((LEVEL_RANK[b] || 0) > (LEVEL_RANK[a] || 0) ? b : a);

/** The reading as a person reads it: `152/94 mmHg`, `91%`, `118 bpm`. */
const valueLabel = (reading) => {
    if (reading.metric === 'blood_pressure') return `${Math.round(reading.systolic)}/${Math.round(reading.diastolic)} mmHg`;
    if (reading.metric === 'spo2') return `${Math.round(reading.spo2)}%`;
    return `${Math.round(reading.bpm)} bpm`;
};

const METRIC_LABEL = {
    blood_pressure: 'Blood pressure',
    heart_rate: 'Resting heart rate',
    spo2: 'Blood oxygen',
};

/**
 * Where tapping the patient's card goes: the same screen the metrics dashboard opens for
 * that card (`METRIC_ROUTE` in `labtrack-frontend/lib/metrics.ts`). Blood pressure has its
 * own history, SpO2 comes from the bracelet, and heart rate is charted on the activity screen.
 */
const METRIC_ROUTE = {
    blood_pressure: '/metrics/blood-pressure',
    heart_rate: '/activity',
    spo2: '/bracelet',
};

/**
 * What the patient is told, one entry per rule. Copy, not code, so it lives in the table.
 *
 * Three rules, each enforced by `__tests__/vitalAlerts.test.js`:
 *   - it describes **the reading**, never the person ("this reading is", not "you have");
 *   - it never names a condition. No "hypertension", "tachycardia", "bradycardia" or
 *     "hypoxia";
 *   - every `urgent` body tells the person what to do if they feel unwell, because
 *     "re-measure" alone is the wrong advice to somebody who is short of breath.
 *
 * Bodies stay under the notification centre's 240-character cap.
 */
const measured = (r) => (r.method === 'optical_estimate' ? 'Your bracelet estimated' : 'You logged');

const COPY = {
    'blood_pressure.stage_2': {
        title: 'Blood pressure reading to review',
        body: (v, r) => `${measured(r)} ${v}, which is in the stage 2 range. One reading is not a `
            + 'diagnosis. Re-measure while seated and rested, and mention it to a clinician.',
    },
    'blood_pressure.crisis': {
        title: 'Very high blood pressure reading',
        body: (v, r) => `${measured(r)} ${v}. If you have chest pain, breathlessness, weakness, `
            + 'trouble speaking or vision changes, seek emergency care now. Otherwise re-measure in 5 minutes.',
    },
    'spo2.at_most_93': {
        title: 'Low blood oxygen reading',
        body: (v) => `A reading of ${v} is below the usual range. Wrist sensors can misread, so sit `
            + 'still, warm your hands and measure again. Tell a clinician if it stays low.',
    },
    'spo2.at_most_91': {
        title: 'Very low blood oxygen reading',
        body: (v) => `A reading of ${v} is well below the usual range. If you are short of breath, `
            + 'confused or have chest pain, seek emergency care now. Otherwise sit still, warm your '
            + 'hands and measure again.',
    },
    'spo2.scale2_at_most_85': {
        title: 'Blood oxygen below your target',
        body: (v) => `A reading of ${v} is below the 88–92% target your clinician set. Sit still, `
            + 'warm your hands and measure again. Follow your care plan if it stays low.',
    },
    'spo2.scale2_at_most_83': {
        title: 'Blood oxygen well below your target',
        body: (v) => `A reading of ${v} is well below the 88–92% target your clinician set. If you `
            + 'are more breathless than usual, drowsy or confused, seek emergency care now.',
    },
    'heart_rate.resting_over_100': {
        title: 'High resting heart rate',
        body: (v) => `Your heart rate read ${v} while at rest. Caffeine, stress, illness or a missed `
            + 'dose can raise it. Rest for 10 minutes and measure again. Tell a clinician if it stays high.',
    },
    'heart_rate.resting_at_least_131': {
        title: 'Very high resting heart rate',
        body: (v) => `Your heart rate read ${v} while at rest. If you feel faint, breathless or have `
            + 'chest pain, seek emergency care now. Otherwise rest and measure again.',
    },
    'heart_rate.resting_at_most_40': {
        title: 'Low resting heart rate',
        body: (v) => `Your heart rate read ${v} at rest. Fitness, sleep and some heart medicines can `
            + 'bring it this low. If you feel dizzy, faint or unusually tired, tell a clinician.',
    },
    'heart_rate.resting_at_most_30': {
        title: 'Very low resting heart rate',
        body: (v) => `Your heart rate read ${v} at rest. If you feel faint, dizzy, breathless or have `
            + 'chest pain, seek emergency care now. Otherwise sit down and measure again.',
    },
};

/** Every rule the table can fire. The tests hold `COPY` and the portal's labels to it. */
const RULES = Object.keys(COPY);

/** Card copy for one evaluated reading. Needs `metric` and `rule`. */
const copyFor = (reading) => {
    const spec = COPY[reading.rule];
    if (!spec) return null;
    const v = valueLabel(reading);
    return { title: spec.title, body: spec.body(v, reading), chip: v };
};

/**
 * What the patient is told once a clinician has reviewed an episode.
 *
 * Wording per outcome, used when the clinician wrote no message of their own. It says what
 * the clinician concluded in the patient's terms, and where there is something to do, the
 * card's one action goes there. `escalated` tells the person to seek care themselves if
 * nobody has reached them. That outcome means a clinician thinks it cannot wait, and a card
 * that only said "someone will be in touch" would leave them waiting on a call that may not
 * come.
 */
const REVIEW_COPY = {
    no_action: {
        body: 'They looked at these readings and no action is needed right now. Keep measuring as usual.',
    },
    advised_patient: {
        body: 'They have advice for you about these readings. If you have not heard from them, '
            + 'book a consultation so you can talk it through.',
        action: { label: 'Book a consult', route: '/professionals', tone: 'primary' },
    },
    appointment: {
        body: 'They would like you to have a consultation about these readings. Book one if you '
            + 'have not already.',
        action: { label: 'Book a consult', route: '/professionals', tone: 'primary' },
    },
    plan_item: {
        body: 'They have added a follow-up about these readings to your health plan.',
        route: '/myplans',
        action: { label: 'Open my plan', route: '/myplans', tone: 'primary' },
    },
    escalated: {
        body: 'They want these readings looked at urgently. If nobody has contacted you today, '
            + 'speak to a doctor today, or seek emergency care if you feel unwell.',
    },
    measurement_error: {
        body: 'They think these readings may not be accurate. Measure again while seated, still '
            + 'and rested, following your device instructions.',
    },
};

/** `A clinician reviewed your blood oxygen readings`. Max 80 characters on the card. */
const reviewTitle = (metric) => `A clinician reviewed your ${(METRIC_LABEL[metric] || 'health').toLowerCase()} readings`;

const reviewCopyFor = (metric, outcome, patientMessage = null) => {
    const spec = REVIEW_COPY[outcome];
    if (!spec) return null;
    const own = typeof patientMessage === 'string' ? patientMessage.trim() : '';
    return {
        title: reviewTitle(metric),
        body: own ? own.slice(0, 240) : spec.body,
        route: spec.route || null,
        action: spec.action || null,
    };
};

/**
 * The notification-centre category for a level.
 *
 * Two categories because priority decides whether a push may cross quiet hours, and only
 * the `urgent` level should. `notificationCatalogue.js` keeps `vitals` as the one critical
 * category, and `vitals_review` is the same mark at normal priority.
 */
const CATEGORY_FOR_LEVEL = { urgent: 'vitals', attention: 'vitals_review' };

module.exports = {
    METRICS,
    LEVELS,
    LEVEL_RANK,
    RESTING_CONTEXTS,
    HEART_RATE,
    SPO2_SCALES,
    DEFAULT_TARGETS,
    FRESH_HOURS,
    METRIC_LABEL,
    METRIC_ROUTE,
    CATEGORY_FOR_LEVEL,
    COPY,
    RULES,
    REVIEW_COPY,
    reviewCopyFor,
    evaluate,
    evaluateOne,
    magnitude,
    severity,
    isFresh,
    higherLevel,
    valueLabel,
    copyFor,
};
