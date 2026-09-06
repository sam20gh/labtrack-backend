/**
 * Turns a person's profile and their plan's sleep advice into a nightly sleep goal.
 *
 * Pure functions, no database and no model call — the same discipline `activityTargets.js`
 * and `nutritionTargets.js` hold, and for the same reason: a goal somebody is scored
 * against every morning has to be reproducible and explainable. When they ask "why 8h 15m?",
 * `explain()` answers from the arithmetic that produced it.
 *
 * The guidance is the part that carries the plan. Without it this is a stopwatch with a
 * target, which the app does not need. "Aim for a consistent 7–8 hours and keep screens out
 * of the last hour" only becomes visible if it actually moves the goal and shows up beside
 * the number it moved.
 *
 * **A sleep goal is bounded by what is healthy, not by what somebody types.** Unlike the
 * activity targets — where an ambitious number costs nothing but a missed ring — sleeping
 * far more or far less than the adult range is itself a health signal. `CAPS` is what stops
 * the app endorsing a four-hour night by drawing a full ring around it.
 */

/**
 * The baseline, before any advice is applied.
 *
 * Eight hours: the middle of the 7–9 hour adult range every major guideline names, and the
 * figure `sleepScore.DEFAULT_GOAL_MINUTES` already scores against when nobody has set one.
 */
const BASELINE_MINUTES = 8 * 60;

/**
 * Bounds on the goal itself.
 *
 * `min` is the bottom of the adult recommendation rather than the bottom of what a person
 * might want. A goal of five hours would make a five-hour night score 100, which is the app
 * telling somebody that chronic short sleep is a target met. `max` exists for the mirror
 * reason: routinely sleeping past ten hours is associated with its own problems, and a goal
 * nobody can hit produces a ring that reads as failure every morning.
 */
const CAPS = { min: 6 * 60, max: 10 * 60 };

/**
 * Age-adjusted baselines, in minutes.
 *
 * The National Sleep Foundation's adult bands, collapsed to their midpoints. Applied only
 * when a date of birth is on the record — a guess about somebody's age is not worth moving
 * the number they are measured against.
 */
const AGE_BASELINES = [
    { maxAge: 17, minutes: 9 * 60 },
    { maxAge: 25, minutes: 8 * 60 + 30 },
    { maxAge: 64, minutes: 8 * 60 },
    { maxAge: 200, minutes: 7 * 60 + 30 },
];

/**
 * Keyword → goal shift, applied when the plan's sleep guidance mentions it.
 *
 * Keyword matching rather than a model call, deliberately, and for the reason
 * `ACTIVITY_SHIFTS` gives: this runs on every recalculation, and an LLM asked the same
 * question twice would move the goal by a few minutes each time. A nightly target that
 * drifts on its own is a target nobody trusts.
 *
 * `shift` is minutes added to the baseline, not a multiplier — sleep advice is expressed in
 * hours and half-hours, never in percentages, and "+30 minutes" survives a re-read where
 * "×1.06" does not. Advice that matches no rule is still carried through with `key: 'other'`:
 * a missing rule costs a shift, never the advice itself.
 *
 * `focus` is what the tracker highlights for that directive — it is how a piece of clinical
 * advice reaches the dashboard as something other than a paragraph.
 */
const SLEEP_SHIFTS = [
    {
        key: 'extend_sleep',
        kind: 'duration',
        label: 'Sleep longer',
        match: /(more|extra|increase|extend|longer|additional) sleep|sleep (more|longer)|at least (7|seven|8|eight) hours|sleep deprivation|insufficient sleep|chronic(ally)? short sleep/i,
        shift: 30,
        focus: ['duration'],
    },
    {
        key: 'consistency',
        kind: 'schedule',
        label: 'Keep a steady schedule',
        match: /consistent (bed|sleep|wake)|same time (each|every) (night|day)|regular (sleep|bed) ?(time|schedule)|sleep hygiene|circadian|shift work/i,
        shift: 0,
        focus: ['consistency'],
    },
    {
        key: 'screens',
        kind: 'behaviour',
        label: 'Screens out of the last hour',
        match: /screen|blue light|phone before bed|device.{0,20}before (bed|sleep)|avoid .{0,20}(tv|tablet|laptop)/i,
        shift: 0,
        focus: ['bedtime'],
    },
    {
        key: 'stimulants',
        kind: 'behaviour',
        label: 'Caffeine and alcohol earlier',
        match: /caffeine|coffee|alcohol|nicotine|stimulant/i,
        shift: 0,
        focus: ['efficiency'],
    },
    {
        key: 'apnoea',
        kind: 'clinical',
        label: 'Breathing during sleep',
        match: /apnoea|apnea|snor|cpap|oxygen desaturation|breathing (during|in) sleep/i,
        // A breathing problem is not fixed by aiming for a longer night, and adding time to
        // the goal would imply it might be. The advice is carried; the number is not moved.
        shift: 0,
        focus: ['efficiency', 'clinical'],
    },
    {
        key: 'recovery',
        kind: 'duration',
        label: 'Extra recovery sleep',
        match: /recovery|convalesc|post[- ]?operative|healing|immune|training load/i,
        shift: 30,
        focus: ['duration', 'deep'],
    },
    {
        key: 'insomnia_support',
        kind: 'clinical',
        label: 'Trouble falling asleep',
        match: /insomnia|difficulty (falling|staying) asleep|trouble sleeping|wake .{0,15}(during|in) the night|sleep onset/i,
        // Extending time in bed is the standard *wrong* answer for insomnia — sleep
        // restriction therapy does the opposite. The rule exists to surface the advice and
        // to point the tracker at efficiency, never to lengthen the goal.
        shift: 0,
        focus: ['efficiency', 'consistency'],
    },
    {
        key: 'naps',
        kind: 'behaviour',
        label: 'Watch daytime naps',
        match: /nap|daytime sleepiness|dozing/i,
        shift: 0,
        focus: ['consistency'],
    },
];

/** Every focus a shift can name. The dashboard branches on these, so they are enumerated. */
const FOCUS_KEYS = ['duration', 'consistency', 'efficiency', 'bedtime', 'deep', 'clinical'];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Whole years between a date of birth and now. Null when the record has no usable date. */
const ageFrom = (dob) => {
    if (!dob) return null;
    const born = new Date(dob);
    if (Number.isNaN(born.getTime())) return null;
    const years = (Date.now() - born.getTime()) / (365.25 * 86_400_000);
    return years > 0 && years < 130 ? Math.floor(years) : null;
};

/** The age-adjusted starting point, and the words `explain()` uses for it. */
const baselineFor = (user) => {
    const age = ageFrom(user?.dob);
    if (age === null) {
        return { minutes: BASELINE_MINUTES, basis: 'the general adult recommendation' };
    }
    const band = AGE_BASELINES.find((b) => age <= b.maxAge) || AGE_BASELINES[AGE_BASELINES.length - 1];
    return { minutes: band.minutes, basis: `the recommendation for your age (${age})` };
};

/**
 * Rebuild the guidance list from the person's sleep PlanItems.
 *
 * One entry per directive per matched rule, so a single piece of advice that both extends
 * the goal and points at consistency appears under both — the same shape
 * `activityTargets.deriveGuidance` produces, and the dashboard groups by `focus`.
 */
const deriveGuidance = (sleepItems = []) => {
    const guidance = [];

    for (const item of sleepItems) {
        const text = `${item.title || ''} ${item.description || ''}`;
        const matched = SLEEP_SHIFTS.filter((s) => s.match.test(text));

        if (!matched.length) {
            guidance.push({
                planItemId: item._id,
                key: 'other',
                kind: 'other',
                label: null,
                directive: item.title,
                rationale: item.description,
                focus: [],
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
                focus: s.focus,
            });
        }
    }

    return guidance;
};

/**
 * The goal in minutes, and what produced it.
 *
 * Order matters and is the whole of the arithmetic: age baseline → the sum of every matched
 * shift, each applied once however many directives triggered it → clamp to `CAPS` → a
 * person's own goal wins outright if they set one.
 *
 * A shift is applied **once per rule**, not once per directive. Three plan items that all
 * mention short sleep describe one problem, and compounding them would add ninety minutes
 * to somebody's night because their interpretation was thorough.
 */
const computeGoal = ({ user, sleepItems = [], reportedAverageHours, override } = {}) => {
    const base = baselineFor(user);
    const guidance = deriveGuidance(sleepItems);

    const appliedKeys = [...new Set(guidance.map((g) => g.key))]
        .filter((key) => SLEEP_SHIFTS.some((s) => s.key === key && s.shift !== 0));

    const shift = appliedKeys.reduce(
        (sum, key) => sum + (SLEEP_SHIFTS.find((s) => s.key === key)?.shift || 0),
        0
    );

    /**
     * What somebody says they usually sleep nudges the goal towards something reachable,
     * but only downwards and only by half an hour.
     *
     * Someone reporting five hours is handed 7h30m rather than 8h — a first week of ring
     * that is 40% full teaches people to stop opening the app. It never nudges *up*: a
     * person who reports nine hours does not need the app to ask for more, and the score
     * already declines to reward oversleeping.
     */
    const reported = Number.isFinite(reportedAverageHours) ? reportedAverageHours * 60 : null;
    const nudge = reported !== null && reported < base.minutes + shift - 30 ? -30 : 0;

    const derived = clamp(base.minutes + shift + nudge, CAPS.min, CAPS.max);

    const userSet = Number.isFinite(override) && override > 0;
    const minutes = userSet ? clamp(Math.round(override), CAPS.min, CAPS.max) : derived;

    return {
        minutes,
        guidance,
        basis: {
            baseMinutes: base.minutes,
            basis: base.basis,
            shiftMinutes: shift,
            nudgeMinutes: nudge,
            derivedMinutes: derived,
            appliedKeys,
            method: userSet ? 'user' : 'derived',
            /** True when a person's own goal was clamped — the screen says so rather than
             *  silently showing a different number from the one they picked. */
            clamped: userSet && Math.round(override) !== minutes,
        },
    };
};

/** `8h 15m`, the way every sleep screen writes a duration. */
const formatMinutes = (m) => {
    if (!Number.isFinite(m)) return '—';
    const h = Math.floor(m / 60);
    const min = Math.round(m % 60);
    return min ? `${h}h ${min}m` : `${h}h`;
};

/**
 * Why the goal is what it is, for the explainer under the dial.
 *
 * Reads from the same arithmetic `computeGoal` runs, so the sentence cannot describe a
 * calculation the number did not come from.
 */
const explain = ({ minutes, guidance = [], basis } = {}) => {
    if (!Number.isFinite(minutes)) return '';

    const lines = [
        `Starting from ${formatMinutes(basis?.baseMinutes ?? BASELINE_MINUTES)} a night ` +
        `(${basis?.basis || 'the general adult recommendation'}).`,
    ];

    const applied = guidance.filter((g) => (basis?.appliedKeys || []).includes(g.key));
    if (applied.length) {
        const labels = [...new Set(applied.map((g) => g.label).filter(Boolean))];
        lines.push(`Adjusted for the sleep advice on your plan: ${labels.join(', ').toLowerCase()}.`);
    } else if (guidance.length) {
        // Advice exists but nothing that moves a number matched it. Say so plainly rather
        // than implying the goal took it into account.
        lines.push('Your plan\'s sleep advice is shown below and did not change this number.');
    } else {
        lines.push('Your plan has no sleep advice yet, so this is the general guideline figure.');
    }

    if (basis?.nudgeMinutes) {
        lines.push('Eased back a little to match what you told us you usually sleep.');
    }
    if (basis?.method === 'user') {
        lines.push(basis?.clamped
            ? `You set this yourself; it was kept inside the healthy adult range of ${formatMinutes(CAPS.min)} to ${formatMinutes(CAPS.max)}.`
            : 'You set this yourself.');
    }

    lines.push(`Your goal is ${formatMinutes(minutes)} a night.`);

    return lines.join(' ');
};

/**
 * The bedtime that lands the person at their wake time having slept the goal.
 *
 * Returned as minutes from local midnight, so a bedtime before midnight comes back above
 * 1440 minus the goal rather than as a negative number the client has to unwrap.
 */
const bedtimeFor = (wakeMin, goalMinutes) => {
    if (!Number.isFinite(wakeMin) || !Number.isFinite(goalMinutes)) return null;
    return ((wakeMin - goalMinutes) % 1440 + 1440) % 1440;
};

module.exports = {
    computeGoal,
    deriveGuidance,
    baselineFor,
    bedtimeFor,
    explain,
    formatMinutes,
    SLEEP_SHIFTS,
    FOCUS_KEYS,
    BASELINE_MINUTES,
    AGE_BASELINES,
    CAPS,
};
