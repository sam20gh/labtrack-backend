const AccessLog = require('../models/AccessLog');

/**
 * Record a clinician's read of patient data.
 *
 * Called from controllers rather than wired as blanket middleware, because the thing worth
 * logging — *whose* record this was — is usually known only after the query has run. A
 * middleware that logged the route instead would record that someone opened an id, which
 * answers none of the questions the log exists for.
 *
 * ## Awaited, and fail-open
 *
 * The write is awaited so a read cannot outrun its own audit entry, but a failure does not
 * fail the request. That is a deliberate trade, and it goes the other way from the ideal:
 * strictly, if the read cannot be logged it should not be served.
 *
 * It is fail-open because the alternative is that a hiccup in this collection takes the
 * clinical workspace down — a clinician cannot review, a patient's result waits — to protect
 * a record of something that was going to be permitted anyway. A failure is logged at error
 * level so it is visible rather than silent.
 *
 * **To make it fail-closed, delete the try/catch.** Everything else already awaits.
 */
const recordAccess = async ({
    actor,
    patientId = null,
    resource,
    resourceId = null,
    count = undefined,
}) => {
    try {
        if (!actor?.userId) return null;

        // Only staff reads are audit-relevant. A patient reading their own record is
        // `requireSelf` doing its job, and logging it would bury the staff reads that
        // matter in noise the log cannot use.
        const role = actor.role;
        if (role !== 'professional' && role !== 'admin') return null;

        return await AccessLog.create({
            actorId: actor.userId,
            actorEmail: actor.email || undefined,
            actorRole: role,
            patientId: patientId || undefined,
            resource,
            resourceId: resourceId || undefined,
            count,
        });
    } catch (error) {
        console.error(
            `❌ Access log write failed (${resource}${resourceId ? ` ${resourceId}` : ''}):`,
            error.message
        );
        return null;
    }
};

module.exports = { recordAccess };
