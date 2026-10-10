/**
 * The laboratories that may report to Predyqt, and how a report proves it came from one.
 *
 * Each laboratory signs every request like Stripe signs a webhook — the pattern both labs'
 * engineers will have met before:
 *
 *     Predyqt-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
 *
 * The secret is per laboratory and lives in the environment, never the database:
 *
 *     LAB_WEBHOOK_SECRETS="MICRO_HEALTH=secret-one|secret-two;M42=secret-three"
 *
 * Two secrets for one lab is a rotation: both verify until the old one is removed. A request
 * whose timestamp is more than five minutes from the server's clock is refused, so a captured
 * request cannot be replayed later. See docs/LAB-INTEGRATION.md for the whole contract.
 *
 * Pure apart from reading the environment.
 */
const crypto = require('crypto');

/** Who each laboratory is, and which kinds of sample it may report on. */
const LABS = {
    MICRO_HEALTH: { code: 'MICRO_HEALTH', name: 'Micro Health Laboratories', kinds: ['blood'] },
    M42: { code: 'M42', name: 'M42', kinds: ['dna'] },
};

const TOLERANCE_SECONDS = 300;

/** `{ CODE: [secret, …] }` from LAB_WEBHOOK_SECRETS. Unknown lab codes are ignored. */
const secretsFromEnv = (raw = process.env.LAB_WEBHOOK_SECRETS || '') => {
    const out = {};
    for (const part of raw.split(';')) {
        const [code, list] = part.split('=');
        const key = String(code || '').trim().toUpperCase();
        if (!LABS[key] || !list) continue;
        out[key] = list.split('|').map((s) => s.trim()).filter(Boolean);
    }
    return out;
};

const sign = (secret, timestamp, rawBody) =>
    crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');

/**
 * Check a request's signature. → `{ ok: true }` or `{ ok: false, reason }`.
 * Constant-time comparison; every configured secret for the lab is tried.
 */
const verifySignature = ({ header, rawBody, secrets, now = Date.now() }) => {
    if (!secrets?.length) return { ok: false, reason: 'not_configured' };
    const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.trim().split('=')).filter((kv) => kv.length === 2));
    const t = Number(parts.t);
    const v1 = String(parts.v1 || '');
    if (!Number.isFinite(t) || !/^[0-9a-f]{64}$/.test(v1)) return { ok: false, reason: 'malformed' };
    if (Math.abs(now / 1000 - t) > TOLERANCE_SECONDS) return { ok: false, reason: 'stale' };
    const given = Buffer.from(v1, 'hex');
    const match = secrets.some((secret) => crypto.timingSafeEqual(Buffer.from(sign(secret, t, rawBody), 'hex'), given));
    return match ? { ok: true } : { ok: false, reason: 'mismatch' };
};

module.exports = { LABS, TOLERANCE_SECONDS, secretsFromEnv, sign, verifySignature };
