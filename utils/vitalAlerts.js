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
 * **Pure.** No database, no clock it was not handed. `vitalAlertCentre.js` does the writing.
 *
 * Two levels, and they are about *who needs to act how soon*, never a diagnosis:
 *
 *   - `attention` — outside the range a clinician would want to know about. The patient is
 *     told during waking hours; the reading goes on their record for review.
 *   - `urgent`    — the range where the advice is "seek care now if you feel unwell". The
 *     patient is told even inside quiet hours, which is what the `vitals` notification
 *     category's `critical` priority exists for.
 *
 * Five rules the table holds:
 *
 * 1. **Blood pressure delegates to `bloodPressure.classify`.** A reading must never alert
 *    more leniently than the same reading is staged on the metrics screen, so this file
 *    has no blood-pressure thresholds of its own: stage 2 is `attention`, crisis is
 *    `urgent`. Stage 1 and "Elevated" do not alert. Between them they cover a large share
 *    of adults, and an alert that fires for most people is one everybody learns to ignore.
 * 2. **Heart rate only counts at rest.** 140 bpm on a run is the point of the run. Only
 *    `resting`, `sleeping` and `manual` readings are evaluated; `active`, `recovery` and
 *    the day's max (which includes exercise) never are.
 * 3. **Oxygen alerts go down, not up.** SpO2 cannot be too high, so "elevated" does not
 *    apply to it. The concern is a low reading.
 * 4. **Thresholds follow NEWS2 where it has an opinion.** A score of 3 on a single
 *    parameter is `urgent`, which puts SpO2 ≤91% and a resting heart rate ≥131 there. A
 *    clinician reading the record will recognise those numbers; invented ones would need
 *    explaining. Resting heart rate >100 is `attention` because that is the definition of
 *    tachycardia, below NEWS2's own first step.
 * 5. **A consumer sensor misreads, so the copy says so.** A wrist oximeter reads low in
 *    cold hands, and the bracelet's blood pressure is a cuffless estimate. The alert still
 *    fires. The product decision recorded on `MetricLog.method` is that an optical crisis
 *    reading raises a crisis. But the patient is told to re-measure, and the clinician
 *    sees the method.
 */
const bp = require('./bloodPressure');

const METRICS = ['blood_pressure', 'heart_rate', 'spo2'];
const LEVELS = ['attention', 'urgent'];
const LEVEL_RANK = { attention: 1, urgent: 2 };

/** Heart-rate contexts where a high number means something. See rule 2. */
const RESTING_CONTEXTS = ['resting', 'sleeping', 'manual'];

const HEART_RATE = {
    /** NEWS2 scores 3 from 131. */
    urgentAtLeast: 131,
    /** Tachycardia is defined as a resting rate over 100. */
    attentionAtLeast: 101,
};

const SPO2 = {
    /** NEWS2 scale 1 scores 3 at 91 and below. */
    urgentAtMost: 91,
    /** 92–93 scores 2. The usual target range for a healthy adult starts at 94. */
    attentionAtMost: 93,
};

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
 * Evaluate one reading. Returns null when the reading is fine or cannot be read.
 *
 * `severity` orders breaches of the same metric: level first, then how far out the number
 * is. It picks the "worst reading" a card and a worklist row show, and nothing else.
 */
const evaluateOne = (reading) => {
    if (!reading || !METRICS.includes(reading.metric)) return null;

    if (reading.metric === 'blood_pressure') {
        const category = bp.classify(Number(reading.systolic), Number(reading.diastolic));
        if (!category) return null;
        const level = category.key === 'crisis' ? 'urgent' : category.key === 'stage_2' ? 'attention' : null;
        if (!level) return null;
        return {
            level,
            rule: `blood_pressure.${category.key}`,
            category: category.key,
            severity: LEVEL_RANK[level] * 1000 + Number(reading.systolic),
        };
    }

    if (reading.metric === 'spo2') {
        const spo2 = Number(reading.spo2);
        // The ingest's own plausibility band. Below 70 is a sensor fault, not a finding.
        if (!Number.isFinite(spo2) || spo2 < 70 || spo2 > 100) return null;
        const level = spo2 <= SPO2.urgentAtMost ? 'urgent'
            : spo2 <= SPO2.attentionAtMost ? 'attention' : null;
        if (!level) return null;
        return {
            level,
            rule: `spo2.${level === 'urgent' ? 'at_most_91' : 'at_most_93'}`,
            category: null,
            severity: LEVEL_RANK[level] * 1000 + (100 - spo2),
        };
    }

    // heart_rate
    const bpm = Number(reading.bpm);
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) return null;
    if (!RESTING_CONTEXTS.includes(reading.context)) return null;
    const level = bpm >= HEART_RATE.urgentAtLeast ? 'urgent'
        : bpm >= HEART_RATE.attentionAtLeast ? 'attention' : null;
    if (!level) return null;
    return {
        level,
        rule: `heart_rate.${level === 'urgent' ? 'resting_at_least_131' : 'resting_over_100'}`,
        category: null,
        severity: LEVEL_RANK[level] * 1000 + bpm,
    };
};

/**
 * Every reading in a batch that breaches a threshold, each with its level and rule.
 *
 * @param {object[]} readings  `{ metric, measuredAt, ...value fields }`
 * @returns {object[]}         the breaching readings, with `level`, `rule`, `category`,
 *                             `severity` added
 */
const evaluate = (readings = []) =>
    readings
        .map((r) => {
            const at = new Date(r?.measuredAt);
            if (Number.isNaN(at.getTime())) return null;
            const hit = evaluateOne(r);
            return hit ? { ...r, measuredAt: at, ...hit } : null;
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
 * Where tapping the patient's card goes. Blood pressure has its own history screen;
 * the other two live on the metrics dashboard.
 */
const METRIC_ROUTE = {
    blood_pressure: '/metrics/blood-pressure',
    heart_rate: '/metrics',
    spo2: '/metrics',
};

/**
 * What the patient is told. Copy, not code, so it lives in the table.
 *
 * Three rules, each enforced by `__tests__/vitalAlerts.test.js`:
 *   - it describes **the reading**, never the person ("this reading is", not "you have");
 *   - it never names a condition. No "hypertension", "tachycardia" or "hypoxia";
 *   - every `urgent` body tells the person what to do if they feel unwell, because
 *     "re-measure" alone is the wrong advice to somebody who is short of breath.
 *
 * Bodies stay under the notification centre's 240-character cap.
 */
const COPY = {
    blood_pressure: {
        attention: {
            title: 'Blood pressure reading to review',
            body: (v, r) => `${r.method === 'optical_estimate' ? 'Your bracelet estimated' : 'You logged'} ${v}, which is in the stage 2 range. `
                + 'One reading is not a diagnosis. Re-measure while seated and rested, and '
                + 'mention it to a clinician.',
        },
        urgent: {
            title: 'Very high blood pressure reading',
            body: (v, r) => `${r.method === 'optical_estimate' ? 'Your bracelet estimated' : 'You logged'} ${v}. `
                + 'If you have chest pain, breathlessness, weakness, trouble speaking or vision '
                + 'changes, seek emergency care now. Otherwise re-measure in 5 minutes.',
        },
    },
    spo2: {
        attention: {
            title: 'Low blood oxygen reading',
            body: (v) => `A reading of ${v} is below the usual range. Wrist sensors can misread, `
                + 'so sit still, warm your hands and measure again. Tell a clinician if it stays low.',
        },
        urgent: {
            title: 'Very low blood oxygen reading',
            body: (v) => `A reading of ${v} is well below the usual range. If you are short of `
                + 'breath, confused or have chest pain, seek emergency care now. Otherwise sit '
                + 'still, warm your hands and measure again.',
        },
    },
    heart_rate: {
        attention: {
            title: 'High resting heart rate',
            body: (v) => `Your heart rate read ${v} while at rest. Caffeine, stress, illness `
                + 'or a missed dose can raise it. Rest for 10 minutes and measure again. '
                + 'Tell a clinician if it stays high.',
        },
        urgent: {
            title: 'Very high resting heart rate',
            body: (v) => `Your heart rate read ${v} while at rest. If you feel faint, breathless `
                + 'or have chest pain, seek emergency care now. Otherwise rest and measure again.',
        },
    },
};

/** Card copy for one reading. */
const copyFor = (reading, level) => {
    const spec = COPY[reading.metric]?.[level];
    if (!spec) return null;
    const v = valueLabel(reading);
    return { title: spec.title, body: spec.body(v, reading), chip: v };
};

/**
 * The notification-centre category for a level.
 *
 * Two categories because priority decides whether a push may cross quiet hours, and only
 * the `urgent` level should. `notificationCatalogue.js` keeps `vitals` as the one critical
 * category; `vitals_review` is the same mark at normal priority.
 */
const CATEGORY_FOR_LEVEL = { urgent: 'vitals', attention: 'vitals_review' };

module.exports = {
    METRICS,
    LEVELS,
    LEVEL_RANK,
    RESTING_CONTEXTS,
    HEART_RATE,
    SPO2,
    FRESH_HOURS,
    METRIC_LABEL,
    METRIC_ROUTE,
    CATEGORY_FOR_LEVEL,
    COPY,
    evaluate,
    evaluateOne,
    isFresh,
    higherLevel,
    valueLabel,
    copyFor,
};
