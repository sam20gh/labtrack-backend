/**
 * CORS policy.
 *
 * The rule that matters most here is the one about suffixes. A bare `.vercel.app` suffix
 * would let *anybody* who can deploy to Vercel — which is everybody — make credentialed
 * requests to this API from a signed-in staff member's browser. The guard refuses a suffix
 * that is not anchored, and these tests are what keep it refusing.
 */
const { buildPolicy, describe: describePolicy } = require('../config/cors');

const silent = () => {};

describe('buildPolicy', () => {
    it('falls back to localhost when WEB_ORIGINS is unset, so a fresh checkout runs', () => {
        const policy = buildPolicy({}, silent);

        expect(policy.isAllowed('http://localhost:3000')).toBe(true);
        expect(policy.usingDefaults).toBe(true);
        expect(policy.isAllowed('https://labtrack-web.vercel.app')).toBe(false);
    });

    it('allows a request with no Origin — the mobile apps and every server-to-server call', () => {
        const policy = buildPolicy({ WEB_ORIGINS: 'https://portal.example.com' }, silent);

        // CORS governs browsers only; a native client sends no Origin and must not be
        // affected by tightening this list.
        expect(policy.isAllowed(undefined)).toBe(true);
        expect(policy.isAllowed('')).toBe(true);
    });

    it('allows exactly the configured origins', () => {
        const policy = buildPolicy(
            { WEB_ORIGINS: 'https://labtrack-web.vercel.app, http://localhost:3000' },
            silent
        );

        expect(policy.isAllowed('https://labtrack-web.vercel.app')).toBe(true);
        expect(policy.isAllowed('http://localhost:3000')).toBe(true);
        expect(policy.isAllowed('https://evil.example.com')).toBe(false);
    });

    it('tolerates a trailing slash in configuration', () => {
        const policy = buildPolicy({ WEB_ORIGINS: 'https://portal.example.com/' }, silent);
        expect(policy.isAllowed('https://portal.example.com')).toBe(true);
    });

    it('does not treat a configured origin as a prefix', () => {
        const policy = buildPolicy({ WEB_ORIGINS: 'https://portal.example.com' }, silent);

        expect(policy.isAllowed('https://portal.example.com.evil.net')).toBe(false);
        expect(policy.isAllowed('https://evil-portal.example.com')).toBe(false);
    });

    describe('preview-deployment suffixes', () => {
        it('matches a Vercel preview host by anchored suffix', () => {
            const policy = buildPolicy(
                { WEB_ORIGIN_SUFFIXES: '-labtrack-sams-projects.vercel.app' },
                silent
            );

            expect(
                policy.isAllowed('https://labtrack-web-git-main-labtrack-sams-projects.vercel.app')
            ).toBe(true);
        });

        it('refuses an unanchored suffix, which would open the API to all of Vercel', () => {
            const warn = jest.fn();
            const policy = buildPolicy({ WEB_ORIGIN_SUFFIXES: 'vercel.app' }, warn);

            expect(policy.suffixes).toHaveLength(0);
            expect(warn).toHaveBeenCalled();
            expect(policy.isAllowed('https://anyone-at-all.vercel.app')).toBe(false);
        });

        it('still rejects a host that does not end with the suffix', () => {
            const policy = buildPolicy(
                { WEB_ORIGIN_SUFFIXES: '-labtrack-sams-projects.vercel.app' },
                silent
            );

            expect(policy.isAllowed('https://labtrack-web-evil-projects.vercel.app')).toBe(false);
        });

        it('matches on host, so a path or userinfo cannot smuggle the suffix in', () => {
            const policy = buildPolicy({ WEB_ORIGIN_SUFFIXES: '.trusted.example' }, silent);

            expect(policy.isAllowed('https://evil.net/x.trusted.example')).toBe(false);
            expect(policy.isAllowed('https://evil.net#.trusted.example')).toBe(false);
        });

        it('rejects an unparseable origin rather than throwing', () => {
            const policy = buildPolicy({ WEB_ORIGIN_SUFFIXES: '.trusted.example' }, silent);
            expect(policy.isAllowed('not a url')).toBe(false);
        });
    });
});

describe('describe', () => {
    it('says when the defaults are in play, so the boot log explains itself', () => {
        expect(describePolicy(buildPolicy({}, silent))).toContain('WEB_ORIGINS unset');
    });

    it('names the configured origins and suffixes', () => {
        const line = describePolicy(
            buildPolicy(
                {
                    WEB_ORIGINS: 'https://portal.example.com',
                    WEB_ORIGIN_SUFFIXES: '-preview.example.com',
                },
                silent
            )
        );

        expect(line).toContain('https://portal.example.com');
        expect(line).toContain('-preview.example.com');
        expect(line).not.toContain('unset');
    });
});
