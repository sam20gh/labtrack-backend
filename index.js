require('dotenv').config();
console.log('OPENAI_API_KEY:', process.env.OPENAI_API_KEY);
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const app = express();
const deepseekRouter = require('./routes/deepseek'); // Use require for CommonJS modules
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken'); // Ensure you have this installed via npm
const SECRET_KEY = process.env.SECRET_KEY; // Replace with a secure secret in .env


app.use(cors()); // Enable CORS
app.use(express.json()); // Allow JSON parsing
app.use(bodyParser.json()); // Allow JSON parsing

// Connect to MongoDB
mongoose.connect('mongodb://localhost:27017/labtrack', {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => console.log('MongoDB connected'))
    .catch(err => console.log(err));

// User Schema
const UserSchema = new mongoose.Schema({
    firstName: String,
    lastName: String,
    username: { type: String, unique: true, required: true },
    email: { type: String, unique: true, required: true },
    phone: String,
    dob: { type: String, required: true },
    ender: { type: String, enum: ['Male', 'Female'] },
    height: { type: Number, default: null },
    weight: { type: Number, default: null },
    password: { type: String, required: true }
});

const User = mongoose.model('User', UserSchema);

// Signup API
app.post('/api/users/signup', async (req, res) => {
    console.log('Received Data:', req.body);
    try {
        // Include gender here
        const { firstName, lastName, username, email, phone, dob, password, gender } = req.body;

        if (!firstName || !lastName || !username || !email || !phone || !dob || !password) {
            return res.status(400).json({ message: 'All fields are required' });
        }

        const existingUser = await User.findOne({ $or: [{ email }, { username }] });
        if (existingUser) {
            return res.status(400).json({ message: 'User already exists. Please log in.' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const formattedDOB = new Date(dob).toISOString().split('T')[0];

        const newUser = new User({
            firstName,
            lastName,
            username,
            email,
            phone,
            dob: formattedDOB,
            gender,  // Save gender
            password: hashedPassword,
        });

        await newUser.save();

        res.status(201).json({ message: 'User registered successfully', user: { firstName, lastName, username, email, phone, dob, gender } });
    } catch (error) {
        console.error('Signup Error:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

const authenticateToken = (req, res, next) => {
    const token = req.header('Authorization')?.split(' ')[1]; // Extract token after "Bearer"
    if (!token) return res.status(401).json({ message: 'Access Denied: No Token Provided' });

    try {
        console.log('Verifying Token:', token);
        const verified = jwt.verify(token, SECRET_KEY); // ✅ Ensure same secret is used
        req.user = verified;
        next();
    } catch (err) {
        console.error('Token Verification Error:', err);
        res.status(403).json({ message: 'Invalid Token' });
    }
};

const TestResultSchema = new mongoose.Schema({
    patient: {
        user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        date_of_test: { type: String, required: true },
        lab_name: { type: String, required: true },
        test_type: { type: String, required: true }
    },
    results: { type: Object, required: true },
    interpretation: { type: String, required: true }
});

const TestResult = mongoose.model('TestResult', TestResultSchema);

// POST API to Add New Test Results
app.post('/api/test-results', async (req, res) => {
    try {
        const { patient, results, interpretation } = req.body;

        if (!patient || !patient.user_id || !patient.date_of_test || !patient.lab_name || !patient.test_type || !results) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        const newTestResult = new TestResult({
            patient,
            results,
            interpretation
        });

        await newTestResult.save();
        res.status(201).json({ message: 'Test result added successfully', testResult: newTestResult });
    } catch (error) {
        console.error('Error saving test result:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

app.get('/api/test-results', async (req, res) => {
    try {
        const { user_id } = req.query;
        if (!user_id) {
            return res.status(400).json({ message: 'User ID is required' });
        }

        const testResults = await TestResult.find({ 'patient.user_id': user_id });
        if (!testResults || testResults.length === 0) {
            return res.status(404).json({ message: 'No test results found for this user' });
        }

        res.json(testResults);
    } catch (error) {
        console.error('Error fetching test results:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

app.get('/api/users', async (req, res) => {
    try {
        const users = await User.find();
        res.json(users);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching users', error: error.message });
    }
});

// Login API
app.post('/api/users/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ message: 'Username and password are required' });
        }

        const user = await User.findOne({ username });
        if (!user) {
            return res.status(400).json({ message: 'Invalid username or password' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Invalid username or password' });
        }

        const token = jwt.sign({ id: user._id }, SECRET_KEY, { expiresIn: '1h' }); // ✅ Use the same SECRET_KEY

        console.log('Generated Token:', token); // ✅ Debugging

        res.json({
            message: 'Login successful',
            token,
            user: {
                _id: user._id,
                firstName: user.firstName,
                lastName: user.lastName,
                username: user.username,
                email: user.email,
                phone: user.phone,
                dob: user.dob
            }
        });
    } catch (error) {
        console.error('Login Error:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

app.get('/api/users/:id', async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        res.json(user); // ✅ Return the user object directly
    } catch (error) {
        res.status(500).json({ message: 'Error fetching user', error: error.message });
    }
});

// **Update User Profile**
app.put('/api/users/update', authenticateToken, async (req, res) => {
    // Include gender in the destructuring
    const { firstName, lastName, username, email, dob, height, weight, gender } = req.body;
    const userId = req.user.id;
    try {
        let user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        user.firstName = firstName || user.firstName;
        user.lastName = lastName || user.lastName;
        user.username = username || user.username;
        user.email = email || user.email;
        user.dob = dob || user.dob;
        user.height = height !== undefined ? height : user.height;
        user.weight = weight !== undefined ? weight : user.weight;
        user.gender = gender || user.gender; // Update gender

        await user.save();
        res.json(user);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Mount DeepSeek API route
app.use('/api/deepseek', deepseekRouter);

const PORT = 5002;
app.listen(PORT, () => {
    console.log(`Server running on http://10.0.6.113:${PORT}`);
});
