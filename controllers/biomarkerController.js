const Biomarker = require('../models/Biomarker');
const ReferenceRange = require('../models/ReferenceRange');
const TestResult = require('../models/testResultModel');
const User = require('../models/userModel');
const { evaluate } = require('../utils/biomarkerEvaluator');

/** Normalise a reported analyte name into the canonical key used for trending. */
const canonicalise = (name) =>
    String(name).trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');

/**
 * Evaluate and persist a set of measurements for one user.
 * Shared by manual entry and (from Phase 3) document parsing.
 */
const persistMeasurements = async ({ userId, user, measurements, testResultId, source }) => {
    const saved = [];

    for (const m of measurements) {
        const name = canonicalise(m.name);
        const value = Number(m.value);
        if (!name || Number.isNaN(value)) continue;

        const measuredAt = m.measuredAt ? new Date(m.measuredAt) : new Date();
        const { flag, appliedRange } = await evaluate({ userId, name, value, user, measuredAt });

        saved.push(await Biomarker.create({
            userId,
            name,
            displayName: m.displayName || m.name,
            value,
            unit: m.unit || appliedRange?.unit || '',
            measuredAt,
            testResultId,
            source: source || 'manual_entry',
            flag,
            appliedRange,
            reportedRange: m.reportedRange,
            needsReview: Boolean(m.needsReview),
            extractionConfidence: m.extractionConfidence,
            notes: m.notes,
        }));
    }

    return saved;
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

        const saved = await persistMeasurements({ userId, user, measurements, testResultId, source });

        if (testResultId) {
            await TestResult.findByIdAndUpdate(testResultId, {
                $inc: { biomarkerCount: saved.length },
                $set: { parseStatus: 'parsed' },
            }, { runValidators: true });
        }

        res.status(201).json({ message: `${saved.length} measurements recorded`, biomarkers: saved });
    } catch (error) {
        console.error('❌ Error adding biomarkers:', error);
        res.status(500).json({ message: 'Error adding biomarkers', error: error.message });
    }
};

/**
 * GET /api/biomarkers/latest — most recent value for each analyte.
 * Powers the results grid; one row per biomarker, newest first.
 */
exports.getLatest = async (req, res) => {
    try {
        const userId = req.auth.userId;
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

        const withDelta = latest.map((b) => ({
            ...b,
            delta: b.previous ? Number((b.value - b.previous.value).toFixed(4)) : null,
            direction: b.previous
                ? (b.value > b.previous.value ? 'up' : b.value < b.previous.value ? 'down' : 'flat')
                : null,
        }));

        res.json({ biomarkers: withDelta });
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
            return res.json({ name, series: [], range: null, summary: null });
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

exports.persistMeasurements = persistMeasurements;
exports.canonicalise = canonicalise;
