/**
 * Raw genotype file parsing and panel extraction.
 *
 * Streams the file rather than reading it into memory: a genotyping export is ~20 MB and
 * 600k+ rows, which is both slow to hold and larger than the 16 MB BSON document ceiling.
 * Nothing here ever builds a full in-memory array of calls — only the panel subset survives.
 *
 * The extraction is an allowlist lookup, not a scan. We ask the panel what we need and pull
 * exactly those rsIDs out of the stream, so the work is bounded by the panel size (tens of
 * entries) rather than the file size (hundreds of thousands of rows).
 */
const fs = require('fs');
const readline = require('readline');
const zlib = require('zlib');
const {
    PANEL, PANEL_RSIDS, PANEL_VERSION, BY_RSID, APOE, NOT_TESTED, TIER, resolveApoe,
} = require('./dnaPanel');

const COMPLEMENT = { A: 'T', T: 'A', C: 'G', G: 'C' };

/** Alleles sorted alphabetically so AG and GA compare equal. */
const canonical = (genotype) => genotype.toUpperCase().split('').sort().join('');

const reverseComplement = (genotype) => {
    const flipped = genotype.toUpperCase().split('').map((base) => COMPLEMENT[base]);
    return flipped.includes(undefined) ? null : flipped.sort().join('');
};

/**
 * A SNP whose two alleles are complements of each other (A/T or C/G) reads identically on
 * both strands, so orientation cannot be recovered from the genotype alone. We still match
 * it, but the result is flagged so the ambiguity is visible rather than silently assumed.
 */
const isPalindromic = (alleleSet) => {
    const a = [...alleleSet].sort().join('');
    return a === 'AT' || a === 'CG';
};

/** Every distinct base an entry's declared genotypes use. */
const allelesOf = (entry) => new Set(Object.keys(entry.genotypes).join('').split(''));

/**
 * Match an observed genotype against a panel entry.
 *
 * Tries the declared orientation first, then the reverse complement — vendors differ, and
 * dbSNP's orientation for an rsID is not always the one an export uses. Anything matching
 * neither returns `unmatched` rather than a guess: a wrong strand silently inverts a risk
 * call, which is the worst possible failure mode here.
 */
const matchGenotype = (entry, observed) => {
    const direct = canonical(observed);

    if (entry.genotypes[direct]) {
        return {
            genotype: direct,
            ...entry.genotypes[direct],
            strandFlipped: false,
            strandAmbiguous: isPalindromic(allelesOf(entry)),
        };
    }

    const flipped = reverseComplement(observed);
    if (flipped && entry.genotypes[flipped]) {
        return {
            genotype: flipped,
            observedAs: direct,
            ...entry.genotypes[flipped],
            strandFlipped: true,
            strandAmbiguous: false,
        };
    }

    return { unmatched: true, genotype: direct };
};

/**
 * Parse a raw genotype export and extract the panel.
 *
 * Accepts the MyHeritage/23andMe-style CSV, gzipped or plain. Returns QC metrics for the
 * whole file plus findings for the panel subset only.
 */
const parseGenotypeFile = async (filePath) => {
    const raw = fs.createReadStream(filePath);
    const stream = filePath.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw;
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    const meta = {};
    const calls = new Map();          // panel rsIDs only
    const perChromosome = {};

    let total = 0;
    let noCalls = 0;
    let indelCalls = 0;
    let yCalls = 0;
    let xTotal = 0;
    let xHet = 0;
    let sawHeader = false;

    for await (const line of rl) {
        if (!line) continue;

        // `##key=value` metadata, then `#` free-text comments, then the column header.
        if (line.startsWith('##')) {
            const [key, ...rest] = line.slice(2).split('=');
            if (rest.length) meta[key.trim()] = rest.join('=').trim();
            continue;
        }
        if (line.startsWith('#')) continue;

        if (!sawHeader && /^"?RSID"?\s*,/i.test(line)) { sawHeader = true; continue; }

        const parts = line.split(',').map((f) => f.trim().replace(/^"|"$/g, ''));
        if (parts.length < 4) continue;

        const [rsid, chromosome, position, result] = parts;
        total++;
        perChromosome[chromosome] = (perChromosome[chromosome] || 0) + 1;

        const isNoCall = result === '--' || result === '';
        const isIndel = /[ID]/.test(result);

        if (isNoCall) noCalls++;
        if (isIndel) indelCalls++;

        // Sex inference inputs
        if (chromosome === 'Y' && !isNoCall) yCalls++;
        if (chromosome === 'X') {
            xTotal++;
            if (!isNoCall && !isIndel && result[0] !== result[1]) xHet++;
        }

        if (!PANEL_RSIDS.has(rsid)) continue;

        // Indel probes are dropped wholesale. In the reference sample 768 of 799 I/D calls
        // sat on chromosome X in a male — homozygous calls on a single X are structurally
        // impossible, so the channel is miscoding at scale. One of those rows reads as a
        // homozygous pathogenic BRCA1 frameshift, which is not survivable and is plainly an
        // artifact. Nothing from this channel is trustworthy enough to show anyone.
        if (isIndel) { calls.set(rsid, { rsid, chromosome, position, result, rejected: 'indel' }); continue; }
        if (isNoCall) { calls.set(rsid, { rsid, chromosome, position, result, rejected: 'no_call' }); continue; }

        calls.set(rsid, { rsid, chromosome, position, result });
    }

    const xHetRate = xTotal ? xHet / xTotal : 0;
    const inferredSex = yCalls > 500 && xHetRate < 0.1 ? 'male'
        : yCalls < 100 ? 'female'
            : 'undetermined';

    return {
        meta: {
            vendor: meta.fileformat || 'unknown',
            format: meta.format || null,
            chip: meta.chip || null,
            referenceBuild: meta.reference || null,
            generatedAt: meta.timestamp ? new Date(meta.timestamp) : null,
        },
        qc: {
            totalCalls: total,
            noCalls,
            callRate: total ? Number(((total - noCalls) / total).toFixed(5)) : 0,
            indelCalls,
            inferredSex,
            xHeterozygosity: Number(xHetRate.toFixed(5)),
            yCalls,
            hasMitochondrial: Boolean(perChromosome.MT),
            chromosomes: Object.keys(perChromosome).length,
        },
        calls,
    };
};

/**
 * Turn extracted calls into panel findings.
 *
 * Every panel entry produces a row — including the ones the chip does not carry. An entry
 * with no call becomes `not_covered`, which is what lets the UI distinguish "we looked and
 * found nothing" from "we never looked". Collapsing those two is the single most common way
 * a genetics report misleads someone.
 */
const extractFindings = (calls) => {
    const findings = [];

    for (const entry of PANEL) {
        const call = calls.get(entry.rsid);

        if (!call) {
            findings.push({
                rsid: entry.rsid, gene: entry.gene, name: entry.name,
                category: entry.category, tier: entry.tier,
                status: 'not_covered',
                detail: 'This variant is not on the chip used for this test.',
            });
            continue;
        }

        if (call.rejected) {
            findings.push({
                rsid: entry.rsid, gene: entry.gene, name: entry.name,
                category: entry.category, tier: entry.tier,
                status: call.rejected === 'indel' ? 'rejected_indel' : 'no_call',
                detail: call.rejected === 'indel'
                    ? 'Reported through the insertion/deletion channel, which is not reliable enough to report.'
                    : 'The chip did not return a reading at this position.',
            });
            continue;
        }

        const match = matchGenotype(entry, call.result);

        if (match.unmatched) {
            // Deliberately not interpreted. An unexpected genotype means our orientation
            // assumption is wrong, and a wrong orientation inverts the meaning.
            findings.push({
                rsid: entry.rsid, gene: entry.gene, name: entry.name,
                category: entry.category, tier: entry.tier,
                status: 'unmatched', genotype: match.genotype,
                detail: 'The reading did not match any expected genotype for this variant, so it has not been interpreted.',
            });
            continue;
        }

        findings.push({
            rsid: entry.rsid,
            gene: entry.gene,
            alleleName: entry.alleleName || null,
            name: entry.name,
            category: entry.category,
            tier: entry.tier,
            status: 'called',
            genotype: match.genotype,
            tone: match.tone,
            label: match.label,
            detail: match.detail,
            evidence: entry.evidence,
            affectsBiomarker: entry.affectsBiomarker || null,
            incomplete: entry.incomplete || null,
            suppressionReason: entry.suppressionReason || null,
            strandFlipped: match.strandFlipped,
            strandAmbiguous: match.strandAmbiguous || false,
        });
    }

    // APOE is a two-SNP haplotype and cannot be a normal entry.
    const a1 = calls.get('rs429358');
    const a2 = calls.get('rs7412');
    const apoe = resolveApoe(
        a1 && !a1.rejected ? a1.result : null,
        a2 && !a2.rejected ? a2.result : null,
    );

    if (apoe) {
        findings.push({
            rsid: APOE.rsids.join('+'),
            gene: APOE.gene,
            name: APOE.name,
            category: APOE.category,
            tier: APOE.tier,
            status: apoe.ambiguous ? 'ambiguous' : apoe.unresolved ? 'unmatched' : 'called',
            genotype: apoe.diplotype || null,
            tone: apoe.e4Count ? 'increased' : 'typical',
            label: apoe.diplotype ? `APOE ${apoe.diplotype}` : 'Could not be resolved',
            detail: apoe.detail,
            evidence: APOE.evidence,
            counselling: APOE.counselling,
            derivedFrom: apoe.calls,
        });
    }

    return findings;
};

/** Summary counts, so the API and the seed script report the same numbers. */
const summarise = (findings) => {
    const shown = findings.filter((f) => f.tier !== TIER.SUPPRESSED);
    return {
        panelSize: findings.length,
        called: shown.filter((f) => f.status === 'called').length,
        notCovered: shown.filter((f) => f.status === 'not_covered').length,
        rejected: shown.filter((f) => f.status === 'rejected_indel' || f.status === 'no_call').length,
        unmatched: shown.filter((f) => f.status === 'unmatched' || f.status === 'ambiguous').length,
        suppressed: findings.filter((f) => f.tier === TIER.SUPPRESSED).length,
        byTier: {
            release: shown.filter((f) => f.tier === TIER.RELEASE && f.status === 'called').length,
            clinician: shown.filter((f) => f.tier === TIER.CLINICIAN && f.status === 'called').length,
            optIn: shown.filter((f) => f.tier === TIER.OPT_IN && f.status === 'called').length,
        },
    };
};

module.exports = {
    parseGenotypeFile,
    extractFindings,
    summarise,
    matchGenotype,
    canonical,
    reverseComplement,
    PANEL_VERSION,
    NOT_TESTED,
};
