/**
 * The curated genotype panel.
 *
 * This is the allowlist that turns a 600k-row array export into a bounded, reviewable set
 * of results. The design decision it encodes: we do NOT read every row and ask which ones
 * matter. We declare the entries we can defend an evidence source for and look up only
 * those. That keeps the work bounded, makes the panel itself the reviewable artifact, and
 * lets a stored raw file be re-extracted whenever the panel gains an entry.
 *
 * ⚠️ NOT CLINICALLY REVIEWED. Every entry below needs a named reviewer and a verified
 * citation before it drives anything a user acts on — this is WO-32/D5 and it is
 * deliberately still open. `tier` is what keeps that safe in the meantime: only `release`
 * entries reach a user without a clinician, and `opt_in` entries stay hidden entirely
 * until the user asks for them.
 *
 * ── Strand orientation ──────────────────────────────────────────────────────────────
 * Genotypes here are written in the orientation the MyHeritage GSA export uses (forward
 * strand, GRCh37). dbSNP sometimes lists the opposite orientation for the same rsID —
 * rs2282679 is the worked example: dbSNP calls it A/C, the export reports T/G. Rather
 * than resolve that per-entry by hand, `matchGenotype` in genotypeParser.js also tries the
 * reverse complement, and anything matching neither is recorded as `unmatched` rather than
 * guessed at. A wrong strand silently inverts a risk call, so guessing is not an option.
 */

/** Display tier. Controls who sees a result and when. */
const TIER = {
    /** Safe to show as soon as it is extracted. Well-evidenced and low-stakes. */
    RELEASE: 'release',
    /** Held until a clinician signs the interpretation off. */
    CLINICIAN: 'clinician',
    /** Hidden until the user explicitly opts in, with counselling copy. */
    OPT_IN: 'opt_in',
    /** Extracted and stored, never displayed. See D4. */
    SUPPRESSED: 'suppressed',
};

const CATEGORY = {
    MEDICATION: 'medication',
    NUTRITION: 'nutrition',
    CARRIER: 'carrier',
    TRAIT: 'trait',
    RISK: 'risk',
};

/**
 * Result tone. Drives the chip on the card, and is deliberately not a risk score —
 * an array result is context, not a diagnosis.
 */
const TONE = {
    TYPICAL: 'typical',
    REDUCED: 'reduced',
    INCREASED: 'increased',
    CARRIER: 'carrier',
    ATTENTION: 'attention',
};

/**
 * Panel entries.
 *
 * `genotypes` keys are alleles sorted alphabetically, so AG and GA both resolve to 'AG'.
 * `affectsBiomarker` links a finding to a canonical biomarker name from
 * scripts/seedReferenceRanges.js, so the app can deep-link the card to that trend screen.
 */
const PANEL = [
    // ── Medication response ─────────────────────────────────────────────────────────
    {
        rsid: 'rs4149056',
        gene: 'SLCO1B1',
        name: 'Statin muscle side effects',
        category: CATEGORY.MEDICATION,
        tier: TIER.CLINICIAN,
        evidence: 'CPIC guideline, simvastatin — PharmGKB level 1A',
        genotypes: {
            TT: { tone: TONE.TYPICAL, label: 'Typical response', detail: 'Normal transporter function. No raised risk of statin-related muscle pain at standard doses.' },
            CT: { tone: TONE.REDUCED, label: 'Intermediate function', detail: 'One reduced-function copy. Moderately raised risk of muscle symptoms on higher-dose simvastatin.' },
            CC: { tone: TONE.ATTENTION, label: 'Low function', detail: 'Two reduced-function copies. Notably raised risk of statin-related muscle symptoms; alternative statins are usually preferred.' },
        },
    },
    {
        rsid: 'rs1142345',
        gene: 'TPMT',
        alleleName: 'TPMT*3C',
        name: 'Thiopurine metabolism',
        category: CATEGORY.MEDICATION,
        tier: TIER.CLINICIAN,
        evidence: 'CPIC guideline, thiopurines — PharmGKB level 1A',
        genotypes: {
            TT: { tone: TONE.TYPICAL, label: 'Normal metaboliser', detail: 'No *3C variant. Standard thiopurine dosing expected to be tolerated.' },
            CT: { tone: TONE.REDUCED, label: 'Intermediate metaboliser', detail: 'One reduced-function copy. Reduced starting doses are usually advised.' },
            CC: { tone: TONE.ATTENTION, label: 'Poor metaboliser', detail: 'Two reduced-function copies. Substantially reduced dosing or an alternative drug is advised.' },
        },
    },
    {
        rsid: 'rs1800462',
        gene: 'TPMT',
        alleleName: 'TPMT*2',
        name: 'Thiopurine metabolism (*2)',
        category: CATEGORY.MEDICATION,
        tier: TIER.CLINICIAN,
        evidence: 'CPIC guideline, thiopurines — PharmGKB level 1A',
        genotypes: {
            CC: { tone: TONE.TYPICAL, label: 'No *2 variant', detail: 'The *2 reduced-function allele is not present.' },
            CG: { tone: TONE.REDUCED, label: 'One *2 copy', detail: 'One reduced-function copy of TPMT.' },
            GG: { tone: TONE.ATTENTION, label: 'Two *2 copies', detail: 'Two reduced-function copies of TPMT.' },
        },
    },
    {
        rsid: 'rs2231142',
        gene: 'ABCG2',
        name: 'Urate transport',
        category: CATEGORY.MEDICATION,
        tier: TIER.CLINICIAN,
        evidence: 'PharmGKB — allopurinol response, gout susceptibility',
        genotypes: {
            GG: { tone: TONE.TYPICAL, label: 'Typical transport', detail: 'Normal urate transporter function.' },
            GT: { tone: TONE.INCREASED, label: 'Reduced transport', detail: 'One reduced-function copy. Associated with higher serum urate and a reduced allopurinol response.' },
            TT: { tone: TONE.INCREASED, label: 'Low transport', detail: 'Two reduced-function copies. Associated with higher serum urate and a reduced allopurinol response.' },
        },
        affectsBiomarker: 'uric_acid',
    },
    {
        rsid: 'rs1799971',
        gene: 'OPRM1',
        name: 'Opioid receptor sensitivity',
        category: CATEGORY.MEDICATION,
        tier: TIER.CLINICIAN,
        evidence: 'PharmGKB level 2A — evidence is mixed; contextual only',
        genotypes: {
            AA: { tone: TONE.TYPICAL, label: 'Typical sensitivity', detail: 'The common receptor variant. No dosing change indicated.' },
            AG: { tone: TONE.REDUCED, label: 'Reduced sensitivity', detail: 'One copy of the G variant, associated in some studies with higher opioid requirements.' },
            GG: { tone: TONE.REDUCED, label: 'Reduced sensitivity', detail: 'Two copies of the G variant, associated in some studies with higher opioid requirements.' },
        },
    },
    {
        rsid: 'rs12248560',
        gene: 'CYP2C19',
        alleleName: 'CYP2C19*17',
        name: 'CYP2C19 activity (partial)',
        category: CATEGORY.MEDICATION,
        tier: TIER.CLINICIAN,
        // The gap is the point — see NOT_TESTED below.
        incomplete: 'CYP2C19*2 (rs4244285) is not on this chip, so a full diplotype cannot be called.',
        evidence: 'CPIC guideline, clopidogrel — PharmGKB level 1A',
        genotypes: {
            CC: { tone: TONE.TYPICAL, label: 'No *17 allele', detail: 'The increased-function *17 allele is not present.' },
            CT: { tone: TONE.INCREASED, label: 'One *17 allele', detail: 'One increased-function copy, which can raise the activation of some drugs.' },
            TT: { tone: TONE.INCREASED, label: 'Two *17 alleles', detail: 'Two increased-function copies, which can raise the activation of some drugs.' },
        },
    },
    {
        rsid: 'rs1799853',
        gene: 'CYP2C9',
        alleleName: 'CYP2C9*2',
        name: 'CYP2C9 activity (partial)',
        category: CATEGORY.MEDICATION,
        tier: TIER.CLINICIAN,
        incomplete: 'CYP2C9*3 (rs1057910) is not on this chip, so a full diplotype cannot be called.',
        evidence: 'CPIC guideline, NSAIDs and warfarin — PharmGKB level 1A',
        genotypes: {
            CC: { tone: TONE.TYPICAL, label: 'No *2 allele', detail: 'The reduced-function *2 allele is not present.' },
            CT: { tone: TONE.REDUCED, label: 'One *2 allele', detail: 'One reduced-function copy of CYP2C9.' },
            TT: { tone: TONE.REDUCED, label: 'Two *2 alleles', detail: 'Two reduced-function copies of CYP2C9.' },
        },
    },

    // ── Nutrition & metabolism ──────────────────────────────────────────────────────
    {
        rsid: 'rs4988235',
        gene: 'LCT',
        name: 'Lactose tolerance',
        category: CATEGORY.NUTRITION,
        tier: TIER.RELEASE,
        evidence: 'Enattah et al. 2002 — the European lactase-persistence variant',
        genotypes: {
            AA: { tone: TONE.TYPICAL, label: 'Lactase persistent', detail: 'Lactase production usually continues into adulthood. Dairy is typically well tolerated.' },
            AG: { tone: TONE.TYPICAL, label: 'Lactase persistent', detail: 'One persistence copy is generally enough to keep digesting lactose in adulthood.' },
            GG: { tone: TONE.REDUCED, label: 'Lactase non-persistent', detail: 'Lactase production commonly declines after childhood. Dairy may cause bloating or discomfort — this is normal and not an allergy.' },
        },
    },
    {
        rsid: 'rs1800562',
        gene: 'HFE',
        alleleName: 'C282Y',
        name: 'Iron overload — C282Y',
        category: CATEGORY.NUTRITION,
        tier: TIER.CLINICIAN,
        evidence: 'ClinVar — hereditary haemochromatosis, the major HFE variant',
        genotypes: {
            GG: { tone: TONE.TYPICAL, label: 'Not a carrier', detail: 'The C282Y variant is not present.' },
            AG: { tone: TONE.CARRIER, label: 'Carrier', detail: 'One copy of C282Y. Carriers rarely develop iron overload, but iron studies are worth monitoring.' },
            AA: { tone: TONE.ATTENTION, label: 'Two copies', detail: 'Two copies of C282Y, the genotype most associated with hereditary haemochromatosis. Iron studies should be reviewed with a clinician.' },
        },
        affectsBiomarker: 'ferritin',
    },
    {
        rsid: 'rs1799945',
        gene: 'HFE',
        alleleName: 'H63D',
        name: 'Iron overload — H63D',
        category: CATEGORY.NUTRITION,
        tier: TIER.CLINICIAN,
        evidence: 'ClinVar — hereditary haemochromatosis, lower-penetrance HFE variant',
        genotypes: {
            CC: { tone: TONE.TYPICAL, label: 'Not a carrier', detail: 'The H63D variant is not present.' },
            CG: { tone: TONE.CARRIER, label: 'Carrier', detail: 'One copy of H63D. On its own this rarely causes iron overload.' },
            GG: { tone: TONE.CARRIER, label: 'Two copies', detail: 'Two copies of H63D. Lower penetrance than C282Y, but iron studies are worth monitoring.' },
        },
        affectsBiomarker: 'ferritin',
    },
    {
        rsid: 'rs602662',
        gene: 'FUT2',
        name: 'Vitamin B12 absorption',
        category: CATEGORY.NUTRITION,
        tier: TIER.RELEASE,
        evidence: 'GWAS — FUT2 secretor status and serum B12',
        genotypes: {
            GG: { tone: TONE.TYPICAL, label: 'Typical B12 handling', detail: 'Serum B12 tends to sit in the usual range for this variant.' },
            AG: { tone: TONE.TYPICAL, label: 'Intermediate', detail: 'One copy of the variant associated with slightly higher measured serum B12. Your B12 reference range accounts for this.' },
            AA: { tone: TONE.INCREASED, label: 'Higher measured B12', detail: 'Associated with higher measured serum B12, which can mask a true deficiency. Worth interpreting B12 results alongside symptoms.' },
        },
        affectsBiomarker: 'vitamin_b12',
    },
    {
        rsid: 'rs2282679',
        gene: 'GC',
        name: 'Vitamin D binding protein',
        category: CATEGORY.NUTRITION,
        tier: TIER.RELEASE,
        // Worked example of the strand problem documented at the top of this file.
        strandNote: 'dbSNP lists this as A/C; the GSA export reports the reverse complement (T/G).',
        evidence: 'GWAS — GC locus and 25-hydroxyvitamin D levels',
        genotypes: {
            TT: { tone: TONE.TYPICAL, label: 'Typical levels', detail: 'No variant associated with reduced vitamin D binding protein.' },
            GT: { tone: TONE.REDUCED, label: 'Slightly lower', detail: 'One copy associated with modestly lower circulating vitamin D.' },
            GG: { tone: TONE.REDUCED, label: 'Lower levels', detail: 'Associated with lower circulating vitamin D. Levels are worth checking before supplementing.' },
        },
        affectsBiomarker: 'vitamin_d',
    },
    {
        rsid: 'rs12785878',
        gene: 'DHCR7',
        name: 'Vitamin D synthesis',
        category: CATEGORY.NUTRITION,
        tier: TIER.RELEASE,
        evidence: 'GWAS — DHCR7/NADSYN1 locus and 25-hydroxyvitamin D levels',
        genotypes: {
            TT: { tone: TONE.TYPICAL, label: 'Typical synthesis', detail: 'No variant associated with reduced vitamin D synthesis.' },
            GT: { tone: TONE.REDUCED, label: 'Slightly lower', detail: 'One copy associated with modestly lower circulating vitamin D.' },
            GG: { tone: TONE.REDUCED, label: 'Lower synthesis', detail: 'Associated with lower circulating vitamin D from sunlight exposure.' },
        },
        affectsBiomarker: 'vitamin_d',
    },
    {
        rsid: 'rs1229984',
        gene: 'ADH1B',
        name: 'Alcohol metabolism',
        category: CATEGORY.NUTRITION,
        tier: TIER.RELEASE,
        evidence: 'Well-replicated — ADH1B*2 fast-metabolism variant',
        genotypes: {
            CC: { tone: TONE.TYPICAL, label: 'Typical metabolism', detail: 'Alcohol is broken down at the usual rate.' },
            CT: { tone: TONE.INCREASED, label: 'Faster metabolism', detail: 'One fast-metabolising copy. Alcohol converts to acetaldehyde more quickly, which some people find unpleasant.' },
            TT: { tone: TONE.INCREASED, label: 'Much faster metabolism', detail: 'Two fast-metabolising copies. Strongly associated with lower alcohol consumption.' },
        },
    },
    {
        rsid: 'rs671',
        gene: 'ALDH2',
        name: 'Alcohol flush response',
        category: CATEGORY.NUTRITION,
        tier: TIER.RELEASE,
        evidence: 'Well-replicated — ALDH2*2, predominantly East Asian',
        genotypes: {
            GG: { tone: TONE.TYPICAL, label: 'No flush variant', detail: 'Acetaldehyde is cleared normally. No alcohol flush reaction expected from this variant.' },
            AG: { tone: TONE.ATTENTION, label: 'Flush response likely', detail: 'One copy. Facial flushing, nausea and a raised heart rate after alcohol are common, and alcohol carries a higher oesophageal cancer risk with this variant.' },
            AA: { tone: TONE.ATTENTION, label: 'Strong flush response', detail: 'Two copies. Alcohol is very poorly tolerated and carries a substantially higher oesophageal cancer risk.' },
        },
    },
    {
        rsid: 'rs762551',
        gene: 'CYP1A2',
        name: 'Caffeine metabolism',
        category: CATEGORY.NUTRITION,
        tier: TIER.RELEASE,
        evidence: 'Contested — effect size varies across studies. Contextual only.',
        genotypes: {
            AA: { tone: TONE.TYPICAL, label: 'Fast metaboliser', detail: 'Caffeine is cleared relatively quickly. Evidence for this association is mixed.' },
            AC: { tone: TONE.REDUCED, label: 'Slower metaboliser', detail: 'Caffeine may clear more slowly, so late-day coffee is more likely to affect sleep.' },
            CC: { tone: TONE.REDUCED, label: 'Slow metaboliser', detail: 'Caffeine may clear more slowly, so late-day coffee is more likely to affect sleep.' },
        },
    },

    // ── Carrier status ──────────────────────────────────────────────────────────────
    {
        rsid: 'rs6025',
        gene: 'F5',
        alleleName: 'Factor V Leiden',
        name: 'Factor V Leiden',
        category: CATEGORY.CARRIER,
        tier: TIER.CLINICIAN,
        evidence: 'ClinVar pathogenic — inherited thrombophilia',
        genotypes: {
            CC: { tone: TONE.TYPICAL, label: 'Not a carrier', detail: 'The Factor V Leiden variant is not present.' },
            CT: { tone: TONE.CARRIER, label: 'Carrier', detail: 'One copy, which raises the risk of venous blood clots. Relevant before surgery, long-haul travel, or starting oestrogen-containing medication.' },
            TT: { tone: TONE.ATTENTION, label: 'Two copies', detail: 'Two copies, which substantially raises venous clot risk. Should be reviewed with a clinician.' },
        },
    },
    {
        rsid: 'rs1799963',
        gene: 'F2',
        alleleName: 'Prothrombin G20210A',
        name: 'Prothrombin G20210A',
        category: CATEGORY.CARRIER,
        tier: TIER.CLINICIAN,
        evidence: 'ClinVar pathogenic — inherited thrombophilia',
        genotypes: {
            GG: { tone: TONE.TYPICAL, label: 'Not a carrier', detail: 'The G20210A variant is not present.' },
            AG: { tone: TONE.CARRIER, label: 'Carrier', detail: 'One copy, which raises the risk of venous blood clots.' },
            AA: { tone: TONE.ATTENTION, label: 'Two copies', detail: 'Two copies, which substantially raises venous clot risk. Should be reviewed with a clinician.' },
        },
    },
    {
        rsid: 'rs28929474',
        gene: 'SERPINA1',
        alleleName: 'Z allele',
        name: 'Alpha-1 antitrypsin — Z',
        category: CATEGORY.CARRIER,
        tier: TIER.CLINICIAN,
        evidence: 'ClinVar pathogenic — alpha-1 antitrypsin deficiency',
        genotypes: {
            CC: { tone: TONE.TYPICAL, label: 'Not a carrier', detail: 'The Z allele is not present.' },
            CT: { tone: TONE.CARRIER, label: 'Carrier', detail: 'One Z allele. Usually without symptoms, but smoking carries a higher lung risk with this variant.' },
            TT: { tone: TONE.ATTENTION, label: 'Two copies', detail: 'Two Z alleles, the genotype associated with alpha-1 antitrypsin deficiency affecting lungs and liver. Should be reviewed with a clinician.' },
        },
    },
    {
        rsid: 'rs17580',
        gene: 'SERPINA1',
        alleleName: 'S allele',
        name: 'Alpha-1 antitrypsin — S',
        category: CATEGORY.CARRIER,
        tier: TIER.CLINICIAN,
        evidence: 'ClinVar — alpha-1 antitrypsin, lower-penetrance S allele',
        genotypes: {
            TT: { tone: TONE.TYPICAL, label: 'Not a carrier', detail: 'The S allele is not present.' },
            AT: { tone: TONE.CARRIER, label: 'Carrier', detail: 'One S allele. Milder than the Z allele and usually without symptoms.' },
            AA: { tone: TONE.CARRIER, label: 'Two copies', detail: 'Two S alleles, associated with mildly reduced alpha-1 antitrypsin levels.' },
        },
    },
    {
        rsid: 'rs2187668',
        gene: 'HLA-DQA1',
        alleleName: 'HLA-DQ2.5 tag',
        name: 'Coeliac disease susceptibility',
        category: CATEGORY.CARRIER,
        tier: TIER.CLINICIAN,
        evidence: 'Tag SNP for the HLA-DQ2.5 haplotype — high negative predictive value',
        genotypes: {
            CC: { tone: TONE.TYPICAL, label: 'DQ2.5 not detected', detail: 'The main coeliac-permissive haplotype was not detected, which makes coeliac disease unlikely.' },
            CT: { tone: TONE.CARRIER, label: 'DQ2.5 present', detail: 'One copy of the permissive haplotype. Around a third of people carry this and most never develop coeliac disease — it is necessary but far from sufficient.' },
            TT: { tone: TONE.CARRIER, label: 'DQ2.5 present', detail: 'Two copies of the permissive haplotype. Most carriers never develop coeliac disease, but symptoms are worth investigating.' },
        },
    },

    // ── Traits ──────────────────────────────────────────────────────────────────────
    {
        rsid: 'rs713598',
        gene: 'TAS2R38',
        name: 'Bitter taste perception',
        category: CATEGORY.TRAIT,
        tier: TIER.RELEASE,
        evidence: 'Well-replicated — PTC/PROP tasting',
        genotypes: {
            CC: { tone: TONE.TYPICAL, label: 'Strong taster', detail: 'You likely find brassicas — broccoli, sprouts, kale — noticeably bitter.' },
            CG: { tone: TONE.TYPICAL, label: 'Intermediate taster', detail: 'You likely detect some bitterness in brassicas, but not strongly.' },
            GG: { tone: TONE.TYPICAL, label: 'Non-taster', detail: 'You likely do not perceive the bitter compound in brassicas at all.' },
        },
    },
    {
        rsid: 'rs17822931',
        gene: 'ABCC11',
        name: 'Earwax type',
        category: CATEGORY.TRAIT,
        tier: TIER.RELEASE,
        evidence: 'Well-replicated — single-gene trait',
        genotypes: {
            CC: { tone: TONE.TYPICAL, label: 'Wet earwax', detail: 'The common type outside East Asia. Also associated with typical underarm odour.' },
            CT: { tone: TONE.TYPICAL, label: 'Wet earwax', detail: 'One copy is enough for the wet type.' },
            TT: { tone: TONE.TYPICAL, label: 'Dry earwax', detail: 'Associated with dry, flaky earwax and markedly reduced underarm odour.' },
        },
    },
    {
        rsid: 'rs12913832',
        gene: 'HERC2',
        name: 'Eye colour',
        category: CATEGORY.TRAIT,
        tier: TIER.RELEASE,
        evidence: 'Well-replicated — the major eye-colour locus',
        genotypes: {
            AA: { tone: TONE.TYPICAL, label: 'Blue or light', detail: 'Strongly associated with blue or light-coloured eyes.' },
            AG: { tone: TONE.TYPICAL, label: 'Intermediate', detail: 'Often green, hazel or light brown.' },
            GG: { tone: TONE.TYPICAL, label: 'Brown', detail: 'Strongly associated with brown eyes.' },
        },
    },
    {
        rsid: 'rs4481887',
        gene: 'OR2M7',
        name: 'Asparagus odour detection',
        category: CATEGORY.TRAIT,
        tier: TIER.RELEASE,
        // Direction of effect not confirmed. The locus is robustly associated with asparagus
        // anosmia, but which allele tracks which direction is not something this panel's
        // author could verify, so the copy states the association without claiming a
        // direction. Resolve against the source GWAS before this ships. See D5.
        evidence: 'GWAS — olfactory receptor locus. Direction of effect UNVERIFIED.',
        directionUnverified: true,
        genotypes: {
            AA: { tone: TONE.TYPICAL, label: 'Associated variant', detail: 'This position is linked to whether people can smell the compound asparagus produces in urine. Which way it points is not yet confirmed for this panel.' },
            AG: { tone: TONE.TYPICAL, label: 'Mixed', detail: 'You carry one copy of each variant at the position linked to asparagus odour detection.' },
            GG: { tone: TONE.TYPICAL, label: 'Associated variant', detail: 'This position is linked to whether people can smell the compound asparagus produces in urine. Which way it points is not yet confirmed for this panel.' },
        },
    },

    // ── Risk-bearing — hidden until the user opts in ─────────────────────────────────
    {
        rsid: 'rs7903146',
        gene: 'TCF7L2',
        name: 'Type 2 diabetes association',
        category: CATEGORY.RISK,
        tier: TIER.OPT_IN,
        evidence: 'The most replicated common T2D variant — modest effect (OR ≈ 1.4 per allele)',
        genotypes: {
            CC: { tone: TONE.TYPICAL, label: 'No risk alleles', detail: 'Neither copy carries the common type 2 diabetes-associated allele.' },
            CT: { tone: TONE.INCREASED, label: 'One risk allele', detail: 'A modestly raised association with type 2 diabetes. Lifestyle and HbA1c matter far more than this variant.' },
            TT: { tone: TONE.INCREASED, label: 'Two risk alleles', detail: 'A moderately raised association with type 2 diabetes. Lifestyle and HbA1c matter far more than this variant.' },
        },
        affectsBiomarker: 'hba1c',
    },
    {
        rsid: 'rs1061170',
        gene: 'CFH',
        name: 'Macular degeneration — CFH',
        category: CATEGORY.RISK,
        tier: TIER.OPT_IN,
        evidence: 'Well-replicated — the major AMD susceptibility locus',
        genotypes: {
            TT: { tone: TONE.TYPICAL, label: 'No risk alleles', detail: 'Neither copy carries the AMD-associated allele at this locus.' },
            CT: { tone: TONE.INCREASED, label: 'One risk allele', detail: 'A raised association with age-related macular degeneration. Regular eye checks after 50 are worthwhile.' },
            CC: { tone: TONE.INCREASED, label: 'Two risk alleles', detail: 'A notably raised association with age-related macular degeneration. Regular eye checks after 50 are worthwhile.' },
        },
    },
    {
        rsid: 'rs10490924',
        gene: 'ARMS2',
        name: 'Macular degeneration — ARMS2',
        category: CATEGORY.RISK,
        tier: TIER.OPT_IN,
        evidence: 'Well-replicated — second major AMD susceptibility locus',
        genotypes: {
            GG: { tone: TONE.TYPICAL, label: 'No risk alleles', detail: 'Neither copy carries the AMD-associated allele at this locus.' },
            GT: { tone: TONE.INCREASED, label: 'One risk allele', detail: 'A raised association with age-related macular degeneration.' },
            TT: { tone: TONE.INCREASED, label: 'Two risk alleles', detail: 'A notably raised association with age-related macular degeneration.' },
        },
    },

    // ── Suppressed — extracted and stored, never displayed ───────────────────────────
    {
        rsid: 'rs1801133',
        gene: 'MTHFR',
        alleleName: 'C677T',
        name: 'MTHFR C677T',
        category: CATEGORY.NUTRITION,
        tier: TIER.SUPPRESSED,
        suppressionReason:
            'ACMG advises against clinical MTHFR testing: it does not change management and drives ' +
            'unnecessary supplementation. Stored for completeness, never shown. See D4.',
        evidence: 'ACMG practice guideline (2013) — recommends against testing',
        genotypes: {
            GG: { tone: TONE.TYPICAL, label: 'No C677T', detail: 'Not displayed.' },
            AG: { tone: TONE.TYPICAL, label: 'One copy', detail: 'Not displayed.' },
            AA: { tone: TONE.TYPICAL, label: 'Two copies', detail: 'Not displayed.' },
        },
    },
];

/**
 * APOE is derived from two SNPs rather than read from one, so it cannot be a normal panel
 * entry. The ε2/ε3/ε4 alleles are defined by the rs429358 + rs7412 haplotype pair.
 *
 * Unphased array data cannot always resolve this. rs429358 CT with rs7412 CT is consistent
 * with both ε1/ε3 and ε2/ε4 and must not be guessed — `ambiguous` is a real, expected
 * outcome and the UI has to be able to render it.
 */
const APOE = {
    key: 'apoe',
    gene: 'APOE',
    name: 'APOE type',
    category: CATEGORY.RISK,
    tier: TIER.OPT_IN,
    rsids: ['rs429358', 'rs7412'],
    evidence: 'The strongest common genetic risk factor for late-onset Alzheimer\'s disease',
    counselling:
        'APOE type cannot be changed and there is no treatment that acts on it. Knowing it ' +
        'can cause lasting distress, and it does not tell you whether you will develop ' +
        'dementia — many ε4 carriers never do, and many people with dementia carry none. ' +
        'Consider discussing it with a genetic counsellor before revealing it.',
};

/**
 * Resolve the APOE diplotype from the two defining calls.
 * Returns `null` when either SNP is missing, and `ambiguous` when phase cannot be resolved.
 */
const resolveApoe = (rs429358, rs7412) => {
    if (!rs429358 || !rs7412) return null;

    const c1 = rs429358.split('').sort().join('');
    const c2 = rs7412.split('').sort().join('');
    const key = `${c1}/${c2}`;

    // rs429358: C = ε4-defining.  rs7412: T = ε2-defining.
    const TABLE = {
        'TT/CC': { diplotype: 'ε3/ε3', alleles: ['ε3', 'ε3'], e4Count: 0 },
        'TT/CT': { diplotype: 'ε2/ε3', alleles: ['ε2', 'ε3'], e4Count: 0 },
        'TT/TT': { diplotype: 'ε2/ε2', alleles: ['ε2', 'ε2'], e4Count: 0 },
        'CT/CC': { diplotype: 'ε3/ε4', alleles: ['ε3', 'ε4'], e4Count: 1 },
        'CC/CC': { diplotype: 'ε4/ε4', alleles: ['ε4', 'ε4'], e4Count: 2 },
        // Both heterozygous — ε2/ε4 and ε1/ε3 are indistinguishable without phasing.
        'CT/CT': { diplotype: null, ambiguous: true, e4Count: null },
    };

    const hit = TABLE[key];
    if (!hit) return { diplotype: null, unresolved: true, calls: { rs429358, rs7412 } };

    if (hit.ambiguous) {
        return {
            ambiguous: true,
            detail: 'These two results are consistent with more than one APOE type and cannot be resolved from array data alone. Sequencing would be needed to separate them.',
            calls: { rs429358, rs7412 },
        };
    }

    const detail = hit.e4Count === 0
        ? 'No ε4 allele. This is the most common APOE type and carries no raised Alzheimer\'s association.'
        : hit.e4Count === 1
            ? 'One ε4 allele. This raises the statistical association with late-onset Alzheimer\'s disease, but most people with one ε4 never develop it.'
            : 'Two ε4 alleles. This carries the strongest common genetic association with late-onset Alzheimer\'s disease, though it is still not a diagnosis or a certainty.';

    return { ...hit, detail, calls: { rs429358, rs7412 } };
};

/**
 * Coverage gaps worth stating explicitly on the report.
 *
 * "Not tested" is not the same as "negative", and the single most common way consumer
 * genomics misleads is by blurring the two. These render as their own section so a user
 * can never read silence as reassurance.
 */
const NOT_TESTED = [
    {
        key: 'hereditary_cancer',
        title: 'Hereditary breast, ovarian and bowel cancer',
        genes: ['BRCA1', 'BRCA2', 'MLH1', 'MSH2', 'MSH6', 'PMS2'],
        detail:
            'This array carries 44 probes at known BRCA1/BRCA2 variant positions, out of several ' +
            'thousand known disease-causing variants — and most of those are family-specific. ' +
            'A result here cannot rule out an inherited cancer risk. Full gene sequencing is ' +
            'needed for that.',
        upgrade: 'genetic_panel',
    },
    {
        key: 'clopidogrel',
        title: 'Clopidogrel response (CYP2C19)',
        genes: ['CYP2C19'],
        detail:
            'CYP2C19*2 (rs4244285), the most important loss-of-function allele, is not on this ' +
            'chip. A partial result is reported, but a full metaboliser status cannot be called.',
    },
    {
        key: 'warfarin',
        title: 'Warfarin dosing (VKORC1, CYP2C9)',
        genes: ['VKORC1', 'CYP2C9'],
        detail:
            'VKORC1 (rs9923231) and CYP2C9*3 (rs1057910) are not on this chip, so genotype-guided ' +
            'warfarin dosing is not available from this test.',
    },
    {
        key: 'cyp2d6',
        title: 'CYP2D6 metaboliser status',
        genes: ['CYP2D6'],
        detail:
            'CYP2D6 is largely defined by whole-gene duplications and deletions, which a ' +
            'genotyping array cannot detect at all. No metaboliser status is reported.',
    },
    {
        key: 'mitochondrial',
        title: 'Mitochondrial conditions',
        genes: ['MT'],
        detail: 'This test does not read mitochondrial DNA, so mitochondrial conditions are out of scope.',
    },
];

/** Fast lookup by rsID, built once at require time. */
const BY_RSID = new Map(PANEL.map((entry) => [entry.rsid, entry]));

/** Every rsID the extractor needs to pull out of a raw file, APOE's pair included. */
const PANEL_RSIDS = new Set([...BY_RSID.keys(), ...APOE.rsids]);

/** Bumped whenever an entry is added or its interpretation changes, so a stored */
/** extraction can be compared against the panel that produced it and re-run if stale. */
const PANEL_VERSION = '2026.08.26-2';

module.exports = {
    PANEL,
    PANEL_RSIDS,
    PANEL_VERSION,
    BY_RSID,
    APOE,
    NOT_TESTED,
    TIER,
    TONE,
    CATEGORY,
    resolveApoe,
};
