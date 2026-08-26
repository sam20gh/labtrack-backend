const GenotypeFile = require('../models/GenotypeFile');
const Interpretation = require('../models/Interpretation');

/**
 * Genotype report reads.
 *
 * The whole safety model of this controller is `visibleFindings`. Tier filtering happens
 * here, on the server, not in the app — a client that forgets to filter must not be able to
 * expose a risk result the user never asked to see. Suppressed entries never leave the
 * process at all.
 */

/**
 * Has a clinician signed off an interpretation covering this sample?
 *
 * Clinician-tier findings are held until they have. Rather than blanking them out — which
 * makes the app look broken — they come back as placeholders carrying the name and category
 * but none of the interpretation, so the UI can show an honest "being reviewed" row.
 */
const isClinicianReleased = async (userId, genotypeFileId) => {
    const reviewed = await Interpretation.findOne({
        userId,
        'covers.id': genotypeFileId,
        'review.status': { $in: ['approved', 'amended'] },
    }).select('_id').lean();
    return Boolean(reviewed);
};

/**
 * Did this sample clear the quality floor?
 *
 * Computed here rather than read from the model's `passedQc` virtual: `mongoose-lean-virtuals`
 * is not installed, so `.lean({ virtuals: true })` silently returns nothing and the field
 * would always be undefined. The virtual still serves non-lean reads.
 */
const qcPassed = (file) =>
    typeof file?.qc?.callRate === 'number' ? file.qc.callRate >= 0.98 : null;

const withheld = (finding, reason) => ({
    rsid: finding.rsid,
    gene: finding.gene,
    name: finding.name,
    category: finding.category,
    tier: finding.tier,
    status: finding.status,
    withheld: true,
    withheldReason: reason,
});

/**
 * Apply tier rules to a finding list.
 *
 * - suppressed → dropped entirely, never serialised
 * - opt_in     → dropped unless the user has explicitly consented
 * - clinician  → withheld placeholder until an interpretation is signed off
 * - release    → returned as-is
 */
const visibleFindings = (findings, { clinicianReleased, riskOptIn }) => {
    const out = [];

    for (const f of findings) {
        if (f.tier === 'suppressed') continue;

        if (f.tier === 'opt_in') {
            if (!riskOptIn) continue;
            out.push(f);
            continue;
        }

        if (f.tier === 'clinician' && !clinicianReleased) {
            out.push(withheld(f, 'Awaiting clinician review'));
            continue;
        }

        out.push(f);
    }

    return out;
};

/** Counts the app needs for section headers, computed after filtering. */
const summarise = (findings) => ({
    total: findings.length,
    shown: findings.filter((f) => !f.withheld && f.status === 'called').length,
    withheld: findings.filter((f) => f.withheld).length,
    notCovered: findings.filter((f) => f.status === 'not_covered').length,
});

/** GET /api/genotypes — the caller's samples, newest first. No findings in the list view. */
exports.listGenotypeFiles = async (req, res) => {
    try {
        const files = await GenotypeFile.find({ userId: req.auth.userId })
            .select('-findings -notTested')
            .sort({ createdAt: -1 })
            .lean();

        res.json({ files: files.map((f) => ({ ...f, passedQc: qcPassed(f) })) });
    } catch (error) {
        console.error('❌ Error listing genotype files:', error);
        res.status(500).json({ message: 'Error fetching genotype results', error: error.message });
    }
};

/** GET /api/genotypes/:id — one sample's report, tier-filtered for the caller. */
exports.getGenotypeFile = async (req, res) => {
    try {
        const file = await GenotypeFile.findOne({
            _id: req.params.id,
            userId: req.auth.userId,
        }).lean();

        if (!file) return res.status(404).json({ message: 'Genotype result not found' });

        const clinicianReleased = await isClinicianReleased(req.auth.userId, file._id);
        const riskOptIn = Boolean(file.consent?.riskResultsOptIn);

        const findings = visibleFindings(file.findings || [], { clinicianReleased, riskOptIn });

        // The raw file location is deliberately not serialised to the app.
        const { findings: _f, sourceFile: _s, ...rest } = file;

        res.json({
            file: {
                ...rest,
                passedQc: qcPassed(file),
                findings,
                summary: summarise(findings),
                clinicianReleased,
                // So the app can offer the opt-in without knowing what sits behind it
                riskResultsAvailable: (file.findings || []).some((f) => f.tier === 'opt_in' && f.status === 'called'),
            },
        });
    } catch (error) {
        console.error('❌ Error fetching genotype file:', error);
        res.status(500).json({ message: 'Error fetching genotype result', error: error.message });
    }
};

/**
 * POST /api/genotypes/:id/consent — opt in or out of risk-bearing results.
 *
 * Opting out clears the timestamp too, so a later opt-in records a fresh, current consent
 * rather than resurrecting an old one.
 */
exports.setRiskConsent = async (req, res) => {
    try {
        const { optIn } = req.body;
        if (typeof optIn !== 'boolean') {
            return res.status(400).json({ message: '`optIn` must be true or false' });
        }

        const file = await GenotypeFile.findOneAndUpdate(
            { _id: req.params.id, userId: req.auth.userId },
            {
                $set: {
                    'consent.riskResultsOptIn': optIn,
                    'consent.optedInAt': optIn ? new Date() : null,
                },
            },
            { new: true, runValidators: true },
        ).lean();

        if (!file) return res.status(404).json({ message: 'Genotype result not found' });

        const clinicianReleased = await isClinicianReleased(req.auth.userId, file._id);
        const findings = visibleFindings(file.findings || [], {
            clinicianReleased,
            riskOptIn: optIn,
        });

        console.log(`🧬 Risk consent ${optIn ? 'granted' : 'withdrawn'} for genotype ${file._id}`);

        res.json({
            message: optIn ? 'Risk results unlocked' : 'Risk results hidden',
            consent: file.consent,
            findings,
            summary: summarise(findings),
        });
    } catch (error) {
        console.error('❌ Error updating risk consent:', error);
        res.status(400).json({ message: 'Error updating consent', error: error.message });
    }
};

/** GET /api/genotypes/:id/coverage — what this test did not examine. Never filtered. */
exports.getCoverage = async (req, res) => {
    try {
        const file = await GenotypeFile.findOne({
            _id: req.params.id,
            userId: req.auth.userId,
        }).select('notTested assayType chip chipManifestVersion qc').lean();

        if (!file) return res.status(404).json({ message: 'Genotype result not found' });

        res.json({
            assayType: file.assayType,
            chip: file.chip,
            manifestVersion: file.chipManifestVersion,
            callRate: file.qc?.callRate,
            notTested: file.notTested || [],
        });
    } catch (error) {
        console.error('❌ Error fetching coverage:', error);
        res.status(500).json({ message: 'Error fetching coverage', error: error.message });
    }
};

module.exports.visibleFindings = visibleFindings;
