/**
 * The interaction rule table, and the guarantee that the model cannot weaken it.
 *
 * These tests are the reason the rule table exists. An AI-only checker is untestable — you
 * cannot assert that a model will always catch warfarin and ibuprofen — so the dangerous
 * pairs are a table, and this file is the proof that the table fires.
 *
 * What has to hold:
 *   - The well-known dangerous pairs are found, whether the person typed a generic name or
 *     a brand name.
 *   - A drug the catalogue does not know is NAMED as unchecked, never silently passed over.
 *     "No findings" and "nothing was checked" must never be the same response.
 *   - The model can add findings and can never remove, downgrade, or contradict one.
 */
const catalogue = require('../utils/medicationCatalogue');
const { mergeFindings, ruleOnlyReview } = require('../utils/medicationEngine');

const med = (name) => ({ name });
const findingIds = (result) => result.findings.map((f) => f.id);
const between = (result, id) =>
    result.findings.filter((f) => f.id === id).map((f) => f.between.join('+'));

describe('name resolution', () => {
    it('resolves brand names onto the active ingredient', () => {
        expect(catalogue.lookup('Lipitor').key).toBe('atorvastatin');
        expect(catalogue.lookup('Nurofen').key).toBe('ibuprofen');
        expect(catalogue.lookup('Coumadin').key).toBe('warfarin');
        expect(catalogue.lookup('Glucophage').key).toBe('metformin');
    });

    it('resolves alternate spellings and regional names', () => {
        expect(catalogue.lookup('acetaminophen').key).toBe('paracetamol');
        expect(catalogue.lookup('Albuterol').key).toBe('salbutamol');
        expect(catalogue.lookup('frusemide').key).toBe('furosemide');
    });

    it('is insensitive to case, spacing and punctuation', () => {
        expect(catalogue.lookup('  ATORVASTATIN  ').key).toBe('atorvastatin');
        expect(catalogue.lookup('Ferrous-Sulfate').key).toBe('ferrous_sulfate');
    });

    it('returns null rather than a guess for something it does not know', () => {
        expect(catalogue.lookup('Expelliarmus')).toBeNull();
        expect(catalogue.classesFor('Expelliarmus')).toEqual([]);
    });
});

describe('the dangerous pairs fire', () => {
    it('flags an anticoagulant with an NSAID as severe', () => {
        const result = catalogue.runRules([med('warfarin'), med('ibuprofen')]);
        const finding = result.findings.find((f) => f.id === 'anticoagulant-nsaid');
        expect(finding).toBeDefined();
        expect(finding.severity).toBe('severe');
        expect(finding.source).toBe('rule');
    });

    it('flags it through brand names too — the person did not type the generic', () => {
        const result = catalogue.runRules([med('Coumadin'), med('Nurofen')]);
        expect(findingIds(result)).toContain('anticoagulant-nsaid');
    });

    it('flags a statin with a macrolide antibiotic', () => {
        const result = catalogue.runRules([med('simvastatin'), med('clarithromycin')]);
        expect(findingIds(result)).toContain('statin-macrolide');
    });

    it('flags a nitrate with a PDE5 inhibitor', () => {
        const result = catalogue.runRules([med('isosorbide mononitrate'), med('sildenafil')]);
        const f = result.findings.find((x) => x.id === 'nitrate-pde5');
        expect(f.severity).toBe('severe');
    });

    it('flags an opioid with a benzodiazepine', () => {
        const result = catalogue.runRules([med('codeine'), med('diazepam')]);
        expect(findingIds(result)).toContain('opioid-cns');
    });

    it('flags lithium with an NSAID', () => {
        const result = catalogue.runRules([med('lithium'), med('naproxen')]);
        expect(findingIds(result)).toContain('lithium-nsaid');
    });

    it('flags methotrexate with trimethoprim', () => {
        const result = catalogue.runRules([med('methotrexate'), med('trimethoprim')]);
        expect(findingIds(result)).toContain('methotrexate-trimethoprim');
    });

    it('flags an ACE inhibitor with a potassium-raising drug', () => {
        const result = catalogue.runRules([med('lisinopril'), med('spironolactone')]);
        expect(findingIds(result)).toContain('ace-potassium');
    });

    it('fires regardless of the order the two drugs were added in', () => {
        const forward = catalogue.runRules([med('warfarin'), med('ibuprofen')]);
        const backward = catalogue.runRules([med('ibuprofen'), med('warfarin')]);
        expect(findingIds(forward).sort()).toEqual(findingIds(backward).sort());
    });
});

describe('duplicates', () => {
    it('catches the same medicine entered under a brand and a generic name', () => {
        const result = catalogue.runRules([med('Lipitor'), med('atorvastatin')]);
        const dup = result.findings.find((f) => f.kind === 'duplicate');
        expect(dup).toBeDefined();
        expect(dup.severity).toBe('moderate');
        expect(dup.effect).toMatch(/double dose/i);
    });

    it('does not report an interaction between a drug and itself', () => {
        const result = catalogue.runRules([med('Lipitor'), med('atorvastatin')]);
        expect(result.findings.filter((f) => f.kind === 'drug')).toHaveLength(0);
    });
});

describe('food and condition rules', () => {
    it('flags grapefruit with atorvastatin but not with rosuvastatin', () => {
        const affected = catalogue.runRules([med('atorvastatin')]);
        expect(findingIds(affected)).toContain('statin-grapefruit');

        const notAffected = catalogue.runRules([med('rosuvastatin')]);
        expect(findingIds(notAffected)).not.toContain('statin-grapefruit');
    });

    it('flags alcohol with metronidazole as severe', () => {
        const result = catalogue.runRules([med('metronidazole')]);
        const f = result.findings.find((x) => x.id === 'metronidazole-alcohol');
        expect(f.severity).toBe('severe');
        expect(f.kind).toBe('food');
    });

    it('flags an NSAID against a recorded ulcer', () => {
        const result = catalogue.runRules([med('ibuprofen')], ['Peptic ulcer disease']);
        const f = result.findings.find((x) => x.id === 'nsaid-ulcer');
        expect(f).toBeDefined();
        expect(f.kind).toBe('condition');
    });

    it('does not flag a condition the person does not have', () => {
        const result = catalogue.runRules([med('ibuprofen')], ['Seasonal rhinitis']);
        expect(findingIds(result)).not.toContain('nsaid-ulcer');
    });

    it('ignores a resolved condition the caller filtered out', () => {
        // The controller passes only unresolved conditions; with none, nothing fires
        const result = catalogue.runRules([med('bisoprolol')], []);
        expect(findingIds(result)).not.toContain('beta-blocker-asthma');
    });
});

describe('coverage is stated, never assumed', () => {
    it('names a drug it could not classify rather than passing over it', () => {
        const result = catalogue.runRules([med('warfarin'), med('Zolpidemol')]);
        expect(result.uncheckable).toEqual(['Zolpidemol']);
        expect(result.checkedCount).toBe(1);
    });

    it('reports zero checked when nothing is recognised — not an empty all-clear', () => {
        const result = catalogue.runRules([med('Foozolol'), med('Barbamil')]);
        expect(result.findings).toHaveLength(0);
        expect(result.checkedCount).toBe(0);
        expect(result.uncheckable).toHaveLength(2);
    });

    it('worstSeverity is null when nothing fired, and never the string "safe"', () => {
        expect(catalogue.worstSeverity([])).toBeNull();
    });

    it('the rule-only summary refuses to issue an all-clear', () => {
        const review = ruleOnlyReview({ findings: [], uncheckable: [], checkedCount: 3 });
        expect(review.summary).toMatch(/not the same as being cleared/i);
    });

    it('the rule-only summary names what could not be checked', () => {
        const review = ruleOnlyReview({ findings: [], uncheckable: ['Foozolol'], checkedCount: 1 });
        expect(review.summary).toContain('Foozolol');
    });

    it('the safety footer never claims anything is safe', () => {
        expect(catalogue.SAFETY_FOOTER).not.toMatch(/\bis safe\b|\bno interactions\b|\ball clear\b/i);
        expect(catalogue.SAFETY_FOOTER).toMatch(/pharmacist|doctor/i);
    });
});

describe('findings are ordered and deduplicated', () => {
    it('sorts severe before moderate before mild', () => {
        const result = catalogue.runRules([
            med('warfarin'), med('ibuprofen'), med('levothyroxine'), med('omeprazole'),
        ]);
        const ranks = result.findings.map((f) => catalogue.severityRank(f.severity));
        expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    });

    it('does not show the same finding about the same pair twice', () => {
        const result = catalogue.runRules([med('lisinopril'), med('spironolactone'), med('ibuprofen')]);
        const keys = result.findings.map((f) => `${f.id}::${[...f.between].sort().join('|')}`);
        expect(new Set(keys).size).toBe(keys.length);
    });
});

describe('mergeFindings — the model cannot weaken the table', () => {
    const ruleFinding = {
        id: 'anticoagulant-nsaid',
        severity: 'severe',
        source: 'rule',
        between: ['warfarin', 'ibuprofen'],
        effect: 'bleeding',
        action: 'ask',
    };

    it('keeps every rule finding at its original severity', () => {
        const merged = mergeFindings([ruleFinding], []);
        expect(merged).toHaveLength(1);
        expect(merged[0].severity).toBe('severe');
    });

    it('drops a model finding that restates a pair the table already covered', () => {
        const merged = mergeFindings([ruleFinding], [
            { kind: 'drug', between: ['warfarin', 'ibuprofen'], severity: 'mild', effect: 'x', action: 'y' },
        ]);
        expect(merged).toHaveLength(1);
        expect(merged[0].severity).toBe('severe');
        expect(merged[0].source).toBe('rule');
    });

    it('drops the restatement regardless of the order the model names the pair in', () => {
        const merged = mergeFindings([ruleFinding], [
            { kind: 'drug', between: ['Ibuprofen', 'WARFARIN'], severity: 'mild', effect: 'x', action: 'y' },
        ]);
        expect(merged).toHaveLength(1);
    });

    it('admits a genuinely new finding and labels its provenance', () => {
        const merged = mergeFindings([ruleFinding], [
            { kind: 'food', between: ['warfarin', 'cranberry juice'], severity: 'moderate', effect: 'x', action: 'y' },
        ]);
        expect(merged).toHaveLength(2);
        const added = merged.find((f) => f.source === 'model');
        expect(added.between).toContain('cranberry juice');
    });

    it('clamps an unrecognised severity down to mild, never up to severe', () => {
        const merged = mergeFindings([], [
            { kind: 'drug', between: ['a', 'b'], severity: 'catastrophic', effect: 'x', action: 'y' },
        ]);
        expect(merged[0].severity).toBe('mild');
    });

    it('ignores a malformed model finding rather than rendering half of one', () => {
        const merged = mergeFindings([ruleFinding], [
            { kind: 'drug', between: ['only one'], severity: 'severe', effect: 'x', action: 'y' },
            null,
            { kind: 'drug', severity: 'severe', effect: 'x', action: 'y' },
        ]);
        expect(merged).toHaveLength(1);
    });

    it('returns findings sorted with the most severe first', () => {
        const merged = mergeFindings(
            [{ ...ruleFinding, severity: 'mild' }],
            [{ kind: 'drug', between: ['c', 'd'], severity: 'severe', effect: 'x', action: 'y' }]
        );
        expect(merged[0].severity).toBe('severe');
    });
});

describe('catalogue copy', () => {
    const entries = Object.entries(catalogue.DRUGS);

    it('gives every drug a lay title short enough to sit under its name', () => {
        for (const [key, drug] of entries) {
            expect(typeof drug.plainName).toBe('string');
            expect(drug.plainName.length).toBeGreaterThan(0);
            expect(`${key}: ${drug.plainName}`.length - key.length - 2).toBeLessThanOrEqual(34);
        }
    });

    it('gives every drug at least one class, or no rule can ever match it', () => {
        for (const [key, drug] of entries) {
            expect(Array.isArray(drug.classes)).toBe(true);
            expect(drug.classes.length).toBeGreaterThan(0);
        }
    });

    it('carries both a minor and a serious side-effect list for every drug', () => {
        for (const [key, drug] of entries) {
            expect(drug.sideEffects.minor.length).toBeGreaterThan(0);
            expect(drug.sideEffects.serious.length).toBeGreaterThan(0);
        }
    });

    it('states no doses — a number here would contradict the label on someone\'s box', () => {
        for (const [key, drug] of entries) {
            const prose = [drug.whatItIs, drug.whyItMatters, drug.storage].join(' ');
            expect(prose).not.toMatch(/\b\d+\s?(mg|mcg|ml|g)\b/i);
        }
    });

    it('every rule references a class some drug actually carries', () => {
        const carried = new Set(Object.values(catalogue.DRUGS).flatMap((d) => d.classes));
        for (const rule of catalogue.INTERACTIONS) {
            for (const side of rule.between) {
                expect(side.some((c) => carried.has(c))).toBe(true);
            }
        }
    });

    it('every rule tells the person something they can act on', () => {
        for (const rule of catalogue.INTERACTIONS) {
            expect(rule.action.length).toBeGreaterThan(20);
            // "Consult your doctor" alone is not an action — it must say what to ask or do
            expect(rule.action).not.toMatch(/^consult your doctor\.?$/i);
        }
    });

    it('search finds a drug by brand name as well as by ingredient', () => {
        expect(catalogue.search('lipitor').map((e) => e.name)).toContain('atorvastatin');
        expect(catalogue.search('atorva').map((e) => e.name)).toContain('atorvastatin');
    });

    it('search ranks an exact match first', () => {
        expect(catalogue.search('aspirin')[0].name).toBe('aspirin');
    });
});
