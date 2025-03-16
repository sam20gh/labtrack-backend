const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

exports.uploadImage = async (req, res) => {
    console.log("Upload request received"); // Debugging log

    try {
        if (!req.file) {
            console.log("No file received");
            return res.status(400).json({ message: 'No image file uploaded' });
        }

        console.log("File received:", req.file);

        const formData = new FormData();
        formData.append('file', fs.createReadStream(req.file.path));
        formData.append('requireSignedURLs', 'false');

        console.log("Sending request to Cloudflare...");
        const response = await axios.post(
            `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/images/v1`,
            formData,
            {
                headers: {
                    ...formData.getHeaders(),
                    Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`
                }
            }
        );

        console.log("Cloudflare response:", response.data);
        fs.unlinkSync(req.file.path);

        if (response.data.success) {
            return res.status(200).json({
                message: 'Image uploaded successfully',
                imageUrl: `https://imagedelivery.net/${process.env.CLOUDFLARE_ACCOUNT_ID}/${response.data.result.id}/public`
            });
        } else {
            console.log("Cloudflare upload failed", response.data);
            throw new Error('Cloudflare upload failed');
        }
    } catch (error) {
        console.error("Error during upload:", error);
        res.status(500).json({ message: 'Image upload failed', error: error.message });
    }
};
