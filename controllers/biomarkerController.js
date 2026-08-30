const Biomarker = require('../models/Biomarker');
const ReferenceRange = require('../models/ReferenceRange');
const TestResult = require('../models/testResultModel');
const User = require('../models/userModel');
const { evaluate } = require('../utils/biomarkerEvaluator');
const { normaliseMeasurement, resolveName, slug } = require('../utils/unitNormaliser');
const { explain } = require('../utils/biomarkerGlossary');

/**
 * Canonical key for lookups. Prefers the alias table (so 'Hb' and 'Serum Ferritin' resolve
 * correctly); falls back to a slug for analytes outside the catalogue.
 */
const canonicalise = (name) =>
    resolveName(name) ?? slug(name).replace(/[^a-z0-9]/g, '_');

/**
 * A genotype call dressed up as a measurement.
 *
 * `rs429358`-style identifiers are dbSNP reference numbers, not analytes. They reached the
 * biomarker collection because a genetic report was uploaded through the lab-report path,
 * and they are unusable there: no unit, no reference range, no trend, no plain-language
 * description, and nothing the person can act on. Two of them sat in a live results grid
 * beside ferritin and cholesterol carrying bare percentages.
 *
 * Rejected rather than stored-and-hidden, so the caller reports it and the upload path that
 * produced it is visible instead of quietly accumulating junk. Genotype data belongs in
 * `GenotypeFile.findings`, reached through `/api/genotype`.
 */
const isGenotypeCall = (name) => /^\s*rs\d+/i.test(String(name || ''));

/**
 * Evaluate and persist a set of measurements for one user.
 * Shared by manual entry and (from Phase 3) document parsing.
 */
const persistMeasurements = async ({ userId, user, measurements, testResultId, source }) => {
    const saved = [];
    /** Rows that could not be stored, so the caller can report partial success. */
    const failed = [];

    for (const m of measurements) {
        if (isGenotypeCall(m.name)) {
            failed.push({
                name: m.name,
                value: m.value,
                unit: m.unit,
                reason: 'Genetic variant, not a measurement — upload genetic data via /api/genotype',
            });
            continue;
        }

        // Convert to canonical name + unit BEFORE any range comparison. Skipping this would
        // compare e.g. 90 mg/dL glucose against a mmol/L range and report critical_high.
        const norm = normaliseMeasurement(m);
        if (!norm.name || Number.isNaN(norm.value)) continue;

        const measuredAt = m.measuredAt ? new Date(m.measuredAt) : new Date();
        const needsReview = Boolean(m.needsReview) || norm.needsReview;

        // An unrecognised analyte or unit must not be flagged against a range that may not
        // apply — store it, mark it for confirmation, and leave the verdict to a human.
        const evaluation = needsReview
            ? { flag: 'unknown', appliedRange: null }
            : await evaluate({ userId, name: norm.name, value: norm.value, user, measuredAt });

        const notes = [m.notes, norm.normalisationNote].filter(Boolean).join(' · ') || undefined;

        // Isolated per row: a single malformed measurement must not discard a whole report
        try {
            saved.push(await Biomarker.create({
                userId,
                name: norm.name,
                displayName: norm.displayName || m.name,
                value: norm.value,
                unit: norm.unit || evaluation.appliedRange?.unit || '',
                measuredAt,
                testResultId,
                source: source || 'manual_entry',
                flag: evaluation.flag,
                appliedRange: evaluation.appliedRange,
                reportedRange: m.reportedRange,
                needsReview,
                extractionConfidence: m.extractionConfidence,
                notes,
            }));
        } catch (error) {
            console.error(`⚠️ Could not store "${m.name}":`, error.message);
            failed.push({ name: m.name, value: m.value, unit: m.unit, reason: error.message });
        }
    }

    return { saved, failed };
};

/** POST /api/biomarkers — record one or more measurements. */
exports.addBiomarkers = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const { measurements, testResultId, source } = req.body;

        if (!Array.isArray(measurements) || !measurements.length) {
            return res.status(400).json({ message: 'measurements must be a non-empty array' });
        }

        const user = await User.findById(userId).select('dob gender');
        if (!user) return res.status(404).json({ message: 'User not found' });

        // A caller must not attach measurements to someone else's report
        if (testResultId) {
            const owns = await TestResult.exists({ _id: testResultId, 'patient.user_id': userId });
            if (!owns) return res.status(404).json({ message: 'Test result not found' });
        }

        const { saved, failed } = await persistMeasurements({ userId, user, measurements, testResultId, source });

        if (testResultId) {
            await TestResult.findByIdAndUpdate(testResultId, {
                $inc: { biomarkerCount: saved.length },
                $set: { parseStatus: 'parsed' },
            }, { runValidators: true });
        }

        res.status(201).json({
            message: `${saved.length} measurements recorded`,
            biomarkers: saved,
            failed,
        });
    } catch (error) {
        console.error('❌ Error adding biomarkers:', error);
        res.status(500).json({ message: 'Error adding biomarkers', error: error.message });
    }
};

/**
 * GET /api/biomarkers/latest — most recent value for each analyte.
 * Powers the results grid; one row per biomarker, newest first.
 */
/**
 * The newest reading of every analyte for one person, with a delta against the one before.
 *
 * Extracted from `getLatest` so the score engine reads biomarkers through exactly the same
 * query the results screen does. Two implementations of "latest biomarkers" is how the
 * Markers pillar starts disagreeing with the list the person is looking at.
 */
const latestForUser = async (userId) => {
    const mongoose = require('mongoose');

    const latest = await Biomarker.aggregate([
        { $match: { userId: new mongoose.Types.ObjectId(String(userId)) } },
        { $sort: { measuredAt: -1 } },
        {
            $group: {
                _id: '$name',
                doc: { $first: '$$ROOT' },
                // Second-newest enables a delta arrow without another query
                history: { $push: { value: '$value', measuredAt: '$measuredAt' } },
            },
        },
        {
            $project: {
                _id: '$doc._id',
                name: '$doc.name',
                displayName: '$doc.displayName',
                value: '$doc.value',
                unit: '$doc.unit',
                measuredAt: '$doc.measuredAt',
                flag: '$doc.flag',
                appliedRange: '$doc.appliedRange',
                previous: { $arrayElemAt: ['$history', 1] },
                measurementCount: { $size: '$history' },
            },
        },
        { $sort: { name: 1 } },
    ]);

    return latest.map((b) => ({
        ...b,
        delta: b.previous ? Number((b.value - b.previous.value).toFixed(4)) : null,
        direction: b.previous
            ? (b.value > b.previous.value ? 'up' : b.value < b.previous.value ? 'down' : 'flat')
            : null,
        // Plain-language name and explanation. The app is consumer-facing: "MCV 88 fL"
        // is unreadable to the person whose blood it is. Null for analytes outside the
        // catalogue, and the client falls back to the medical name alone.
        explainer: explain(b.name),
    }));
};

exports.getLatest = async (req, res) => {
    try {
        res.json({ biomarkers: await latestForUser(req.auth.userId) });
    } catch (error) {
        console.error('❌ Error fetching latest biomarkers:', error);
        res.status(500).json({ message: 'Error fetching biomarkers', error: error.message });
    }
};

/**
 * GET /api/biomarkers/:name/trend — full history for one analyte.
 * Returns the current reference band alongside the series so a chart can shade it.
 */
exports.getTrend = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const name = canonicalise(req.params.name);
        const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

        const series = await Biomarker.find({ userId, name })
            .sort({ measuredAt: 1 })
            .limit(limit)
            .select('value unit measuredAt flag appliedRange testResultId')
            .lean();

        if (!series.length) {
            return res.json({ name, series: [], range: null, summary: null, explainer: explain(name) });
        }

        // The range on the newest point is the one currently in force for this user
        const range = series[series.length - 1].appliedRange || null;
        const values = series.map((s) => s.value);
        const first = values[0];
        const last = values[values.length - 1];

        res.json({
            name,
            displayName: series[0].displayName,
            unit: series[0].unit,
            explainer: explain(name),
            series,
            range,
            summary: {
                count: series.length,
                first,
                last,
                change: Number((last - first).toFixed(4)),
                direction: last > first ? 'up' : last < first ? 'down' : 'flat',
                min: Math.min(...values),
                max: Math.max(...values),
                outOfRangeCount: series.filter((s) => !['normal', 'unknown'].includes(s.flag)).length,
            },
        });
    } catch (error) {
        console.error('❌ Error fetching trend:', error);
        res.status(500).json({ message: 'Error fetching trend', error: error.message });
    }
};

/** DELETE /api/biomarkers/:id — remove a measurement (e.g. a bad parse). */
exports.deleteBiomarker = async (req, res) => {
    try {
        const deleted = await Biomarker.findOneAndDelete({
            _id: req.params.id,
            userId: req.auth.userId,
        });
        if (!deleted) return res.status(404).json({ message: 'Measurement not found' });
        res.json({ message: 'Measurement deleted' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting measurement', error: error.message });
    }
};

/** GET /api/biomarkers/reference-ranges — the catalogue, for manual-entry pickers. */
exports.getReferenceRanges = async (req, res) => {
    try {
        const ranges = await ReferenceRange.find({ isActive: true })
            .sort({ biomarker: 1, sex: 1, ageMin: 1 })
            .lean();
        res.json({ ranges });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching reference ranges', error: error.message });
    }
};

/** GET /api/biomarkers/catalogue — canonical analytes and the units we accept. */
exports.getCatalogue = async (req, res) => {
    const { listBiomarkers } = require('../utils/unitNormaliser');
    // Carries the explainer too, so a manual-entry picker can tell someone what they are
    // about to type a number into.
    res.json({
        biomarkers: listBiomarkers().map((b) => ({ ...b, explainer: explain(b.name) })),
    });
};

exports.persistMeasurements = persistMeasurements;
exports.isGenotypeCall = isGenotypeCall;
exports.canonicalise = canonicalise;
exports.latestForUser = latestForUser;
