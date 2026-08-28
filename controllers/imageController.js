/**
 * The standalone image upload endpoint.
 *
 * The Cloudflare call itself now lives in `utils/imageStore` so the assistant can persist a
 * photograph a person sent it without making an HTTP call back into this same server. This
 * handler is the route-shaped wrapper around it and its response shape is unchanged.
 */
const fs = require('fs');
const { uploadImage } = require('../utils/imageStore');

exports.uploadImage = async (req, res) => {
    const tempPath = req.file?.path || null;

    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No image file uploaded' });
        }

        const imageUrl = await uploadImage(tempPath);

        return res.status(200).json({ message: 'Image uploaded successfully', imageUrl });
    } catch (error) {
        console.error('❌ Error during upload:', error);
        res.status(500).json({ message: 'Image upload failed', error: error.message });
    } finally {
        // Was `unlinkSync` on the success path only, so every failed upload left a file
        // behind in `uploads/` — which is not gitignored.
        if (tempPath) fs.unlink(tempPath, () => { });
    }
};
