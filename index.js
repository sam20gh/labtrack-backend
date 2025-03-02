const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors()); // Enable CORS
app.use(express.json()); // Allow JSON parsing

app.get('/api/test-results', (req, res) => {
    res.json([
        { id: 1, testName: 'Iron', status: 'Normal' },
        { id: 2, testName: 'Cholestrol', status: 'High' },
        { id: 3, testName: 'Vitamin D', status: 'Pending' },
        { id: 4, testName: 'Vitamin A', status: 'Normal' },
        { id: 5, testName: 'Vitamin B', status: 'High' }
    ]);
});

const PORT = 5002;
app.listen(PORT, () => {
    console.log(`Server running on http://192.168.1.105:${PORT}`);
});
