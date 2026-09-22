/**
 * Miovix Age — the lab half.
 *
 * Every failure this file guards against is silent. The equation returns a plausible number
 * from wrong units, from a misparsed report, from somebody who happens to have a cold, and
 * from a panel assembled out of measurements taken months apart. Nothing throws in any of
 * those cases, and the result reaches a screen looking exactly like a real one — which is
 * why the assertions below are mostly about *refusing*, not about computing.
 */
const bio = require('../utils/biologicalAge');
const { normaliseMeasurement } = require('../utils/unitNormaliser');

/** A well 45-year-old, every analyte mid-range, in canonical units. */
const WELL = {
    albumin: 45, creatinine: 80, fasting_glucose: 5.0, crp: 1.0,
    lymphocytes_pct: 32, mcv: 90, rdw: 12.8, alp: 70, wbc: 6.0,
};

const panel = (overrides = {}, age = 45) => bio.evaluatePanel({
    chronologicalAge: age,
    markers: { ...WELL, ...overrides },
    measuredAt: new Date(),
    sex: 'male',
});

describe('the equation', () => {
    it('reproduces the published Levine PhenoAge for a known panel', () => {
        // Computed from the coefficients in Liu et al. 2018 (PLOS Medicine), Table 1, with
        // the Gompertz transform at 120 months. Pinned to a tenth of a year: if this moves,
        // a coefficient or a constant moved with it.
        expect(bio.phenoAge(45, WELL)).toBeCloseTo(36.45, 1);
    });

    it('is monotone in the markers the paper weights upward', () => {
        const base = bio.phenoAge(45, WELL);
        expect(bio.phenoAge(45, { ...WELL, rdw: 15.5 })).toBeGreaterThan(base);
        expect(bio.phenoAge(45, { ...WELL, fasting_glucose: 8.0 })).toBeGreaterThan(base);
        // Albumin and lymphocyte percent carry negative coefficients: more is younger.
        expect(bio.phenoAge(45, { ...WELL, albumin: 50 })).toBeLessThan(base);
        expect(bio.phenoAge(45, { ...WELL, lymphocytes_pct: 40 })).toBeLessThan(base);
    });

    it('moves with chronological age', () => {
        expect(bio.phenoAge(60, WELL)).toBeGreaterThan(bio.phenoAge(45, WELL));
    });
});

describe('units', () => {
    /**
     * The single highest-consequence line in the module.
     *
     * `unitNormaliser` canonicalises CRP to mg/L; the equation is calibrated to mg/dL, and
     * the value goes through a logarithm. Passing the canonical value straight through adds
     * ln(10) x 0.0954 to xb, throws nothing, and produces a number that looks right.
     */
    it('reads CRP in mg/dL although the catalogue stores mg/L', () => {
        expect(bio.CRP_MGL_TO_MGDL).toBe(10);

        const correct = bio.phenoAge(45, WELL);                       // 1.0 mg/L -> 0.1 mg/dL
        // What the same call would produce if the division were dropped: feed it a value ten
        // times larger, which is what mg/L looks like to an equation expecting mg/dL.
        const asIfUnconverted = bio.phenoAge(45, { ...WELL, crp: 10 });

        expect(asIfUnconverted - correct).toBeGreaterThan(2);
        expect(correct).toBeCloseTo(36.45, 1);
    });

    it('reads the lymphocyte percentage, never the absolute count', () => {
        const input = bio.PHENOAGE_INPUTS.find((i) => i.key === 'lymphocytes_pct');
        expect(input).toBeDefined();
        expect(input.unit).toBe('%');
        expect(bio.PHENOAGE_INPUTS.map((i) => i.key)).not.toContain('lymphocytes_abs');
    });

    it('takes every other analyte in the unit the catalogue already canonicalises to', () => {
        // Seven of the nine line up because both the catalogue and the paper use SI. That is
        // load-bearing: if a canonical unit is ever changed, this fails rather than silently
        // re-scaling somebody's biological age.
        const expected = {
            albumin: 'g/L', creatinine: 'µmol/L', fasting_glucose: 'mmol/L',
            mcv: 'fL', alp: 'U/L', wbc: '10^9/L', rdw: '%',
        };
        for (const [key, unit] of Object.entries(expected)) {
            expect(bio.PHENOAGE_INPUTS.find((i) => i.key === key).unit).toBe(unit);
        }
    });

    it('routes a lymphocyte row on its reported unit, not on its name', () => {
        // The catalogue's half of the same guard: a full blood count prints both under the
        // bare word "Lymphocytes", and only the unit tells them apart.
        expect(normaliseMeasurement({ name: 'Lymphocytes', value: 32, unit: '%' }).name)
            .toBe('lymphocytes_pct');
        expect(normaliseMeasurement({ name: 'Lymphocytes', value: 1.9, unit: 'x10^9/L' }).name)
            .toBe('lymphocytes_abs');
    });

    it('marks a unitless lymphocyte row for review rather than assuming a percentage', () => {
        // This is what keeps a 1.9 out of a coefficient calibrated for a 32. No plausibility
        // band can do it — 1.9 is a real percentage in profound lymphopenia — so the row has
        // to be refused on the missing unit instead.
        const row = normaliseMeasurement({ name: 'Lymphocytes', value: 1.9 });
        expect(row.needsReview).toBe(true);
    });
});

describe('the mortality score never leaves the module', () => {
    /**
     * PhenoAge works through a ten-year all-cause mortality probability. It is the most
     * engaging number in the product and it must never reach a person. See the module header.
     */
    it('is absent from a successful result', () => {
        const result = panel();
        expect(result.ok).toBe(true);
        const serialised = JSON.stringify(result).toLowerCase();
        expect(serialised).not.toMatch(/mortalit|death|survival|life ?expectancy/);
        for (const key of ['mortality', 'mortalityScore', 'M', 'risk', 'hazard']) {
            expect(result).not.toHaveProperty(key);
        }
    });

    it('is absent from every refusal too', () => {
        const refusals = [
            panel({}, 12),
            panel({ crp: 60 }),
            panel({ rdw: undefined }),
            bio.labAge({ chronologicalAge: 45, measurements: [] }),
        ];
        for (const r of refusals) {
            expect(JSON.stringify(r).toLowerCase()).not.toMatch(/mortalit|death|survival/);
        }
    });

    it('returns a number from phenoAge, not an object that could carry one', () => {
        expect(typeof bio.phenoAge(45, WELL)).toBe('number');
    });
});

describe('refusals', () => {
    it('refuses below the age the method was developed for', () => {
        const r = panel({}, 14);
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('too_young');
        expect(r.message).toMatch(/adults/i);
    });

    it('refuses above it', () => {
        expect(panel({}, 96).reason).toBe('out_of_range');
    });

    it('refuses without a date of birth', () => {
        expect(bio.evaluatePanel({ markers: WELL }).reason).toBe('no_age');
    });

    it('never imputes a missing analyte, and names what is missing', () => {
        // Substituting a population mean produces a number that is mostly the population
        // mean wearing somebody's name, and it is indistinguishable from a real result.
        const r = panel({ rdw: undefined, crp: undefined });
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('incomplete_panel');
        expect(r.missing.map((m) => m.key).sort()).toEqual(['crp', 'rdw']);
        expect(r.have).toBe(7);
        expect(r.need).toBe(9);
    });

    it('refuses a value outside the range the method can read', () => {
        // A glucose recorded in mg/dL that never reached the converter: 90 is a normal
        // fasting glucose in mg/dL and an impossible one in mmol/L.
        const r = panel({ fasting_glucose: 90 });
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('implausible');
        expect(r.implausible[0].key).toBe('fasting_glucose');
        expect(r.message).toMatch(/unit/i);
    });

    it('withholds an age during an acute-phase response, and says why', () => {
        const r = panel({ crp: 60 });
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('acute_phase');
        // Not "your result is wrong" — the CRP is real and belongs on the results screen.
        // What must not happen is ageing somebody four years for having an infection.
        expect(r.message).toMatch(/fighting something off/i);
        expect(r.threshold).toBe(bio.ACUTE_CRP_MGL);
    });

    it('quantifies why the acute-phase guard exists', () => {
        const well = bio.phenoAge(45, WELL);
        const ill = bio.phenoAge(45, { ...WELL, crp: 60 });
        expect(ill - well).toBeGreaterThan(4);
    });

    it('reports a misparsed CRP as a parsing problem, not as an infection', () => {
        // Ordering matters: plausibility is checked before the acute-phase guard, so a CRP
        // of 900 reads as a unit error rather than telling somebody they are gravely ill.
        expect(panel({ crp: 900 }).reason).toBe('implausible');
    });
});

describe('bounds', () => {
    it('clamps to a bounded distance from chronological age and says that it did', () => {
        // An unclamped equation off a mis-parsed panel will happily return a number nobody
        // could be. The clamp is visible rather than the value quietly differing from what
        // the equation produced.
        const r = panel({ albumin: 68, lymphocytes_pct: 78, rdw: 8.2 }, 75);
        expect(r.ok).toBe(true);
        expect(r.clamped).toBe(true);
        expect(r.value).toBe(75 - bio.MAX_DEVIATION_YEARS);
    });

    it('does not claim to have clamped an ordinary result', () => {
        expect(panel().clamped).toBe(false);
    });

    it('bands the gap without an alarming one', () => {
        // A summary of a blood test, read by somebody who did not choose their genes.
        const labels = bio.DELTA_BANDS.map((b) => b.label.toLowerCase()).join(' ');
        expect(labels).not.toMatch(/critical|severe|danger|poor|bad|risk|alarm/);
        expect(bio.bandFor(-6).key).toBe('younger');
        expect(bio.bandFor(0).key).toBe('on_track');
        expect(bio.bandFor(7).key).toBe('older');
    });
});

describe('attribution', () => {
    it('answers each marker with a counterfactual, not with its share of the sum', () => {
        // A marker sitting exactly at its reference is worth nothing, whatever the size of
        // its coefficient. RDW carries the largest coefficient in the equation (0.3306) and
        // is the marker a term-share attribution gets most spectacularly wrong: dividing its
        // raw term by the slope reports roughly +47 years for a perfectly ordinary reading.
        const atReference = Object.fromEntries(
            bio.PHENOAGE_INPUTS.map((i) => [i.key, bio.referenceFor(i, 'male')]),
        );
        for (const c of bio.attribute(45, atReference, 'male')) {
            expect(c.years).toBe(0);
        }

        // And the ordinary panel attributes RDW at well under a year, not at forty-seven.
        expect(Math.abs(bio.attribute(45, WELL, 'male').find((c) => c.key === 'rdw').years))
            .toBeLessThan(1);
    });

    it('charges a raised marker and credits a good one', () => {
        const at = bio.attribute(45, { ...WELL, fasting_glucose: 8.2, albumin: 50 }, 'male');
        expect(at.find((c) => c.key === 'fasting_glucose').years).toBeGreaterThan(2);
        expect(at.find((c) => c.key === 'albumin').years).toBeLessThan(0);
    });

    it('ranks worst first, so a screen can take the top of the list', () => {
        const at = bio.attribute(45, { ...WELL, rdw: 15.5, fasting_glucose: 7.0 }, 'male');
        expect(at[0].years).toBeGreaterThanOrEqual(at[at.length - 1].years);
        expect(at).toEqual([...at].sort((a, b) => b.years - a.years));
    });

    it('uses a sex-appropriate creatinine reference', () => {
        // Muscle mass drives creatinine. Attributing a woman's against a male reference
        // reports kidney strain she does not have.
        const male = bio.attribute(45, WELL, 'male').find((c) => c.key === 'creatinine');
        const female = bio.attribute(45, WELL, 'female').find((c) => c.key === 'creatinine');
        expect(female.reference).toBeLessThan(male.reference);
        expect(female.years).toBeGreaterThan(male.years);
    });

    it('falls back rather than guessing when sex is unknown or unrecognised', () => {
        const input = bio.PHENOAGE_INPUTS.find((i) => i.key === 'creatinine');
        for (const sex of [null, undefined, '', 'prefer not to say', 'non-binary']) {
            expect(bio.referenceFor(input, sex)).toBe(input.reference.default);
        }
    });

    it('labels what a person could actually act on', () => {
        // A lever saying "lower your lymphocyte percentage" is advice nobody can take, which
        // is the dead end PILLAR_ROUTE exists to prevent on the score screen.
        for (const c of bio.attribute(45, WELL, 'male')) {
            expect(['behaviour', 'clinical', 'fixed']).toContain(c.modifiable);
        }
        expect(bio.PHENOAGE_INPUTS.find((i) => i.key === 'lymphocytes_pct').modifiable).toBe('fixed');
        expect(bio.PHENOAGE_INPUTS.find((i) => i.key === 'fasting_glucose').modifiable).toBe('behaviour');
    });
});

describe('panels', () => {
    const at = (daysAgo) => new Date(Date.now() - daysAgo * 86400000);
    const rows = (markers, daysAgo) =>
        Object.entries(markers).map(([name, value]) => ({ name, value, measuredAt: at(daysAgo) }));

    it('groups measurements taken around the same time into one panel', () => {
        // A full blood count and a metabolic panel from one draw routinely reach the patient
        // as two reports dated a few days apart.
        const panels = bio._toPanels([...rows(WELL, 30), ...rows({ crp: 2 }, 33)]);
        expect(panels).toHaveLength(1);
        expect(Object.keys(panels[0].markers)).toHaveLength(9);
    });

    it('never assembles one panel out of measurements months apart', () => {
        // Picking the newest value of each analyte independently describes a phenotype
        // nobody had, while looking on screen exactly like a real reading.
        const panels = bio._toPanels([...rows(WELL, 400), ...rows({ crp: 2, albumin: 41 }, 10)]);
        expect(panels).toHaveLength(2);
        expect(Object.keys(panels[0].markers).sort()).toEqual(['albumin', 'crp']);
    });

    it('drops rows the catalogue could not scale', () => {
        const withBadRow = [
            ...rows(WELL, 10),
            { name: 'lymphocytes_pct', value: 1.9, measuredAt: at(9), needsReview: true },
        ];
        const panels = bio._toPanels(withBadRow);
        expect(panels[0].markers.lymphocytes_pct).toBe(32);
    });

    it('takes the newest value within a panel', () => {
        const panels = bio._toPanels([...rows({ crp: 9 }, 5), ...rows({ crp: 1 }, 2)]);
        expect(panels[0].markers.crp).toBe(1);
    });
});

describe('labAge', () => {
    const at = (daysAgo) => new Date(Date.now() - daysAgo * 86400000);
    const rows = (markers, daysAgo) =>
        Object.entries(markers).map(([name, value]) => ({ name, value, measuredAt: at(daysAgo) }));

    it('refuses with a route out when there are no results at all', () => {
        const r = bio.labAge({ chronologicalAge: 45, measurements: [] });
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('no_results');
        expect(r.missing).toHaveLength(9);
    });

    it('falls back to an older complete panel rather than refusing on a newer partial one', () => {
        const r = bio.labAge({
            chronologicalAge: 45,
            sex: 'male',
            measurements: [...rows(WELL, 90), ...rows({ crp: 1.2 }, 2)],
        });
        expect(r.ok).toBe(true);
        expect(r.freshness.ageDays).toBe(90);
    });

    it('reports the newest panel when nothing qualifies, because that is the one to fix', () => {
        const r = bio.labAge({
            chronologicalAge: 45,
            measurements: [...rows({ crp: 1.2, albumin: 44 }, 2), ...rows({ mcv: 91 }, 300)],
        });
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('incomplete_panel');
        expect(r.have).toBe(2);
    });

    it('does not keep looking for a better panel when the refusal is about the person', () => {
        const r = bio.labAge({ chronologicalAge: 15, measurements: rows(WELL, 10) });
        expect(r.reason).toBe('too_young');
    });
});

describe('freshness', () => {
    it('gives a recent panel full weight', () => {
        expect(bio.freshness(new Date()).weight).toBe(1);
        expect(bio.freshness(new Date(Date.now() - 100 * 86400000)).weight).toBe(1);
    });

    it('decays an ageing panel rather than dropping it', () => {
        const w = bio.freshness(new Date(Date.now() - 400 * 86400000)).weight;
        expect(w).toBeGreaterThan(0);
        expect(w).toBeLessThan(1);
    });

    it('drops a panel old enough to be about somebody else', () => {
        const f = bio.freshness(new Date(Date.now() - 900 * 86400000));
        expect(f.weight).toBe(0);
        expect(f.stale).toBe(true);
    });

    it('treats a missing date as no evidence, not as fresh evidence', () => {
        expect(bio.freshness(null).weight).toBe(0);
    });
});

describe('what travels with every result', () => {
    it('carries a disclaimer that refuses the two claims people will read into it', () => {
        const d = bio.AGE_DISCLAIMER.toLowerCase();
        expect(d).toContain('not a diagnosis');
        expect(d).toMatch(/does not predict how long you will live/);
        expect(panel().disclaimer).toBe(bio.AGE_DISCLAIMER);
    });

    it('names its provenance, so this can never be confused with the behavioural half', () => {
        const r = panel();
        expect(r.source).toBe('lab');
        expect(r.method).toBe('phenoage');
        expect(r.measuredAt).toBeInstanceOf(Date);
    });
});
