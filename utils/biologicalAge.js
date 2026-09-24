/**
 * Predyqt Age — the lab half.
 *
 * **A deterministic table, not a model** — the tenth in the series with
 * `medicationCatalogue.js`, `bloodPressure.js`, `nutritionSafety.js`, `reviewSla.js`,
 * `predictionForecast.js`, `achievementCatalogue.js`, `sleepTargets.js`, `appState.ts` and
 * `notificationCatalogue.js`. The argument is the one every one of those files makes, and it
 * is at its strongest here: a language model asked how old somebody's body looks answers
 * fluently, differently on each call, and there is no way to assert in a test that it did not
 * invent four years out of a full blood count.
 *
 * This file implements **Levine PhenoAge** (Liu, Kuo, Horvath, Crimmins, Ferrucci & Levine,
 * *PLOS Medicine* 2018), unchanged. Nine routine analytes plus chronological age, trained
 * against NHANES mortality follow-up. The coefficients below are the published ones and
 * nothing here was fitted, tuned or rounded by us — which is the whole reason to use it
 * rather than invent a scoring function that looks similar and answers to nobody.
 *
 * ## Three things this file must never do
 *
 * 1. **Never return the mortality score.** PhenoAge works by converting the biomarkers into a
 *    ten-year all-cause mortality probability and then re-expressing that as an age. That
 *    intermediate — `M` in the paper, and in `phenoAge()` below — is the most engaging number
 *    in this entire product and putting it in front of a person would be the most harmful
 *    thing the app has ever done. It stays a local variable, it is absent from every returned
 *    object, and `__tests__/biologicalAge.test.js` asserts that it never appears in a
 *    response. Same line `EcgRecording` holds by refusing to interpret a trace, and
 *    `resourceView.gateBody` holds by keeping withheld text out of the payload rather than
 *    flagging it.
 * 2. **Never impute a missing analyte.** All nine are required. Substituting a population
 *    mean for a marker somebody did not have measured produces a number that is mostly the
 *    population mean wearing that person's name, and it fails silently — the result looks
 *    identical to a real one. A panel missing a marker refuses and says which.
 * 3. **Never answer for a body the equation was not fitted on.** NHANES III/IV adults. Under
 *    `MIN_AGE` there is no valid answer at any confidence, and no amount of good data makes
 *    one.
 *
 * ## Two unit traps, both silent, both measured
 *
 * **CRP.** `unitNormaliser` canonicalises C-reactive protein to **mg/L**; PhenoAge wants
 * **mg/dL**, and the value goes through a logarithm. Nothing throws and the output stays
 * plausible. On a healthy 45-year-old with a CRP of 1.0 mg/L the equation returns 36.45 years
 * correctly and 38.89 years with the conversion missed — two and a half years of somebody's
 * life, from an absent `/ 10`. `CRP_MGL_TO_MGDL` exists so the division has a name.
 *
 * **Lymphocytes.** The equation wants the **percentage**, not the absolute count, and a full
 * blood count prints both under the bare word "Lymphocytes". `unitNormaliser` now splits them
 * into `lymphocytes_pct` and `lymphocytes_abs` and routes on the reported unit; only the
 * former is read here, and a panel carrying only the absolute count refuses rather than
 * quietly feeding a 1.9 into a coefficient calibrated for a 32.
 *
 * ## Why an acute illness is handled separately from a bad reading
 *
 * CRP rises a hundredfold in an infection. The same healthy 45-year-old, measured mid-chest
 * infection at 60 mg/L, comes out at 40.78 years — **four years and four months added by a
 * cough**. That is not a data error, so it must not be dropped the way `nutritionSafety`
 * drops an unsafe suggestion: the CRP reading is real, clinically meaningful, and belongs on
 * the results screen exactly as measured. What must not happen is turning it into an age. So
 * an acute-phase panel refuses with `reason: 'acute_phase'` and the screen explains why,
 * rather than either hiding the result or ageing somebody for being ill.
 */

/**
 * The nine analytes, in the paper's own order, with the unit each coefficient is calibrated
 * to and the canonical key it arrives under from `unitNormaliser`.
 *
 * `plausible` is a sanity band on the *converted* value, and it is not a reference range —
 * it is far wider than one, deliberately. Its job is to catch a misparsed report, a
 * transposed pair or a value that reached the wrong canonical key, in the same spirit as
 * `bloodPressure`'s refusal to store an 80/120. A reading inside the band but outside a
 * clinical range is a real finding and feeds the equation normally; that is the entire point
 * of the equation.
 */
const PHENOAGE_INPUTS = [
    {
        key: 'albumin', label: 'Albumin', unit: 'g/L',
        coefficient: -0.0336, plausible: [10, 70], reference: 45, modifiable: 'clinical',
    },
    {
        key: 'creatinine', label: 'Creatinine', unit: 'µmol/L',
        coefficient: 0.0095, plausible: [15, 1500],
        // The one analyte here whose healthy value differs enough by sex to matter: muscle
        // mass drives it, so a typical male figure sits about a quarter above a female one.
        // Attributing a woman's creatinine against a male reference would report kidney
        // strain she does not have.
        reference: { male: 85, female: 68, default: 76 }, modifiable: 'clinical',
    },
    {
        key: 'fasting_glucose', label: 'Glucose', unit: 'mmol/L',
        coefficient: 0.1953, plausible: [1.5, 40], reference: 5.0, modifiable: 'behaviour',
    },
    {
        key: 'crp', label: 'C-reactive protein', unit: 'mg/L',
        coefficient: 0.0954, plausible: [0.05, 400], log: true,
        reference: 1.0, modifiable: 'behaviour',
    },
    {
        key: 'lymphocytes_pct', label: 'Lymphocytes', unit: '%',
        coefficient: -0.0120,
        // This band deliberately cannot separate a lymphocyte *percentage* from an absolute
        // *count*, and nothing here can: a 1.9 is a real percentage in profound lymphopenia
        // and a real count in a well person. The separation happens upstream, on the
        // reported unit, in `unitNormaliser`, and `toPanels` drops anything left ambiguous.
        // Narrowing this band to catch the confusion would refuse genuinely ill people.
        plausible: [1, 80], reference: 30, modifiable: 'fixed',
    },
    {
        key: 'mcv', label: 'MCV', unit: 'fL',
        coefficient: 0.0268, plausible: [50, 130], reference: 90, modifiable: 'clinical',
    },
    {
        key: 'rdw', label: 'RDW', unit: '%',
        coefficient: 0.3306, plausible: [8, 35], reference: 13.0, modifiable: 'clinical',
    },
    {
        key: 'alp', label: 'Alkaline phosphatase', unit: 'U/L',
        coefficient: 0.0019, plausible: [5, 1500], reference: 70, modifiable: 'clinical',
    },
    {
        key: 'wbc', label: 'White blood cells', unit: '10^9/L',
        coefficient: 0.0554, plausible: [0.5, 100], reference: 6.0, modifiable: 'clinical',
    },
];

/**
 * The typical value this marker is attributed against, for the person's sex where it matters.
 *
 * `sex` is whatever `User.gender` holds, which is free enough that anything unrecognised has
 * to fall back rather than guess. A default that sits between the two is the honest choice:
 * it under-attributes for both rather than confidently mis-attributing for one.
 */
const referenceFor = (input, sex) => {
    if (typeof input.reference === 'number') return input.reference;
    const key = String(sex || '').trim().toLowerCase();
    return input.reference[key] ?? input.reference.default;
};

const INTERCEPT = -19.9067;
const AGE_COEFFICIENT = 0.0804;

/**
 * Gompertz shape parameter, per month, and the ten-year (120-month) horizon the mortality
 * score is evaluated over. Both are the paper's.
 */
const GAMMA = 0.0076927;
const HORIZON_MONTHS = 120;

/** The two constants that re-express a mortality score as an age in years. */
const AGE_INTERCEPT = 141.50225;
const AGE_SLOPE = 0.090165;

/**
 * The one conversion the canonical units do not already do for us. See the header.
 *
 * Seven of the nine analytes normalise to exactly the unit the equation wants, because both
 * `unitNormaliser` and the paper use SI. CRP is the exception, and it is the one inside a
 * logarithm.
 */
const CRP_MGL_TO_MGDL = 10;

/**
 * C-reactive protein above this is an acute-phase response, not a baseline.
 *
 * 10 mg/L is the conventional line between low-grade inflammation, which is what PhenoAge is
 * reading, and an active infection or injury, which is a transient state the equation has no
 * way to know is transient. See the header for what this costs if it is not caught.
 */
const ACUTE_CRP_MGL = 10;

/**
 * The age range the equation was fitted on, and outside which it is extrapolating rather
 * than estimating.
 *
 * NHANES III and IV adults. There is no version of this that works for a child: every aging
 * model here is trained on adults, growth is not senescence, and an eleven-year-old's blood
 * count is not a young-looking adult's. Above `MAX_AGE` the training data thins to almost
 * nothing and the equation's own extrapolation is worse than silence.
 */
const MIN_AGE = 20;
const MAX_AGE = 90;

/**
 * How far the answer may sit from chronological age before it is clamped.
 *
 * A mis-parsed panel will happily return 118, and the clamp is what stops that reaching a
 * screen. `clamped: true` travels with the result rather than the number quietly differing
 * from the one the equation produced — the call `sleepTargets.CAPS` and `basis.clamped`
 * already make about a bounded sleep goal.
 */
const MAX_DEVIATION_YEARS = 20;

/**
 * How far apart two measurements may sit and still count as one panel.
 *
 * PhenoAge describes a phenotype at a moment. A CRP from January beside an albumin from June
 * is not one, and picking the newest value of each analyte independently would assemble a
 * mosaic of somebody who never existed — while looking, on screen, exactly like a real
 * reading. Seven days is chosen because a full blood count and a metabolic panel from one
 * blood draw routinely reach the patient as two reports dated a few days apart.
 */
const PANEL_WINDOW_DAYS = 7;

const DAY_MS = 86400000;

/**
 * How long a panel stays worth its full weight, and how fast it decays afterwards.
 *
 * A PhenoAge from a panel taken three years ago is an accurate statement about three years
 * ago. The decay is the argument `REPORTED_HALF_LIFE_DAYS` already makes in `labtrackScore`
 * about questionnaire answers, moved to a slower clock because bloods move more slowly than
 * habits do. Past `STALE_AFTER_DAYS` the weight is zero and the screen says the panel is old,
 * rather than showing nothing and leaving somebody to wonder where their number went.
 */
const FRESH_DAYS = 180;
const FRESHNESS_HALF_LIFE_DAYS = 365;
const STALE_AFTER_DAYS = 730;

/**
 * Bands for the gap between biological and chronological age.
 *
 * Neutral by construction, and there is no red. `sleepScore.js` refuses to call its bottom
 * band "Insomniac" and `labtrackScore.js` refuses to call its bottom band "Critical", both
 * for the reason that applies twice over here: this is a summary of a blood test, the person
 * reading it did not choose their genes, and a colour that reads as an alarm turns a number
 * into a verdict on somebody's body.
 */
const DELTA_BANDS = [
    { key: 'younger', label: 'Younger than your age', max: -2 },
    { key: 'on_track', label: 'In step with your age', max: 2 },
    { key: 'older', label: 'Older than your age', max: Infinity },
];

const bandFor = (delta) => DELTA_BANDS.find((b) => delta <= b.max) || null;

/**
 * Travels with every result, and **says which of the two halves the person is looking at**.
 *
 * Not a footnote. The two halves are not equally well founded — one is a published equation
 * validated against mortality follow-up, the other is an aggregation of individual hazard
 * ratios whose composite has never been validated — and a single sentence covering both
 * would have to be either wrong about one or vague about both.
 *
 * It also has to be *true*: the first version of this said "from one set of blood results",
 * which is a false statement to put under a number computed entirely from somebody's watch.
 *
 * Every variant refuses the same two claims explicitly, because they are the two people read
 * into a number like this one whatever it is labelled: that it is a diagnosis, and that it
 * says how long they have.
 */
const DISCLAIMERS = {
    lab:
        'This is an estimate from one set of blood results, using a published research method. '
        + 'It is not a diagnosis, it does not predict how long you will live, and it cannot see '
        + 'anything your blood test did not measure. Discuss anything that concerns you with a '
        + 'clinician.',
    lifestyle:
        'This is an estimate from your activity, sleep and vitals over the last six months. It '
        + 'combines published research on each of those separately — the combination itself has '
        + 'not been tested against real outcomes. It is not a diagnosis and it does not predict '
        + 'how long you will live. Discuss anything that concerns you with a clinician.',
    blended:
        'This combines an estimate from your blood results, using a published research method, '
        + 'with one from your activity, sleep and vitals over the last six months. The second '
        + 'part combines published research on each of those separately, and that combination '
        + 'has not been tested against real outcomes. It is not a diagnosis and it does not '
        + 'predict how long you will live. Discuss anything that concerns you with a clinician.',
};

/** The lab half's wording, which is what the lab half alone carries. */
const AGE_DISCLAIMER = DISCLAIMERS.lab;

const disclaimerFor = (source) => DISCLAIMERS[source] || DISCLAIMERS.blended;

const refusal = (reason, message, extra = {}) => ({ ok: false, reason, message, ...extra });

/**
 * The equation, on values already in the units `PHENOAGE_INPUTS` names.
 *
 * Pure: no database, no clock it was not handed, no rounding beyond the final presentation.
 * Takes the nine markers by canonical key and the chronological age; returns the age in
 * years, the per-marker contributions, and nothing else.
 *
 * @param {number} chronologicalAge years
 * @param {Record<string, number>} markers canonical key → value in its canonical unit
 */
const phenoAge = (chronologicalAge, markers) => {
    let xb = INTERCEPT + AGE_COEFFICIENT * chronologicalAge;

    for (const input of PHENOAGE_INPUTS) {
        const raw = markers[input.key];
        // CRP is the only analyte whose canonical unit is not the equation's. See the header.
        const value = input.key === 'crp' ? raw / CRP_MGL_TO_MGDL : raw;
        xb += input.coefficient * (input.log ? Math.log(value) : value);
    }

    /**
     * The ten-year mortality probability.
     *
     * Deliberately a local. It does not go into the returned object, it is not logged, and
     * there is a test asserting it reaches no response. See the header.
     */
    const mortality = 1 - Math.exp(
        -Math.exp(xb) * (Math.exp(HORIZON_MONTHS * GAMMA) - 1) / GAMMA,
    );

    return AGE_INTERCEPT + Math.log(-0.00553 * Math.log(1 - mortality)) / AGE_SLOPE;
};

/**
 * What each marker is doing to the answer, in years.
 *
 * **A counterfactual, not a share of the sum.** The obvious implementation — divide each
 * marker's term in `xb` by the slope — produces numbers that look like an attribution and
 * are not one: a term carries the marker's whole magnitude rather than its distance from
 * anything, so RDW reports "+47 years" for a perfectly normal 12.8 % simply because 12.8
 * multiplied by the largest coefficient in the equation is a large number. On a screen that
 * is worse than no attribution at all, because it is ranked and it looks deliberate.
 *
 * So each marker is answered by re-running the whole equation with that marker replaced by
 * its reference value and taking the difference. That is exact rather than linearised — the
 * mortality-to-age transform is not linear, so the shortcut would be wrong even after
 * centring — and it is the same operation the lever list will need: "what would this be
 * worth if this one number moved".
 *
 * Positive years mean the marker is adding age relative to a typical value.
 *
 * **They do not sum to the total, and a screen must not present them as though they do.**
 * Each is answered with every other marker held where it actually is, and the transform is
 * non-linear, so two markers that are each worth three years are not jointly worth six. This
 * is the right trade — an attribution that is individually true and collectively unadditive
 * is more useful than one that adds up and is individually wrong — but a stacked bar summing
 * to the delta would be drawing a fact that is not in this array.
 */
const attribute = (chronologicalAge, markers, sex) => {
    const base = phenoAge(chronologicalAge, markers);

    return PHENOAGE_INPUTS.map((input) => {
        const reference = referenceFor(input, sex);
        const counterfactual = phenoAge(chronologicalAge, { ...markers, [input.key]: reference });
        return {
            key: input.key,
            label: input.label,
            value: markers[input.key],
            unit: input.unit,
            reference,
            modifiable: input.modifiable,
            /** Years this marker adds (or removes) versus a typical value for this person. */
            years: Number((base - counterfactual).toFixed(2)),
        };
    }).sort((a, b) => b.years - a.years);
};

/**
 * Run the equation against one panel, with every guard in front of it.
 *
 * @returns {{ok: true, ...}|{ok: false, reason: string, message: string}}
 *   A refusal is a normal outcome, not an error — most people will not have all nine
 *   analytes on file — and it carries the reason so a screen can say what is missing rather
 *   than drawing an empty state that looks like a fault.
 */
const evaluatePanel = ({ chronologicalAge, markers, measuredAt, sex = null }) => {
    if (!Number.isFinite(chronologicalAge)) {
        return refusal('no_age', 'We need your date of birth before we can work this out.');
    }
    if (chronologicalAge < MIN_AGE) {
        return refusal(
            'too_young',
            `This method was developed for adults aged ${MIN_AGE} and over, so we do not show it below that age.`,
            { minAge: MIN_AGE },
        );
    }
    if (chronologicalAge > MAX_AGE) {
        return refusal(
            'out_of_range',
            `This method was developed on adults up to about ${MAX_AGE}, so we do not show it above that age.`,
            { maxAge: MAX_AGE },
        );
    }

    const missing = PHENOAGE_INPUTS
        .filter((i) => !Number.isFinite(markers[i.key]))
        .map((i) => ({ key: i.key, label: i.label }));

    if (missing.length) {
        return refusal(
            'incomplete_panel',
            missing.length === PHENOAGE_INPUTS.length
                ? 'Upload a blood test with a full blood count, a metabolic panel and CRP, and we can work this out.'
                : `Your results are missing ${missing.map((m) => m.label).join(', ')}.`,
            { missing, need: PHENOAGE_INPUTS.length, have: PHENOAGE_INPUTS.length - missing.length },
        );
    }

    const implausible = PHENOAGE_INPUTS.filter((i) => {
        const v = markers[i.key];
        return v < i.plausible[0] || v > i.plausible[1];
    }).map((i) => ({ key: i.key, label: i.label, value: markers[i.key], unit: i.unit }));

    if (implausible.length) {
        return refusal(
            'implausible',
            'Some of these results are outside the range this method can read, so we have not '
            + 'estimated an age from them. That usually means a value was recorded in a '
            + 'different unit.',
            { implausible },
        );
    }

    // Checked after plausibility so a mis-parsed CRP is reported as a parsing problem rather
    // than as an infection somebody does not have.
    if (markers.crp > ACUTE_CRP_MGL) {
        return refusal(
            'acute_phase',
            'Your CRP was high when this sample was taken, which usually means your body was '
            + 'fighting something off. That raises this estimate by years on its own, so we '
            + 'have not shown one. A repeat test once you are well will give a truer picture.',
            { crp: markers.crp, threshold: ACUTE_CRP_MGL },
        );
    }

    const years = phenoAge(chronologicalAge, markers);

    if (!Number.isFinite(years)) {
        return refusal('not_computable', 'We could not work out an age from these results.');
    }

    const floor = chronologicalAge - MAX_DEVIATION_YEARS;
    const ceiling = chronologicalAge + MAX_DEVIATION_YEARS;
    const clamped = years < floor || years > ceiling;
    const value = Math.min(ceiling, Math.max(floor, years));

    const delta = value - chronologicalAge;
    const band = bandFor(delta);

    return {
        ok: true,
        source: 'lab',
        method: 'phenoage',
        value: Number(value.toFixed(1)),
        chronologicalAge: Number(chronologicalAge.toFixed(1)),
        delta: Number(delta.toFixed(1)),
        band: band?.key ?? null,
        bandLabel: band?.label ?? null,
        clamped,
        measuredAt: measuredAt ?? null,
        freshness: freshness(measuredAt),
        /** Ranked worst first. See `attribute` for why these are counterfactuals. */
        contributions: attribute(chronologicalAge, markers, sex),
        disclaimer: AGE_DISCLAIMER,
    };
};

/**
 * How much a panel of a given age is still worth, 0–1.
 *
 * Full weight inside `FRESH_DAYS`, half-life thereafter, zero past `STALE_AFTER_DAYS`.
 */
const freshness = (measuredAt) => {
    if (!measuredAt) return { weight: 0, ageDays: null, stale: true };
    const ageDays = (Date.now() - new Date(measuredAt).getTime()) / DAY_MS;
    if (!Number.isFinite(ageDays) || ageDays < 0) return { weight: 1, ageDays: 0, stale: false };
    if (ageDays > STALE_AFTER_DAYS) return { weight: 0, ageDays: Math.round(ageDays), stale: true };
    const weight = ageDays <= FRESH_DAYS
        ? 1
        : Math.pow(0.5, (ageDays - FRESH_DAYS) / FRESHNESS_HALF_LIFE_DAYS);
    return { weight: Number(weight.toFixed(4)), ageDays: Math.round(ageDays), stale: false };
};

/**
 * Group measurements into panels and return them newest first.
 *
 * A panel is every measurement within `PANEL_WINDOW_DAYS` of its newest member. See the
 * constant for why the alternative — newest value of each analyte independently — is not
 * merely less accurate but actively misleading.
 *
 * Rows marked `needsReview` are excluded outright. That flag means `unitNormaliser` could not
 * recognise the unit, so the value is a number of unknown scale; it is exactly the state a
 * unitless "Lymphocytes 1.9" lands in, and it is the last guard between that and an equation
 * expecting a percentage.
 */
const toPanels = (measurements = []) => {
    const usable = measurements
        .filter((m) => m && !m.needsReview && Number.isFinite(Number(m.value)) && m.measuredAt)
        .map((m) => ({
            name: m.name,
            value: Number(m.value),
            measuredAt: new Date(m.measuredAt),
        }))
        .filter((m) => !Number.isNaN(m.measuredAt.getTime()))
        .sort((a, b) => b.measuredAt - a.measuredAt);

    const panels = [];
    let current = null;

    for (const m of usable) {
        if (!current || current.measuredAt - m.measuredAt > PANEL_WINDOW_DAYS * DAY_MS) {
            current = { measuredAt: m.measuredAt, markers: {} };
            panels.push(current);
        }
        // Newest wins inside a panel: `usable` is sorted, so the first write is the newest.
        if (!(m.name in current.markers)) current.markers[m.name] = m.value;
    }

    return panels;
};

/**
 * The lab age for one person, from their biomarker history.
 *
 * Walks panels newest first and returns the first that produces an answer, so a recent
 * incomplete panel does not hide a complete one from six weeks earlier. The refusal returned
 * when nothing qualifies is the **newest** panel's, because that is the one the person is
 * looking at and the one whose missing marker they can do something about.
 *
 * @param {Array} measurements `Biomarker`-shaped rows: { name, value, measuredAt, needsReview }
 */
const labAge = ({ chronologicalAge, measurements = [], sex = null }) => {
    const panels = toPanels(measurements);

    if (!panels.length) {
        return refusal(
            'no_results',
            'Upload a blood test with a full blood count, a metabolic panel and CRP, and we can work this out.',
            { missing: PHENOAGE_INPUTS.map((i) => ({ key: i.key, label: i.label })) },
        );
    }

    let first = null;
    for (const panel of panels) {
        const result = evaluatePanel({
            chronologicalAge,
            markers: panel.markers,
            measuredAt: panel.measuredAt,
            sex,
        });
        if (result.ok) return result;
        if (!first) first = result;
        // An age refusal is about the person, not the panel, so no later panel can fix it.
        if (['too_young', 'out_of_range', 'no_age'].includes(result.reason)) return result;
    }
    return first;
};

/**
 * How much each half is worth before freshness and coverage are applied.
 *
 * The lab half leads because it is the one with a paper behind it: PhenoAge is published,
 * peer-reviewed and validated against mortality follow-up, and the behavioural half is an
 * aggregation of individual hazard ratios whose *composite* has never been validated against
 * anything. Weighting them equally would imply a parity that does not exist.
 *
 * It is not a landslide, though, and it should not be. A six-month behavioural picture is
 * current, continuous and about things somebody can change this week; a blood panel is one
 * morning, months ago, and says nothing about what has happened since.
 */
const LAB_BASE = 1.0;
const LIFESTYLE_BASE = 0.7;

/** Every domain the behavioural half can cover. Its weight scales with how many it saw. */
const LIFESTYLE_DOMAINS = 4;

/**
 * Combine the two halves.
 *
 * **`source` is the whole point, and it is rendered.** A person with fresh bloods and a
 * person with only a watch must not be shown the same kind of number with no way to tell
 * them apart — the argument pillar provenance already makes on the score breakdown, where
 * `observed` and `reported` are drawn as a chip rather than quietly averaged.
 *
 * One half present is the answer, and the screen names it. Neither is **null**, never a
 * number: a biological age assembled out of nothing is the one output this feature must not
 * produce, because unlike a missing score it reads as a reassurance.
 *
 * @param {Object} lab the result of `labAge`, or a refusal
 * @param {Object} lifestyle the result of `lifestyleAge`, or a refusal
 */
const blend = ({ lab, lifestyle, chronologicalAge }) => {
    const halves = [];

    if (lab?.ok) {
        const weight = LAB_BASE * (lab.freshness?.weight ?? 0);
        if (weight > 0) halves.push({ half: lab, weight });
    }

    if (lifestyle?.ok) {
        const covered = lifestyle.coverage?.domains?.length ?? 0;
        halves.push({ half: lifestyle, weight: LIFESTYLE_BASE * (covered / LIFESTYLE_DOMAINS) });
    }

    if (!halves.length) {
        return {
            ok: false,
            reason: 'no_inputs',
            // Whichever refusal is more actionable leads: a missing blood test is a thing
            // somebody can go and do, and an insufficient window is a thing that fills in.
            message: lab?.message || lifestyle?.message
                || 'Upload a blood test or connect a watch, and we can work this out.',
            lab: lab ?? null,
            lifestyle: lifestyle ?? null,
            disclaimer: DISCLAIMERS.blended,
        };
    }

    const totalWeight = halves.reduce((sum, h) => sum + h.weight, 0);
    const value = halves.reduce((sum, h) => sum + h.half.value * h.weight, 0) / totalWeight;
    const delta = value - chronologicalAge;
    const band = bandFor(delta);

    const source = halves.length === 2 ? 'blended' : halves[0].half.source;

    return {
        ok: true,
        source,
        value: Number(value.toFixed(1)),
        chronologicalAge: Number(chronologicalAge.toFixed(1)),
        delta: Number(delta.toFixed(1)),
        band: band?.key ?? null,
        bandLabel: band?.label ?? null,
        /**
         * Both halves in full, always, including the one that refused.
         *
         * A screen has to be able to say "this is your bloods only, connect a watch" or
         * "your bloods are eighteen months old", and neither sentence is derivable from a
         * blended number alone.
         */
        lab: lab ?? null,
        lifestyle: lifestyle ?? null,
        weights: Object.fromEntries(
            halves.map((h) => [h.half.source, Number((h.weight / totalWeight).toFixed(3))]),
        ),
        disclaimer: disclaimerFor(source),
    };
};

/* ------------------------------------------------------------------ *
 * Pace of aging
 * ------------------------------------------------------------------ */

/**
 * How many snapshots, over how long, before the pace is measured rather than estimated.
 *
 * Eight weeks and five snapshots. Below that the slope of four points a fortnight apart is
 * noise with a direction, and a pace is the one number here that people will read as a
 * verdict on the last month of their life.
 */
const PACE_MIN_SNAPSHOTS = 5;
const PACE_MIN_SPAN_DAYS = 56;

/**
 * The reported range, matching the scale the design draws.
 *
 * Below zero means the gap is closing faster than the calendar opens it — somebody is
 * getting biologically younger in absolute terms, which is uncommon and real. Three is the
 * top of the scale rather than a claim that nobody ages faster.
 */
const PACE_BOUNDS = [-1, 3];

const DAYS_PER_YEAR = 365.2425;

/**
 * Pace of aging, from the snapshot series.
 *
 * **Fitted to `delta`, not to `value`, and that is the whole correctness of it.**
 *
 * The obvious implementation regresses the biological age itself against calendar time. It
 * is wrong in a way that is invisible: the biological age of somebody whose life has not
 * changed at all still rises, because chronological age is an input to both halves — so a
 * static person's slope is not zero, it is *about* one, and "about" is doing a lot of work.
 * The lifestyle half moves at exactly 1.0 years per year when the behaviour is unchanged, but
 * PhenoAge does not: its age coefficient over its slope constant is roughly 0.89, so a person
 * with steady bloods drifts at 0.89 and a person with steady habits at 1.00. A pace built on
 * `value` would therefore read a little under 1.0x for everybody with labs and a clean 1.0x
 * for everybody without, and the difference would look like a finding about their health.
 *
 * `delta` has no such term. It is the gap between biological and chronological age, both of
 * which advance together, so a person whose life is unchanged holds a flat delta whatever
 * their evidence is made of. Hence:
 *
 *     pace = 1 + d(delta)/d(calendar year)
 *
 * which is exactly 1.0x for a static person, 0.5x for somebody closing the gap by half a
 * year per year, and 2.0x for somebody opening it by one.
 *
 * ## Which delta, and why it is usually the behavioural one
 *
 * `basis.half` says which series was fitted, and the choice matters more than it looks.
 *
 * The blended delta moves in **steps**, because the lab half only changes on the day a new
 * blood panel arrives and is a flat line in between. Fit a slope through a step and the
 * answer is mostly the step: somebody whose January bloods said +2 and whose June bloods say
 * +6 produces a fitted rate of about ten years per year, which the bounds then clamp to the
 * top of the scale. That is not a person aging three times over — it is two measurements of
 * a noisy quantity, four months apart, being read as a trajectory.
 *
 * The behavioural delta has no steps. It is recomputed daily from a rolling six-month window,
 * so it genuinely is a continuous quantity and its slope genuinely is a rate. Where enough
 * snapshots carry one, it is what gets fitted. The blended series is the fallback, for
 * somebody whose evidence is bloods alone, and it carries the same caveat — which is why
 * `basis.half` is returned rather than assumed.
 *
 * @param {Array} snapshots `BiologicalAge` rows: { delta, halves[], computedAt }
 * @param {Function} forecast `predictionForecast.forecast`
 */
const paceFrom = (snapshots = [], { forecast } = {}) => {
    const usable = snapshots.filter((s) => s?.computedAt);

    const lifestyleSeries = usable
        .map((s) => {
            const half = (s.halves || []).find((h) => h.source === 'lifestyle' && h.ok);
            return Number.isFinite(half?.delta) ? { at: s.computedAt, value: half.delta } : null;
        })
        .filter(Boolean);

    const blendedSeries = usable
        .filter((s) => Number.isFinite(s.delta))
        .map((s) => ({ at: s.computedAt, value: s.delta }));

    const useLifestyle = lifestyleSeries.length >= PACE_MIN_SNAPSHOTS;
    const half = useLifestyle ? 'lifestyle' : 'blended';
    const points = (useLifestyle ? lifestyleSeries : blendedSeries)
        .sort((a, b) => new Date(a.at) - new Date(b.at));

    if (points.length < PACE_MIN_SNAPSHOTS) {
        return {
            ok: false,
            state: 'unknown',
            reason: 'too_few',
            have: points.length,
            need: PACE_MIN_SNAPSHOTS,
            message: 'We need a few more weeks of readings before we can say which way this '
                + 'is moving.',
        };
    }

    const spanDays = (new Date(points[points.length - 1].at) - new Date(points[0].at)) / DAY_MS;
    if (spanDays < PACE_MIN_SPAN_DAYS) {
        return {
            ok: false,
            state: 'unknown',
            reason: 'too_short',
            have: Math.round(spanDays),
            need: PACE_MIN_SPAN_DAYS,
            message: `We have ${Math.round(spanDays)} days of readings. A couple more months `
                + 'and we can tell you how fast this is moving.',
        };
    }

    const fitted = forecast(points, { horizonDays: 1, decimals: 2 });
    if (!fitted) {
        return {
            ok: false, state: 'unknown', reason: 'not_computable',
            message: 'We could not work out a direction from your readings yet.',
        };
    }

    const raw = 1 + fitted.slopePerDay * DAYS_PER_YEAR;
    const value = Math.max(PACE_BOUNDS[0], Math.min(PACE_BOUNDS[1], raw));

    return {
        ok: true,
        state: 'measured',
        value: Number(value.toFixed(2)),
        clamped: raw !== value,
        bounds: PACE_BOUNDS,
        confidence: fitted.confidence,
        basis: {
            snapshots: points.length,
            spanDays: Math.round(spanDays),
            /** Which series was fitted. A blended fit can carry a panel's step change. */
            half,
        },
    };
};

/**
 * The fallback, for somebody who has not been using Predyqt long enough to have a slope.
 *
 * Whoop's own pace compares the last thirty days against the current age, and this is the
 * same idea: recompute the behavioural half over a thirty-day window and ask how it differs
 * from the six-month picture.
 *
 * **It answers a different question from the measured pace, and it is labelled differently
 * for that reason.** A measured pace says "your biological age is actually moving at this
 * rate". This says "if the last month became your new normal, the gap would move by this much
 * over a year" — a projection from one month of behaviour, not an observation of change.
 *
 * Scaling it to one year rather than to the 75 days that actually separate the two windows'
 * centres is deliberate. The shorter separation is arithmetically defensible and multiplies
 * the difference by almost five, which turns one good fortnight into a headline claim about
 * somebody's rate of aging. A one-year scale is the conservative reading of the same gap.
 */
const provisionalPace = ({ recent, window }) => {
    if (!recent?.ok || !window?.ok) {
        return {
            ok: false, state: 'unknown', reason: 'no_windows',
            message: 'We need a few more weeks of readings before we can say which way this '
                + 'is moving.',
        };
    }

    const raw = 1 + (recent.delta - window.delta);
    const value = Math.max(PACE_BOUNDS[0], Math.min(PACE_BOUNDS[1], raw));

    return {
        ok: true,
        state: 'provisional',
        value: Number(value.toFixed(2)),
        clamped: raw !== value,
        bounds: PACE_BOUNDS,
        /** Never inherited from a fit, because there is no fit. */
        confidence: null,
        basis: {
            recentDelta: recent.delta,
            windowDelta: window.delta,
            recentDays: recent.windowDays,
            windowDays: window.windowDays,
        },
        message: 'Based on your last month compared with your last six, rather than on how '
            + 'your age has actually moved. It will firm up as you keep logging.',
    };
};

/* ------------------------------------------------------------------ *
 * Levers
 * ------------------------------------------------------------------ */

/** The most levers a screen is given. See `LEVER_LIMIT` for why it is three. */
const LEVER_LIMIT = 3;

/**
 * What would actually move the number, ranked by how much.
 *
 * Computable exactly because both halves are deterministic: set one input to its target,
 * re-run, take the difference. The same operation `attribute` performs against a reference,
 * pointed at a goal instead.
 *
 * Four rules, and each removes a way this becomes useless:
 *
 * 1. **Only movable contributors.** Every contributor declares
 *    `modifiable: 'behaviour' | 'clinical' | 'fixed'`, and a `fixed` one never becomes a
 *    lever. "Lower your red cell distribution width" is advice nobody can act on, which is
 *    the dead end `PILLAR_ROUTE` exists to prevent on the score screen. A `clinical` one is
 *    kept, but it is a conversation to have rather than a task to do, and it routes
 *    accordingly.
 * 2. **Weighted by the half's share of the blend.** A marker worth two years of lab age is
 *    worth two years times the lab half's weight on the blended number. Reporting the
 *    unweighted figure would promise somebody a change the screen above it cannot deliver.
 * 3. **Only what helps.** A contributor already better than its target produces a negative
 *    saving and is dropped, rather than being shown as a thing to give up.
 * 4. **Three at most.** A list of nine things somebody could do about their mortality is a
 *    backlog, and a backlog is a thing people learn to scroll past. The cap "Needs you"
 *    already takes on the home screen, for the same reason.
 */
const levers = ({
    chronologicalAge, sex = null, markers = null, inputs = null,
    lab = null, lifestyle = null, weights = {}, limit = LEVER_LIMIT,
    lifestyleFn = null,
}) => {
    const out = [];

    if (lab?.ok && markers) {
        const share = weights.lab ?? 1;
        const base = phenoAge(chronologicalAge, markers);

        for (const input of PHENOAGE_INPUTS) {
            if (input.modifiable === 'fixed') continue;
            const target = referenceFor(input, sex);
            const improved = phenoAge(chronologicalAge, { ...markers, [input.key]: target });
            const years = (base - improved) * share;
            if (years <= 0.05) continue;

            out.push({
                key: input.key,
                label: input.label,
                half: 'lab',
                value: markers[input.key],
                unit: input.unit,
                target,
                modifiable: input.modifiable,
                /**
                 * Every lab lever is a conversation, not a control on a tracker screen —
                 * there is no button in this app that lowers somebody's glucose. The path
                 * is the group-qualified one: `/results` is not a route, and a bad
                 * `router.push` throws nothing and goes nowhere.
                 */
                route: '/(tabs)/results',
                years: Number(years.toFixed(2)),
            });
        }
    }

    if (lifestyle?.ok && inputs && lifestyleFn) {
        const share = weights.lifestyle ?? 1;
        const base = lifestyle.value;

        for (const c of lifestyle.contributions) {
            if (c.modifiable === 'fixed') continue;
            const contributor = lifestyleFn.CONTRIBUTOR_BY_KEY[c.key];
            if (!contributor) continue;

            const target = contributor.target({ age: chronologicalAge, sex });
            const improved = lifestyleFn.lifestyleAge({
                chronologicalAge,
                sex,
                inputs: { ...inputs, [c.key]: { ...inputs[c.key], value: target } },
            });
            if (!improved.ok) continue;

            const years = (base - improved.value) * share;
            if (years <= 0.05) continue;

            out.push({
                key: c.key,
                label: c.label,
                half: 'lifestyle',
                value: c.value,
                display: c.display,
                unit: c.unit,
                target: c.target,
                modifiable: c.modifiable,
                route: c.route,
                years: Number(years.toFixed(2)),
            });
        }
    }

    return out.sort((a, b) => b.years - a.years).slice(0, limit);
};

module.exports = {
    paceFrom,
    provisionalPace,
    levers,
    PACE_MIN_SNAPSHOTS,
    PACE_MIN_SPAN_DAYS,
    PACE_BOUNDS,
    LEVER_LIMIT,
    blend,
    LAB_BASE,
    LIFESTYLE_BASE,
    PHENOAGE_INPUTS,
    DELTA_BANDS,
    AGE_DISCLAIMER,
    DISCLAIMERS,
    disclaimerFor,
    phenoAge,
    attribute,
    referenceFor,
    evaluatePanel,
    labAge,
    freshness,
    bandFor,
    MIN_AGE,
    MAX_AGE,
    ACUTE_CRP_MGL,
    MAX_DEVIATION_YEARS,
    PANEL_WINDOW_DAYS,
    FRESH_DAYS,
    STALE_AFTER_DAYS,
    CRP_MGL_TO_MGDL,
    // Exported for the tests, which assert the grouping in isolation.
    _toPanels: toPanels,
};
