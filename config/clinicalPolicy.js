/**
 * Clinical policy — the two rules that are expected to change.
 *
 * Both of these were settled as "yes now, switchable later", and the switch will arrive
 * with a regulatory deadline attached. So neither lives inline in a controller or as a
 * hardcoded query: changing policy has to be an edit to this file plus, at most, a
 * recompute — never a schema migration and never a client release.
 *
 * The client is already built for the strict setting of both. That is the point: flipping
 * either constant below changes behaviour end to end with no app update.
 */

/**
 * Does an interpretation need a clinician's sign-off before it is considered verified?
 *
 * Today: all of them. The intended narrowing, once interpretations are better trusted, is
 * to triage — queue anything carrying a pathogenic variant, a critical biomarker flag, or a
 * risk rated high, and auto-clear the rest. The signature already receives everything that
 * rule would need, so the change is the body of this function.
 */
const requiresReview = (/* interpretation */) => true;

/**
 * May the patient read an interpretation that no clinician has signed off?
 *
 * Today: yes, shown with a "not verified" label. If regulation later requires sign-off
 * first, return false here — the read path then withholds unverified content and the app
 * shows its awaiting-review state, which is already built.
 */
const showsUnverifiedToPatient = () => true;

/**
 * How an interpretation should be presented to the person it is about.
 *
 * One function so the read path cannot drift from the policy above, and so the API always
 * carries a verification state whether or not it is currently capable of withholding.
 *
 * `showsUnverified` is injectable so the stricter setting — the one that cannot occur under
 * current policy — can be exercised for real rather than reimplemented in a test. An
 * untested switch is not a switch you can flip on a regulatory deadline.
 *
 * @param {{ review?: { status?: string }, amended?: { content?: object }, content?: object }} interpretation
 * @param {{ showsUnverified?: boolean }} [overrides]
 * @returns {{ status: 'approved'|'amended'|'unverified', withheld: boolean, content: object|null }}
 */
const presentToPatient = (interpretation, { showsUnverified } = {}) => {
    const allowUnverified = showsUnverified ?? showsUnverifiedToPatient();
    if (!interpretation) return { status: 'unverified', withheld: false, content: null };

    const reviewStatus = interpretation.review?.status;
    const signedOff = reviewStatus === 'approved' || reviewStatus === 'amended';

    if (signedOff) {
        return {
            status: reviewStatus,
            withheld: false,
            // A clinician's amendment is what the patient reads. This is the whole reason
            // the review and the content live on one row: the correction cannot be missed.
            content: interpretation.amended?.content || interpretation.content || null,
        };
    }

    const withheld = !allowUnverified;
    return {
        status: 'unverified',
        withheld,
        content: withheld ? null : interpretation.content || null,
    };
};

module.exports = { requiresReview, showsUnverifiedToPatient, presentToPatient };
