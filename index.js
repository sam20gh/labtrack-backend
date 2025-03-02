const express = require('express');
const cors = require('cors'); // Allows frontend to access the backend
const app = express();

app.use(cors()); // Enable CORS
app.use(express.json()); // Allow JSON parsing

// Dummy API Endpoint for Test Results
app.get('/api/test-results', (req, res) => {
    res.json([
        { id: 1, testName: 'Complete Blood Count', status: 'Normal' },
        { id: 2, testName: 'Cholesterol Test', status: 'High' },
        { id: 3, testName: 'Vitamin D', status: 'Pending' }
    ]);
});

// Start the server
const PORT = process.env.PORT || 5002; // Ensure port 5002 matches your setup
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
