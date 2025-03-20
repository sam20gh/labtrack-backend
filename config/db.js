const mongoose = require('mongoose');
require('dotenv').config();

const connectDB = async () => {
    // Fetch connection details from environment variables
    const username = encodeURIComponent(process.env.MONGO_USERNAME);
    const password = encodeURIComponent(process.env.MONGO_PASSWORD);
    const clusterUrl = process.env.MONGO_CLUSTER_URL;
    const database = process.env.MONGO_DB_NAME || "labtrack";

    // Build the connection string
    const mongoURI = process.env.MONGO_URI ||
        `mongodb+srv://${username}:${password}@${clusterUrl}/${database}?retryWrites=true&w=majority`;

    if (!mongoURI || !username || !password || !clusterUrl) {
        console.error("❌ Error: MongoDB Atlas credentials are missing in the .env file.");
        process.exit(1);
    }

    try {
        await mongoose.connect(mongoURI);
        console.log('✅ MongoDB Atlas connected successfully');
    } catch (error) {
        console.error('❌ MongoDB Atlas connection failed:', error.message);
        process.exit(1);
    }
};

module.exports = connectDB;
