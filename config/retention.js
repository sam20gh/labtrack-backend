/**
 * Retention policy for interpretation history.
 *
 * The number here is not an engineering decision. Storage is not the constraint — one
 * interpretation is roughly 17 KB, so a decade of full history costs a few gigabytes at
 * this product's scale — and the reasons to keep or delete are clinical and legal.
 *
 * Two rules follow from that, and neither is negotiable by tuning a constant:
 *
 *   1. **A reviewed interpretation is never deleted.** Once a named clinician has signed or
 *      amended it on a named date, it is the record that a clinical decision was made. The
 *      sweep below cannot touch it whatever the window is set to.
 *   2. **Only superseded drafts are pruned.** The newest interpretation is what the person
 *      currently reads, so it stays regardless of age.
 *
 * `DRAFT_RETENTION_DAYS` is therefore about unreviewed, superseded drafts only, and it is
 * set generously on purpose. It is a placeholder for a number that should come from whoever
 * owns compliance, written down, and anchored to last patient contact rather than to
 * creation — a creation-anchored window would delete the baseline that biomarker trends and
 * `changes_since_last` depend on for someone who returns after a gap.
 */

/** How long an unreviewed, superseded draft is kept. */
const DRAFT_RETENTION_DAYS = 365 * 5;

/**
 * Drafts always kept per user regardless of age, so history never collapses to a single
 * row and a delta can always be computed against something.
 */
const MIN_DRAFTS_KEPT = 5;

/** Statuses that make an interpretation a permanent clinical record. */
const PERMANENT_STATUSES = ['approved', 'amended'];

module.exports = { DRAFT_RETENTION_DAYS, MIN_DRAFTS_KEPT, PERMANENT_STATUSES };
