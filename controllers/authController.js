const Professional = require('../models/Professional');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

// Professional Login
exports.loginProfessional = async (req, res) => {
    try {
        const { username, password } = req.body;

        // Find professional by username
        const professional = await Professional.findOne({ username });
        if (!professional) {
            return res.status(400).json({ message: 'Invalid username or password' });
        }

        // Compare password
        const isMatch = await bcrypt.compare(password, professional.password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Invalid username or password' });
        }

        // Generate JWT token
        const token = jwt.sign(
            { id: professional._id, username: professional.username },
            process.env.JWT_SECRET || 'default_secret_key',
            { expiresIn: '24h' }
        );

        res.status(200).json({ token, professional: { id: professional._id, username: professional.username } });
    } catch (error) {
        res.status(500).json({ message: 'Error logging in', error: error.message });
    }
};
