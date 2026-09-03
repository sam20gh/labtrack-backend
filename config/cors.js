/**
 * CORS policy for browser clients.
 *
 * The API was open to every origin until the staff web portal existed, which was harmless
 * while the only clients were native: an Expo app sends no `Origin` header and CORS does
 * not govern it either way. A browser client changes that — an open policy lets any page on
 * the internet make credentialed calls to this API from a signed-in staff member's browser.
 *
 * Requests with **no** Origin stay permitted: the mobile apps, curl, uptime monitors and
 * server-to-server calls. Only a browser sends Origin, and only a browser is restricted.
 *
 * Lives here rather than in index.js so the matching rules can be tested without booting
 * the server — see `__tests__/cors.test.js`.
 */

const DEFAULT_WEB_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];

const parseList = (value) => (value || '')
    .split(',')
    .map((entry) => entry.trim().replace(/\/$/, ''))
    .filter(Boolean);

/**
 * Build the policy from environment.
 *
 * @param {object} env  typically process.env
 * @param {(msg: string) => void} warn  where to report an unusable suffix
 */
const buildPolicy = (env = process.env, warn = console.warn) => {
    const configured = parseList(env.WEB_ORIGINS);
    const origins = configured.length ? configured : DEFAULT_WEB_ORIGINS;

    /**
     * `WEB_ORIGIN_SUFFIXES` — optional, for preview deployments.
     *
     * Every Vercel preview gets its own hostname, so an exact allow list rejects each new
     * one and the failure reads as a code problem rather than a config one. A suffix match
     * fixes that, at a price: whoever controls a host ending in the suffix can make
     * credentialed requests as a signed-in staff member.
     *
     * The suffix must therefore be narrow enough that only you can produce a matching host
     * — include the project *and* team segment:
     *
     *     ✅  -labtrack-sams-projects.vercel.app
     *     ❌  .vercel.app          ← anyone can deploy there. Never use this.
     *
     * A suffix not starting with '.' or '-' is refused, because `abc.com` would also match
     * `evil-abc.com`.
     */
    const suffixes = parseList(env.WEB_ORIGIN_SUFFIXES).filter((suffix) => {
        if (suffix.startsWith('.') || suffix.startsWith('-')) return true;
        warn(
            `⚠️  Ignoring WEB_ORIGIN_SUFFIXES entry "${suffix}": a suffix must begin with "." or "-", ` +
            'otherwise it also matches a hostname that merely ends with those characters.'
        );
        return false;
    });

    const isAllowed = (origin) => {
        if (!origin) return true; // non-browser caller
        const clean = String(origin).replace(/\/$/, '');
        if (origins.includes(clean)) return true;
        if (!suffixes.length) return false;

        // Match on the host only, so a path or credentials trick cannot sneak past.
        let host;
        try {
            host = new URL(clean).host;
        } catch {
            return false;
        }
        return suffixes.some((suffix) => host.endsWith(suffix));
    };

    return { origins, suffixes, isAllowed, usingDefaults: configured.length === 0 };
};

/** A description for the boot log, so the running policy is visible without reading code. */
const describe = (policy) =>
    `${policy.origins.join(', ')}` +
    (policy.suffixes.length ? ` | suffixes: ${policy.suffixes.join(', ')}` : '') +
    (policy.usingDefaults ? ' (WEB_ORIGINS unset — using localhost defaults)' : '');

module.exports = { buildPolicy, describe, DEFAULT_WEB_ORIGINS };
