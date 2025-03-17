const mongoose = require('mongoose');

const ProductSchema = new mongoose.Schema({
    name: { type: String, required: true },
    sku: { type: String, required: true, unique: true },
    description: { type: String },
    image: { type: String }, // URL from Cloudflare
    type: { type: String },
    price: { type: Number, required: true }
});

module.exports = mongoose.model('Product', ProductSchema);
