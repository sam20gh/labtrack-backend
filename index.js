const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const app = express();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken'); // Ensure you have this installed via npm
const SECRET_KEY = process.env.SECRET_KEY || 'hhblFy8fKaNxxMTLFHcYrhgavhsAudU2'; // Replace with a secure secret in .env
require('dotenv').config();

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
    height: { type: Number, default: null },
    weight: { type: Number, default: null },
    password: { type: String, required: true }
});


const User = mongoose.model('User', UserSchema);

// Signup API
app.post('/api/users/signup', async (req, res) => {
    console.log('Received Data:', req.body); // Log received data

    try {
        const { firstName, lastName, username, email, phone, dob, password } = req.body;

        if (!firstName || !lastName || !username || !email || !phone || !dob || !password) {
            return res.status(400).json({ message: 'All fields are required' });
        }

        const existingUser = await User.findOne({ $or: [{ email }, { username }] }); // Check for duplicate email or username
        if (existingUser) {
            return res.status(400).json({ message: 'User already exists. Please log in.' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const formattedDOB = new Date(dob).toISOString().split('T')[0]; // Convert to YYYY-MM-DD

        const newUser = new User({
            firstName,
            lastName,
            username,
            email,
            phone,
            dob: formattedDOB, // Store only YYYY-MM-DD format
            password: hashedPassword,
        });


        await newUser.save();

        res.status(201).json({ message: 'User registered successfully', user: { firstName, lastName, username, email, phone, dob } });
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

app.get('/api/test-results', (req, res) => {
    res.json([
        {
            "patient": {
                "user_id": "67c6360d94be7fb517cd292b",
                "name": "Jane Doe",
                "age": 35,
                "gender": "Female",
                "date_of_test": "2025-03-05",
                "lab_name": "MediLab Diagnostics",
                "test_type": "Full Blood Count (FBC)"
            },
            "results": {
                "White Blood Cell Count (WBC)": {
                    "value": 6.8,
                    "unit": "x10^9/L",
                    "reference_range": "4.5-11.0",
                    "status": "Normal"
                },
                "Red Blood Cell Count (RBC)": {
                    "value": 4.9,
                    "unit": "x10^12/L",
                    "reference_range": "4.1-5.1",
                    "status": "Normal"
                },
                "Hemoglobin (HGB)": {
                    "value": 14.8,
                    "unit": "g/dL",
                    "reference_range": "12-16",
                    "status": "Normal"
                },
                "Hematocrit (HCT)": {
                    "value": 44.5,
                    "unit": "%",
                    "reference_range": "36-45",
                    "status": "Normal"
                },
                "Mean Corpuscular Volume (MCV)": {
                    "value": 90.2,
                    "unit": "fL",
                    "reference_range": "80-100",
                    "status": "Normal"
                },
                "Mean Corpuscular Hemoglobin (MCH)": {
                    "value": 31.1,
                    "unit": "pg",
                    "reference_range": "26-34",
                    "status": "Normal"
                },
                "Mean Corpuscular Hemoglobin Concentration (MCHC)": {
                    "value": 34.5,
                    "unit": "g/dL",
                    "reference_range": "33-37",
                    "status": "Normal"
                },
                "Red Cell Distribution Width (RDW)": {
                    "value": 12.7,
                    "unit": "%",
                    "reference_range": "11.5-14.5",
                    "status": "Normal"
                },
                "Platelet Count (PLT)": {
                    "value": 270,
                    "unit": "x10^9/L",
                    "reference_range": "150-350",
                    "status": "Normal"
                },
                "Neutrophils": {
                    "value": 56,
                    "unit": "%",
                    "reference_range": "50-62",
                    "status": "Normal"
                },
                "Lymphocytes": {
                    "value": 34,
                    "unit": "%",
                    "reference_range": "24-40",
                    "status": "Normal"
                },
                "Monocytes": {
                    "value": 5,
                    "unit": "%",
                    "reference_range": "3-7",
                    "status": "Normal"
                },
                "Eosinophils": {
                    "value": 2,
                    "unit": "%",
                    "reference_range": "0-3",
                    "status": "High"
                },
                "Basophils": {
                    "value": 0.6,
                    "unit": "%",
                    "reference_range": "0-1",
                    "status": "High"
                }
            },
            "interpretation": "All parameters are within the normal range. No signs of infection, anemia, or abnormal blood cell morphology detected. The patient appears to have a healthy blood profile."
        }

    ]);
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
// Middleware to authenticate users




// **Update User Profile**
app.put('/api/users/update', authenticateToken, async (req, res) => {
    const { firstName, lastName, username, email, dob, height, weight } = req.body; // Include height and weight
    const userId = req.user.id; // Extracted from JWT token

    try {
        let user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        // Update user details
        user.firstName = firstName || user.firstName;
        user.lastName = lastName || user.lastName;
        user.username = username || user.username;
        user.email = email || user.email;
        user.dob = dob || user.dob;
        user.height = height !== undefined ? height : user.height; // Ensure height can be updated
        user.weight = weight !== undefined ? weight : user.weight; // Ensure weight can be updated

        await user.save();
        res.json(user);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});




const PORT = 5002;
app.listen(PORT, () => {
    console.log(`Server running on http://10.0.6.113:${PORT}`);
});
