const DnaReport = require('../models/DnaReport');

/** POST /api/dna-reports — record an uploaded genetic report. */
exports.createDnaReport = async (req, res) => {
    try {
        const { labName, reportDate, documentUrl, mutations, orderId } = req.body;

        const report = await DnaReport.create({
            userId: req.auth.userId,
            labName,
            reportDate,
            documentUrl,
            orderId,
            mutations: mutations || [],
            // Interpretation is a separate, explicit step (Phase 4)
            status: 'uploaded',
        });

        res.status(201).json({ message: 'DNA report created', report });
    } catch (error) {
        console.error('❌ Error creating DNA report:', error);
        res.status(400).json({ message: 'Error creating DNA report', error: error.message });
    }
};

/** GET /api/dna-reports — the caller's reports, newest first. */
exports.getDnaReports = async (req, res) => {
    try {
        const reports = await DnaReport.find({ userId: req.auth.userId })
            .sort({ createdAt: -1 })
            .lean();
        res.json({ reports });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching DNA reports', error: error.message });
    }
};

/** GET /api/dna-reports/:id */
exports.getDnaReport = async (req, res) => {
    try {
        const report = await DnaReport.findOne({ _id: req.params.id, userId: req.auth.userId });
        if (!report) return res.status(404).json({ message: 'DNA report not found' });
        res.json({ report });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching DNA report', error: error.message });
    }
};

/**
 * PUT /api/dna-reports/:id — amend report metadata or mutations.
 * Interpretation and review fields are deliberately not writable here: they are set by the
 * AI pipeline (Phase 4) and the professional review flow (Phase 7) respectively, so a user
 * cannot mark their own report clinically reviewed.
 */
exports.updateDnaReport = async (req, res) => {
    try {
        const { labName, reportDate, documentUrl, mutations } = req.body;
        const updates = {};
        if (labName !== undefined) updates.labName = labName;
        if (reportDate !== undefined) updates.reportDate = reportDate;
        if (documentUrl !== undefined) updates.documentUrl = documentUrl;
        if (mutations !== undefined) updates.mutations = mutations;

        const report = await DnaReport.findOneAndUpdate(
            { _id: req.params.id, userId: req.auth.userId },
            { $set: updates },
            { new: true, runValidators: true }
        );
        if (!report) return res.status(404).json({ message: 'DNA report not found' });
        res.json({ message: 'DNA report updated', report });
    } catch (error) {
        res.status(400).json({ message: 'Error updating DNA report', error: error.message });
    }
};

/** DELETE /api/dna-reports/:id */
exports.deleteDnaReport = async (req, res) => {
    try {
        const deleted = await DnaReport.findOneAndDelete({ _id: req.params.id, userId: req.auth.userId });
        if (!deleted) return res.status(404).json({ message: 'DNA report not found' });
        res.json({ message: 'DNA report deleted' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting DNA report', error: error.message });
    }
};

/**
 * GET /api/dna-reports/review-queue — reports awaiting professional sign-off.
 * Professionals and admins only.
 */
exports.getReviewQueue = async (req, res) => {
    try {
        const reports = await DnaReport.find({ status: 'ai_interpreted' })
            .sort({ createdAt: 1 })
            .populate('userId', 'firstName lastName dob gender')
            .lean();
        res.json({ reports });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching review queue', error: error.message });
    }
};
