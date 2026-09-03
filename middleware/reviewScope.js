/**
 * Clinician scope.
 *
 * `requireRole('professional')` answers "is this a clinician?". It does not answer "does
 * this clinician have any business reading *this* patient?", and those are different
 * questions: the first is authentication wearing a hat, the second is authorisation.
 *
 * Without this, a professional token could walk the patient-context endpoint by id and read
 * every medical record in the product. That was acceptable while review was a two-person
 * operation and the only route in was a queue; it is not acceptable once a portal makes
 * browsing by id a single URL edit.
 *
 * ## What counts as a reason
 *
 * A clinician may read a patient when an interpretation of that patient's either
 *
 *   - is **in the review queue** (`review.status: 'pending'`) — the work they are here for; or
 *   - was **reviewed by them** — the case is theirs, and follow-up is part of reviewing it.
 *
 * That is deliberately looser than WEB-PORTAL.md's end state, which adds explicit
 * assignment and expiry. It is written as one function so tightening it later is a change
 * here and nowhere else: the screens do not know how scope is decided.
 *
 * Admins pass. They already bypass `requireSelf` throughout `middleware/ownership.js`, so
 * refusing them here would describe a boundary the rest of the API does not enforce — the
 * honest control on an admin is the audit log, which records them like anyone else.
 */
const Interpretation = require('../models/Interpretation');

const requireReviewScope = async (req, res, next) => {
    try {
        if (!req.auth) return res.status(401).json({ message: 'Authentication required' });

        if (req.auth.role === 'admin') return next();
        if (req.auth.role !== 'professional') {
            return res.status(403).json({ message: 'Insufficient permissions' });
        }

        const patientId = req.params.userId;
        if (!patientId) return res.status(400).json({ message: 'Missing patient id' });

        const reason = await Interpretation.exists({
            userId: patientId,
            $or: [
                { 'review.status': 'pending' },
                { 'review.professionalId': req.auth.userId },
            ],
        });

        if (!reason) {
            /**
             * 404, not 403.
             *
             * A 403 confirms the patient exists, which turns this endpoint into a way of
             * asking "is this person a LabTrack patient?" one id at a time.
             * `middleware/ownership.js` makes the same call for the same reason.
             */
            return res.status(404).json({ message: 'Not found' });
        }

        next();
    } catch (error) {
        console.error('❌ Review scope check failed:', error);
        res.status(500).json({ message: 'Authorisation error' });
    }
};

module.exports = { requireReviewScope };
