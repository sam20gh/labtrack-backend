const Professional = require('../models/Professional');

/**
 * The `Professional` directory record for whoever is signed in, or null.
 *
 * Two token families reach this, and they carry different things in `req.auth.userId`:
 *
 *   - **Supabase** (the portal, and the target state) — a `User._id`. The link is
 *     `Professional.userId`, set by an administrator when they attach a directory entry to
 *     a staff account.
 *   - **Legacy professional tokens** — a `Professional._id` directly, from the days when
 *     `controllers/authController.js` signed its own.
 *
 * Both are tried, in that order. Everything that needs "the clinician behind this request"
 * goes through here rather than guessing, because guessing is what produced
 * `Professional.findById(req.auth.userId)` — correct for one token family, silently empty
 * for the other, and indistinguishable from "this clinician has no profile".
 */
const resolveProfessional = async (auth, projection = '-password') => {
    if (!auth?.userId) return null;

    const linked = await Professional.findOne({ userId: auth.userId }).select(projection).lean();
    if (linked) return linked;

    // A legacy token's subject *is* a Professional id. Guarded so a User id that happens to
    // be a valid ObjectId cannot accidentally match — findById simply returns null then.
    if (auth.source === 'legacy') {
        return Professional.findById(auth.userId).select(projection).lean();
    }

    return null;
};

/**
 * The id to record as the acting clinician.
 *
 * Falls back to the authenticated id when no directory record is linked, which keeps
 * sign-off working for an administrator or a clinician nobody has linked yet — the
 * attribution is still unambiguous, it just points at a `User` rather than a `Professional`.
 */
const actingProfessionalId = async (auth) => {
    const professional = await resolveProfessional(auth, '_id');
    return professional?._id || auth?.userId || null;
};

module.exports = { resolveProfessional, actingProfessionalId };
