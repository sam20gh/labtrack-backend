/**
 * Genotype panel extraction and tier gating.
 *
 * The gating tests are the important ones. A regression there does not throw or fail a
 * request — it quietly shows someone a result they chose not to receive, which is the exact
 * harm the tier model exists to prevent. These pin that behaviour down.
 */
const {
    extractFindings, summarise, matchGenotype, canonical, reverseComplement,
} = require('../utils/genotypeParser');
const { BY_RSID, resolveApoe, PANEL } = require('../utils/dnaPanel');
const { visibleFindings } = require('../controllers/genotypeController');

/** Build the call map the extractor expects, as parseGenotypeFile would produce it. */
const callsFrom = (obj) => new Map(
    Object.entries(obj).map(([rsid, result]) => [
        rsid,
        typeof result === 'string' ? { rsid, result } : { rsid, ...result },
    ]),
);

describe('genotype normalisation', () => {
    it('sorts alleles so AG and GA are the same genotype', () => {
        expect(canonical('GA')).toBe('AG');
        expect(canonical('ag')).toBe('AG');
    });

    it('reverse-complements and re-sorts', () => {
        expect(reverseComplement('AG')).toBe('CT');
        expect(reverseComplement('TT')).toBe('AA');
    });

    it('returns null for a genotype it cannot complement', () => {
        expect(reverseComplement('II')).toBeNull();
    });
});

describe('matchGenotype', () => {
    const lct = BY_RSID.get('rs4988235');

    it('matches in the declared orientation', () => {
        const m = matchGenotype(lct, 'GG');
        expect(m.label).toBe('Lactase non-persistent');
        expect(m.strandFlipped).toBe(false);
    });

    it('matches a reverse-strand vendor by complementing, and says so', () => {
        // LCT is declared A/G; a reverse-strand export would report the C/T complement.
        const m = matchGenotype(lct, 'CC');
        expect(m.genotype).toBe('GG');
        expect(m.label).toBe('Lactase non-persistent');
        expect(m.strandFlipped).toBe(true);
    });

    it('refuses to interpret a genotype matching neither orientation', () => {
        // LCT is A/G forward, so T/C reverse. 'AT' is impossible in both, which is what a
        // bad call or a wrong-locus probe looks like — it must not be forced into a match.
        expect(matchGenotype(lct, 'AT').unmatched).toBe(true);
    });

    it('flags palindromic sites, where strand cannot be verified', () => {
        // rs17580 is A/T: identical on both strands, so orientation is unknowable.
        expect(matchGenotype(BY_RSID.get('rs17580'), 'TT').strandAmbiguous).toBe(true);
        expect(matchGenotype(lct, 'GG').strandAmbiguous).toBe(false);
    });
});

describe('APOE haplotype resolution', () => {
    it('resolves the reference sample to ε3/ε4', () => {
        expect(resolveApoe('CT', 'CC').diplotype).toBe('ε3/ε4');
    });

    it('resolves the common type', () => {
        expect(resolveApoe('TT', 'CC').diplotype).toBe('ε3/ε3');
    });

    it('refuses to guess when phase cannot be resolved', () => {
        // CT/CT is consistent with both ε2/ε4 and ε1/ε3 without phasing.
        const r = resolveApoe('CT', 'CT');
        expect(r.ambiguous).toBe(true);
        expect(r.diplotype).toBeUndefined();
    });

    it('returns null when either defining SNP is missing', () => {
        expect(resolveApoe('CT', null)).toBeNull();
        expect(resolveApoe(null, 'CC')).toBeNull();
    });
});

describe('extractFindings', () => {
    it('marks a panel entry the chip does not carry as not_covered, never as negative', () => {
        const findings = extractFindings(callsFrom({}));
        const lct = findings.find((f) => f.rsid === 'rs4988235');
        expect(lct.status).toBe('not_covered');
        expect(lct.genotype).toBeUndefined();
        expect(lct.tone).toBeUndefined();
    });

    it('rejects indel-encoded calls rather than interpreting them', () => {
        const findings = extractFindings(callsFrom({ rs4988235: { result: 'DD', rejected: 'indel' } }));
        expect(findings.find((f) => f.rsid === 'rs4988235').status).toBe('rejected_indel');
    });

    it('produces one finding per panel entry plus APOE', () => {
        const findings = extractFindings(callsFrom({ rs429358: 'CT', rs7412: 'CC' }));
        expect(findings).toHaveLength(PANEL.length + 1);
        expect(findings.find((f) => f.gene === 'APOE').genotype).toBe('ε3/ε4');
    });

    it('carries the biomarker link through so the app can deep-link it', () => {
        const findings = extractFindings(callsFrom({ rs1800562: 'GG' }));
        expect(findings.find((f) => f.rsid === 'rs1800562').affectsBiomarker).toBe('ferritin');
    });
});

describe('visibleFindings — tier gating', () => {
    const findings = extractFindings(callsFrom({
        rs4988235: 'GG',   // release
        rs4149056: 'TT',   // clinician
        rs7903146: 'CT',   // opt_in
        rs1801133: 'GG',   // suppressed (MTHFR)
        rs429358: 'CT',
        rs7412: 'CC',      // opt_in, derived
    }));

    const locked = () => visibleFindings(findings, { clinicianReleased: false, riskOptIn: false });

    it('never serialises a suppressed finding, under any combination', () => {
        for (const clinicianReleased of [false, true]) {
            for (const riskOptIn of [false, true]) {
                const out = visibleFindings(findings, { clinicianReleased, riskOptIn });
                expect(out.some((f) => f.tier === 'suppressed')).toBe(false);
                expect(JSON.stringify(out)).not.toContain('MTHFR');
            }
        }
    });

    it('omits opt-in findings entirely until the user consents', () => {
        expect(locked().some((f) => f.tier === 'opt_in')).toBe(false);
        // Not merely hidden — the content must not be in the payload at all.
        expect(JSON.stringify(locked())).not.toContain('ε3/ε4');
        expect(JSON.stringify(locked())).not.toContain('Alzheimer');
    });

    it('returns opt-in findings once consent is given', () => {
        const out = visibleFindings(findings, { clinicianReleased: false, riskOptIn: true });
        expect(out.find((f) => f.gene === 'APOE').genotype).toBe('ε3/ε4');
    });

    it('withholds clinician-tier interpretation but keeps the row visible', () => {
        const statin = locked().find((f) => f.rsid === 'rs4149056');
        expect(statin.withheld).toBe(true);
        expect(statin.name).toBeDefined();
        // The result itself must not leak through the placeholder.
        expect(statin.genotype).toBeUndefined();
        expect(statin.detail).toBeUndefined();
        expect(statin.tone).toBeUndefined();
    });

    it('releases clinician-tier findings once an interpretation is signed off', () => {
        const out = visibleFindings(findings, { clinicianReleased: true, riskOptIn: false });
        const statin = out.find((f) => f.rsid === 'rs4149056');
        expect(statin.withheld).toBeUndefined();
        expect(statin.genotype).toBe('TT');
    });

    it('always releases release-tier findings', () => {
        expect(locked().find((f) => f.rsid === 'rs4988235').detail).toContain('Lactase');
    });
});

describe('summarise', () => {
    it('counts suppressed entries separately from what a user could see', () => {
        const s = summarise(extractFindings(callsFrom({ rs4988235: 'GG', rs1801133: 'GG' })));
        expect(s.suppressed).toBe(1);
        expect(s.byTier.release).toBe(1);
    });
});
