/**
 * Cloudflare Images URL handling.
 *
 * These exist because of a bug that every other test in this suite was blind to: the
 * delivery URL used to be **assembled** from `CLOUDFLARE_ACCOUNT_ID`, which is not the
 * value that appears in an `imagedelivery.net` URL. That is the account *hash* — a short
 * opaque string — and the two are unrelated. The upload succeeded, Cloudflare answered 200,
 * the server stored a URL, and the URL 404'd. Nothing on the server could tell.
 *
 * `__tests__/assistantInputs.test.js` mocks `uploadImageOrNull` wholesale, so the URL was
 * never exercised anywhere. These tests exercise it directly.
 */
const { deliveryUrlFrom } = require('../utils/imageStore');

const ACCOUNT_ID = '7432aaaabbbbccccddddeeeeffff0000';
const ACCOUNT_HASH = 'ERpgI9dTO_O0KtFpZrRgXg';
const IMAGE_ID = '7f9e2c08-5b95-4169-9793-22bddbc25000';

const cloudflareResult = (variants) => ({ id: IMAGE_ID, variants });

describe('deliveryUrlFrom', () => {
    it('returns the public variant Cloudflare offered', () => {
        const url = deliveryUrlFrom(cloudflareResult([
            `https://imagedelivery.net/${ACCOUNT_HASH}/${IMAGE_ID}/avatar`,
            `https://imagedelivery.net/${ACCOUNT_HASH}/${IMAGE_ID}/public`,
        ]));

        expect(url).toBe(`https://imagedelivery.net/${ACCOUNT_HASH}/${IMAGE_ID}/public`);
    });

    /** The regression itself: the account id must never appear in a delivery URL. */
    it('never builds a URL from the account id', () => {
        process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT_ID;

        const url = deliveryUrlFrom(cloudflareResult([
            `https://imagedelivery.net/${ACCOUNT_HASH}/${IMAGE_ID}/public`,
        ]));

        expect(url).not.toContain(ACCOUNT_ID);
        expect(url).toContain(ACCOUNT_HASH);
    });

    it('falls back to the first variant when no public one is configured', () => {
        const only = `https://imagedelivery.net/${ACCOUNT_HASH}/${IMAGE_ID}/thumbnail`;

        expect(deliveryUrlFrom(cloudflareResult([only]))).toBe(only);
    });

    /**
     * Better to fail the upload than to return a URL that renders nothing. The caller that
     * cannot afford to fail uses `uploadImageOrNull`, which turns this into a null.
     */
    it('throws when Cloudflare offered no variants', () => {
        expect(() => deliveryUrlFrom(cloudflareResult([]))).toThrow(/no delivery URL/i);
        expect(() => deliveryUrlFrom({ id: IMAGE_ID })).toThrow(/no delivery URL/i);
        expect(() => deliveryUrlFrom(undefined)).toThrow(/no delivery URL/i);
    });
});
