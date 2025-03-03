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
app.get('/api/user', (req, res) => {
    res.json({
        id: 1,
        name: "John Doe",
        email: "johndoe@example.com",
        phone: "+1 234 567 890",
        avatar: "https://i.pravatar.cc/150?img=3" // Placeholder image
    });
});

const PORT = 5002;
app.listen(PORT, () => {
    console.log(`Server running on http://10.0.6.113:${PORT}`);
});
