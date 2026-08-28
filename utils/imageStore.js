/**
 * Cloudflare Images, as a function rather than as a route handler.
 *
 * `imageController.uploadImage` was the only way to get a picture into permanent storage,
 * which meant anything else that needed one had to make an HTTP call back into its own
 * server. The assistant needs exactly that — a photograph the person sent it has to survive
 * in the transcript after the temp file is unlinked — so the Cloudflare half moved here and
 * the controller now wraps it.
 *
 * Uploads are best-effort by design for the assistant's use: `isConfigured()` lets the
 * caller decide whether a failure to store the picture should fail the whole request. For a
 * question about a rash it should not — the answer is worth more than the thumbnail.
 */
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

const isConfigured = () =>
    Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN);

/**
 * Upload one file to Cloudflare Images.
 *
 * @param {string} path     a readable path on disk; the caller still owns unlinking it
 * @returns {Promise<string>} the public delivery URL
 * @throws when unconfigured or when Cloudflare rejects the upload
 */
const uploadImage = async (path) => {
    if (!isConfigured()) throw new Error('Image storage is not configured');

    const form = new FormData();
    form.append('file', fs.createReadStream(path));
    form.append('requireSignedURLs', 'false');

    const response = await axios.post(
        `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/images/v1`,
        form,
        {
            headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
        }
    );

    if (!response.data?.success) throw new Error('Cloudflare upload failed');

    return `https://imagedelivery.net/${process.env.CLOUDFLARE_ACCOUNT_ID}/${response.data.result.id}/public`;
};

/** Upload, or return null. For callers where the picture is a nicety and the work is not. */
const uploadImageOrNull = async (path) => {
    try {
        return await uploadImage(path);
    } catch (error) {
        console.error('⚠️  Image storage failed, continuing without a stored copy:', error.message);
        return null;
    }
};

module.exports = { uploadImage, uploadImageOrNull, isConfigured };
