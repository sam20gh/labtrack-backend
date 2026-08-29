/**
 * Turns a person's profile and their plan's exercise advice into weekly activity targets.
 *
 * Pure functions, no database and no model call — the same discipline `nutritionTargets`
 * holds, and for the same reason: a target somebody is measured against every week has to
 * be reproducible and explainable. When they ask "why 150 minutes?", `explain()` answers
 * from the arithmetic that produced it.
 *
 * The guidance is the part that carries the plan. Without it this is a step counter with a
 * weekly goal, which the app does not need. "Build up to 150 minutes of moderate aerobic
 * activity a week" only becomes visible if it actually moves the minutes target, and
 * "avoid high-impact exercise while that knee settles" only means something if it changes
 * what the app suggests.
 */

/**
 * The baseline, before any advice is applied.
 *
 * The WHO adult guideline — 150 minutes of moderate activity a week, spread over most days.
 * Five sessions rather than three because frequency is the part people can build a habit
 * from, and because the design's goal card counts sessions.
 */
const BASELINE = { sessions: 5, minutes: 150 };

/**
 * The self-rated gauge maps to a *starting* target, not a permanent one.
 *
 * Someone who says they are sedentary is given a target they can actually hit this week;
 * handing them 150 minutes on day one produces a goal card that reads as failure from the
 * moment it appears. The plan's guidance then moves it from there.
 */
const LEVEL_BASELINES = [
    null,
    { sessions: 2, minutes: 40 },   // 1 — Lazy
    { sessions: 3, minutes: 75 },   // 2
    { sessions: 4, minutes: 120 },  // 3
    { sessions: 5, minutes: 150 },  // 4
    { sessions: 6, minutes: 210 },  // 5 — Athletic
];

/** Same idea, keyed off whichever health-assessment field was actually filled. */
const FREQUENCY_BASELINES = {
    none: { sessions: 2, minutes: 40 },
    light: { sessions: 3, minutes: 75 },
    moderate: { sessions: 4, minutes: 120 },
    active: { sessions: 5, minutes: 150 },
    'very active': { sessions: 6, minutes: 210 },
};

/**
 * Keyword → target shift, applied when the plan's exercise guidance mentions it.
 *
 * Keyword matching rather than a model call, deliberately. This runs on every target
 * recalculation, and an LLM asked the same question twice would move the target by a few
 * minutes each time. A weekly goal that drifts on its own is a goal nobody trusts.
 *
 * Shifts are multiplicative on the baseline, and `cap` exists so several directives that
 * all push the same way cannot compound into a target nobody could meet. Advice that
 * matches no rule is still carried through with `key: 'other'` — a missing rule costs a
 * target shift, never the advice itself.
 */
const ACTIVITY_SHIFTS = [
    {
        key: 'more_aerobic',
        kind: 'volume',
        label: 'More aerobic work',
        match: /aerobic|cardio|brisk walk|increase (your )?(physical )?activity|more exercise|150 minutes/i,
        shift: { sessions: 1.2, minutes: 1.35 },
        favour: ['walking', 'jogging', 'biking', 'swimming'],
        avoid: [],
    },
    {
        key: 'resistance',
        kind: 'modality',
        label: 'Add resistance work',
        match: /resistance|strength train|weight[- ]bearing|muscle mass|sarcopenia|bone density/i,
        shift: { sessions: 1.2, minutes: 1.1 },
        favour: ['weightlifting'],
        avoid: [],
    },
    {
        key: 'low_impact',
        kind: 'caution',
        label: 'Keep it low impact',
        match: /low[- ]impact|joint|knee|arthrit|avoid (high[- ]impact|running)|non[- ]weight[- ]bearing/i,
        // A caution does not reduce how much someone should move, it changes what they do.
        shift: { sessions: 1.0, minutes: 1.0 },
        favour: ['swimming', 'biking', 'walking', 'yoga'],
        avoid: ['jogging', 'soccer'],
    },
    {
        key: 'build_gradually',
        kind: 'volume',
        label: 'Build up gradually',
        match: /gradual|build up|start slow|ease into|deconditioned|begin with short/i,
        shift: { sessions: 1.0, minutes: 0.7 },
        favour: ['walking', 'yoga'],
        avoid: [],
    },
    {
        key: 'reduce_intensity',
        kind: 'intensity',
        label: 'Keep intensity moderate',
        match: /moderate intensity|avoid (strenuous|vigorous|intense)|do not overexert|keep .*heart rate below/i,
        shift: { sessions: 1.0, minutes: 1.0 },
        favour: ['walking', 'yoga', 'swimming'],
        avoid: ['soccer'],
    },
    {
        key: 'flexibility',
        kind: 'modality',
        label: 'Add mobility work',
        match: /flexibilit|mobility|stretch|balance training|fall risk/i,
        shift: { sessions: 1.15, minutes: 1.0 },
        favour: ['yoga'],
        avoid: [],
    },
    {
        key: 'sedentary',
        kind: 'volume',
        label: 'Break up sitting',
        match: /sedentary|sitting|break up (long )?periods|move more often|desk/i,
        shift: { sessions: 1.4, minutes: 1.1 },
        favour: ['walking'],
        avoid: [],
    },
    {
        key: 'weight_management',
        kind: 'volume',
        label: 'Support weight goals',
        match: /weight (loss|management|reduction)|bmi|body composition|calorie deficit/i,
        shift: { sessions: 1.2, minutes: 1.4 },
        favour: ['walking', 'jogging', 'biking', 'swimming'],
        avoid: [],
    },
];

/** Ceilings. Several directives pushing the same way must not compound into the absurd. */
const CAPS = { sessions: 7, minutes: 420 };
/** Floors. Advice must never produce a target of nothing. */
const FLOORS = { sessions: 1, minutes: 20 };

/**
 * Match the plan's exercise PlanItems against the rules.
 *
 * Every item produces a guidance entry whether or not a rule matched, because the person is
 * shown their own advice and losing a directive because we had no regex for it would be a
 * silent omission from their care.
 */
const deriveGuidance = (exerciseItems = []) => {
    const guidance = [];

    for (const item of exerciseItems) {
        const text = `${item.title || ''} ${item.description || ''}`;
        const matched = ACTIVITY_SHIFTS.filter((s) => s.match.test(text));

        if (!matched.length) {
            guidance.push({
                planItemId: item._id,
                key: 'other',
                kind: 'other',
                label: null,
                directive: item.title,
                rationale: item.description,
                favour: [],
                avoid: [],
            });
            continue;
        }

        for (const s of matched) {
            guidance.push({
                planItemId: item._id,
                key: s.key,
                kind: s.kind,
                label: s.label,
                directive: item.title,
                rationale: item.description,
                favour: s.favour,
                avoid: s.avoid,
            });
        }
    }

    return guidance;
};

/**
 * Multiply the baseline by every matched shift, then clamp.
 *
 * **Advice to do more can never produce a target to do less.**
 *
 * The shifts are multiplicative, and two directives can legitimately point opposite ways:
 * "build up to 150 minutes of aerobic activity" matches both the volume rule (×1.35) and
 * the gradual-progression rule (×0.7), which multiply out to ×0.945. For someone starting
 * at 75 minutes that set a target of 70 — below where they already were, directly under a
 * sentence telling them to increase. The person reads the directive and the number together,
 * and they contradicted each other.
 *
 * So a directive that raises volume also raises the floor: the result cannot fall below the
 * baseline. Damping an increase is what "build up gradually" means; reversing it is not.
 */
const applyGuidance = (base, guidance = []) => {
    let sessions = base.sessions;
    let minutes = base.minutes;
    const applied = [];
    let raisesVolume = false;

    for (const g of guidance) {
        const def = ACTIVITY_SHIFTS.find((s) => s.key === g.key);
        if (!def) continue;
        sessions *= def.shift.sessions;
        minutes *= def.shift.minutes;
        if (def.shift.minutes > 1 || def.shift.sessions > 1) raisesVolume = true;
        applied.push(def.key);
    }

    const floors = raisesVolume
        ? { sessions: Math.max(FLOORS.sessions, base.sessions), minutes: Math.max(FLOORS.minutes, base.minutes) }
        : FLOORS;

    return {
        sessions: Math.min(CAPS.sessions, Math.max(floors.sessions, Math.round(sessions))),
        // Rounded to the nearest 5 minutes: a target of 163 minutes reads as a machine's
        // number, and nobody plans their week to that precision.
        minutes: Math.min(CAPS.minutes, Math.max(floors.minutes, Math.round(minutes / 5) * 5)),
        applied: [...new Set(applied)],
    };
};

/** The starting point, from whichever self-report the person actually gave. */
const baselineFor = ({ selfRatedLevel, lifestyle } = {}) => {
    const level = Number(selfRatedLevel);
    if (Number.isInteger(level) && level >= 1 && level <= 5) {
        return { ...LEVEL_BASELINES[level], source: `self-rated level ${level}` };
    }

    const freq = String(lifestyle?.exerciseFrequency || '').toLowerCase();
    if (FREQUENCY_BASELINES[freq]) {
        return { ...FREQUENCY_BASELINES[freq], source: `reported activity: ${freq}` };
    }

    return { ...BASELINE, source: 'general adult guideline' };
};

/**
 * Compute weekly targets.
 *
 * @param {object} args
 * @param {object} [args.user]           the User document, for `healthAssessment.lifestyle`
 * @param {Array}  [args.exerciseItems]  PlanItems of type 'lifestyle', condition 'exercise'
 * @param {number} [args.selfRatedLevel] the onboarding gauge, 1–5
 * @param {object} [args.overrides]      targets the person set themselves; these win
 * @returns {{targets: object, guidance: Array, basis: object}}
 */
const computeTargets = ({ user, exerciseItems = [], selfRatedLevel, overrides } = {}) => {
    const guidance = deriveGuidance(exerciseItems);
    const base = baselineFor({ selfRatedLevel, lifestyle: user?.healthAssessment?.lifestyle });
    const applied = applyGuidance(base, guidance);

    const targets = {
        sessions: applied.sessions,
        minutes: applied.minutes,
        distanceKm: null,
        calories: null,
    };

    // An override replaces the computed figure for that one target only. Someone who set a
    // distance goal should not lose the plan-derived minutes target along with it.
    const usedOverride = [];
    for (const key of ['sessions', 'minutes', 'distanceKm', 'calories']) {
        const value = overrides?.[key];
        if (Number.isFinite(value) && value > 0) {
            targets[key] = value;
            usedOverride.push(key);
        }
    }

    return {
        targets,
        guidance,
        basis: {
            method: usedOverride.length ? 'user' : 'guideline',
            baseMinutes: base.minutes,
            baseSessions: base.sessions,
            activity: base.source,
            appliedKeys: applied.applied,
        },
    };
};

/** Why the targets are what they are, for the explainer. Reads the same arithmetic. */
const explain = ({ targets, guidance = [], basis } = {}) => {
    if (!targets) return '';

    const lines = [
        `Starting from ${basis?.baseSessions ?? BASELINE.sessions} sessions and ` +
        `${basis?.baseMinutes ?? BASELINE.minutes} minutes a week (${basis?.activity || 'general adult guideline'}).`,
    ];

    const applied = guidance.filter((g) => (basis?.appliedKeys || []).includes(g.key));
    if (applied.length) {
        const labels = [...new Set(applied.map((g) => g.label).filter(Boolean))];
        lines.push(`Adjusted for the exercise advice on your plan: ${labels.join(', ').toLowerCase()}.`);
    } else if (guidance.length) {
        // Advice exists but no rule matched it. Say so plainly rather than implying the
        // targets took it into account.
        lines.push('Your plan\'s exercise advice is shown below but did not change these numbers.');
    } else {
        lines.push('Your plan has no exercise advice yet, so these are the general guideline figures.');
    }

    if (basis?.method === 'user') {
        lines.push('Some of these you set yourself.');
    }

    lines.push(`Your target is ${targets.sessions} sessions and ${targets.minutes} minutes a week.`);

    return lines.join(' ');
};

module.exports = {
    computeTargets,
    deriveGuidance,
    applyGuidance,
    baselineFor,
    explain,
    ACTIVITY_SHIFTS,
    BASELINE,
    LEVEL_BASELINES,
    CAPS,
    FLOORS,
};
