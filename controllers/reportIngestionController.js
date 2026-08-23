const fs = require('fs');
const TestResult = require('../models/testResultModel');
const User = require('../models/userModel');
const { parseReport, partitionByConfidence, isConfigured, CONFIDENCE_THRESHOLD } = require('../utils/reportParser');
const { persistMeasurements } = require('./biomarkerController');
const { normaliseMeasurement } = require('../utils/unitNormaliser');

const ACCEPTED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * POST /api/reports/parse — extract measurements from an uploaded report.
 *
 * Deliberately does NOT save anything. It returns a preview the user confirms, because
 * writing model output straight into a medical record removes the one checkpoint where a
 * misread digit can still be caught. `POST /api/reports/confirm` performs the write.
 */
exports.parseUploadedReport = async (req, res) => {
    let tempPath;
    try {
        if (!isConfigured()) {
            return res.status(503).json({
                message: 'Automatic parsing is unavailable. Please enter results manually.',
                manualEntryAvailable: true,
            });
        }
        if (!req.file) return res.status(400).json({ message: 'No document uploaded' });

        tempPath = req.file.path;

        if (!ACCEPTED.includes(req.file.mimetype)) {
            return res.status(400).json({
                message: `Unsupported file type: ${req.file.mimetype}. Upload a PDF or photo.`,
            });
        }
        if (req.file.size > MAX_BYTES) {
            return res.status(400).json({ message: 'Document exceeds the 20MB limit' });
        }

        const buffer = fs.readFileSync(tempPath);
        const result = await parseReport(buffer, req.file.mimetype);

        if (!result.ok) {
            return res.status(502).json({ message: result.error, manualEntryAvailable: true });
        }

        const { confident, needsReview } = partitionByConfidence(result.data.measurements);

        // Preview the normalised form so the user confirms what will actually be stored,
        // not the raw reading — units may be converted between the two.
        const preview = [...confident, ...needsReview].map((m) => {
            const norm = normaliseMeasurement(m);
            return {
                ...m,
                canonicalName: norm.name,
                displayName: norm.displayName,
                normalisedValue: norm.value,
                normalisedUnit: norm.unit,
                recognised: norm.recognised,
                needsReview: Boolean(m.needsReview) || norm.needsReview,
                normalisationNote: norm.normalisationNote,
            };
        });

        res.json({
            message: `${preview.length} measurements found`,
            report: {
                labName: result.data.lab_name,
                collectionDate: result.data.collection_date,
                testType: result.data.test_type,
                unreadableRegions: result.data.unreadable_regions || [],
            },
            measurements: preview,
            requiresReviewCount: preview.filter((m) => m.needsReview).length,
            confidenceThreshold: CONFIDENCE_THRESHOLD,
        });
    } catch (error) {
        console.error('❌ Report ingestion failed:', error);
        res.status(500).json({ message: 'Could not process the document', error: error.message });
    } finally {
        // Medical documents must not linger on disk after processing
        if (tempPath && fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
        }
    }
};

/**
 * POST /api/reports/confirm — save measurements the user has reviewed.
 *
 * Creates the TestResult and its Biomarker rows together, so a confirmed report always
 * lands as one coherent record.
 */
exports.confirmReport = async (req, res) => {
    try {
        const userId = req.auth.userId;
        const { labName, testType, collectionDate, measurements, documentUrl, interpretation } = req.body;

        if (!Array.isArray(measurements) || !measurements.length) {
            return res.status(400).json({ message: 'measurements must be a non-empty array' });
        }

        const user = await User.findById(userId).select('dob gender');
        if (!user) return res.status(404).json({ message: 'User not found' });

        const measuredAt = collectionDate ? new Date(collectionDate) : new Date();

        const testResult = await TestResult.create({
            patient: {
                user_id: userId,
                date_of_test: measuredAt,
                lab_name: labName || 'Unknown laboratory',
                test_type: testType || 'Lab report',
            },
            // Raw values kept alongside the structured rows so a re-parse never needs a re-upload
            results: measurements.reduce((acc, m) => {
                acc[m.name] = { value: m.value, unit: m.unit, reference_range: m.reportedRange?.raw };
                return acc;
            }, {}),
            interpretation,
            documentUrl,
            source: 'document_upload',
            parseStatus: 'parsed',
        });

        const saved = await persistMeasurements({
            userId,
            user,
            measurements: measurements.map((m) => ({ ...m, measuredAt: m.measuredAt || measuredAt })),
            testResultId: testResult._id,
            source: 'lab_report',
        });

        await TestResult.findByIdAndUpdate(
            testResult._id,
            { $set: { biomarkerCount: saved.length } },
            { runValidators: true }
        );

        const flagged = saved.filter((b) => !['normal', 'unknown'].includes(b.flag));

        res.status(201).json({
            message: `${saved.length} measurements saved`,
            testResult,
            biomarkers: saved,
            flagged: flagged.map((b) => ({
                name: b.name, displayName: b.displayName, value: b.value, unit: b.unit,
                flag: b.flag, geneAdjusted: b.appliedRange?.geneAdjusted || false,
            })),
        });
    } catch (error) {
        console.error('❌ Report confirmation failed:', error);
        res.status(500).json({ message: 'Could not save the report', error: error.message });
    }
};

/** GET /api/reports/status — whether automatic parsing is available to the client. */
exports.getIngestionStatus = async (req, res) => {
    res.json({
        automaticParsing: isConfigured(),
        manualEntry: true,
        acceptedTypes: ACCEPTED,
        maxBytes: MAX_BYTES,
    });
};
