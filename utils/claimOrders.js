/**
 * Attaching a website purchase to the account that downloads the app.
 *
 * The website sells a package to somebody who has no account yet, so the order is written
 * with `userId: null` and the buyer's email. It becomes theirs in one of two ways:
 *
 *   1. **By email, automatically.** Signing in with the same address claims every unclaimed
 *      order bought with it. This is the path nearly everybody takes and it asks nothing of
 *      them — buy on the site, install, sign in, and the kit is already on the journey card.
 *   2. **By code.** Eight characters on the thank-you page and in the box, for somebody who
 *      signed up with a different address, or was bought the package as a gift.
 *
 * **The email must be one the identity provider verified.** Otherwise anyone who learns a
 * buyer's address could sign up with it and receive that person's DNA results. Supabase only
 * issues a session to an email sign-up after the confirmation link is clicked, and Google
 * verifies its own addresses; a phone sign-up carries no email and claims nothing.
 * `isVerifiedEmail` holds that line, and anything it cannot vouch for falls back to the code.
 */
const crypto = require('crypto');
const Order = require('../models/Order');

/** No 0/O, 1/I/L: a code read off a printed card must survive being typed. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;

const newClaimCode = () => {
    const bytes = crypto.randomBytes(CODE_LENGTH);
    let out = '';
    for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
    return out;
};

/** Accept "abcd-2345", "ABCD 2345" and the like; null if it cannot be a code. */
const normaliseCode = (value) => {
    if (typeof value !== 'string') return null;
    const code = value.toUpperCase().replace(/[\s-]/g, '');
    if (code.length !== CODE_LENGTH) return null;
    return [...code].every((ch) => ALPHABET.includes(ch)) ? code : null;
};

/**
 * Whether these Supabase claims vouch for their email.
 *
 * `user_metadata.email_verified` is what GoTrue sets once the address is confirmed. An email
 * or OAuth session on this project cannot exist without that — email confirmation is on —
 * but the flag is checked rather than assumed, so turning confirmation off one day cannot
 * silently make every buyer's results claimable by a stranger.
 */
const isVerifiedEmail = (claims) => {
    if (!claims?.email) return false;
    if (claims.user_metadata?.email_verified === true) return true;
    const provider = claims.app_metadata?.provider;
    return provider === 'google' || provider === 'apple';
};

/**
 * Claim every unclaimed order bought with `email`. Returns how many were claimed.
 * Never throws: a claim that fails must not fail the sign-in that triggered it.
 */
const claimByEmail = async (userId, email) => {
    try {
        if (!userId || !email) return 0;
        const filter = { userId: null, guestEmail: String(email).trim().toLowerCase() };
        const ids = (await Order.find(filter).select('_id').lean()).map((o) => o._id);
        if (!ids.length) return 0;
        const result = await Order.updateMany({ ...filter, _id: { $in: ids } }, { $set: { userId, claimedAt: new Date() } });
        // A collection visit booked on the website comes with its order.
        await require('./collectionCentre').claimVisits(ids, userId);
        const n = result.modifiedCount || 0;
        if (n) console.log(`🎁 Claimed ${n} website order(s) for ${userId}`);
        return n;
    } catch (error) {
        console.error('❌ Claiming website orders by email failed:', error.message);
        return 0;
    }
};

/**
 * Claim the one order carrying `code`.
 *
 * `not_found` covers a typo, an unknown code and a code already claimed by somebody else,
 * identically — telling a stranger that a code *was* valid tells them a parcel exists.
 * Claiming your own order twice is not an error.
 */
const claimByCode = async (userId, rawCode) => {
    const code = normaliseCode(rawCode);
    if (!code) return { ok: false, reason: 'invalid' };

    const order = await Order.findOneAndUpdate(
        { claimCode: code, userId: null },
        { $set: { userId, claimedAt: new Date() } },
        { new: true }
    );
    if (order) {
        await require('./collectionCentre').claimVisits([order._id], userId);
        return { ok: true, order, already: false };
    }

    const own = await Order.findOne({ claimCode: code, userId });
    if (own) return { ok: true, order: own, already: true };

    return { ok: false, reason: 'not_found' };
};

module.exports = {
    newClaimCode,
    normaliseCode,
    isVerifiedEmail,
    claimByEmail,
    claimByCode,
    CODE_LENGTH,
};
