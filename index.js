const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const app = express();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken'); // Ensure you have this installed via npm
const SECRET_KEY =  process.env.SECRET_KEY || 'hhblFy8fKaNxxMTLFHcYrhgavhsAudU2'; // Replace with a secure secret in .env
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
    dob: Date,
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

        const newUser = new User({
            firstName,
            lastName,
            username,
            email,
            phone,
            dob,
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
        { id: 1, testName: 'Iron', status: 'Normal' },
        { id: 2, testName: 'Cholestrol', status: 'High' },
        { id: 3, testName: 'Vitamin D', status: 'Pending' },
        { id: 4, testName: 'Vitamin A', status: 'Normal' },
        { id: 5, testName: 'Vitamin B', status: 'High' }
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
    const { firstName, lastName, username, email, dob } = req.body;
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

        await user.save();
        res.json(user);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});



const PORT = 5002;
app.listen(PORT, () => {
    console.log(`Server running on http://192.168.1.103:${PORT}`);
});
