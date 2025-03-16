const Professional = require('../models/Professional');
const bcrypt = require('bcrypt');

// Create a new professional
exports.createProfessional = async (req, res) => {
    try {
        const { firstname, lastname, username, password, dob, address, postcode, country, speciality, hourly_rate, profile_image, description } = req.body;
        
        // Check if username is taken
        const existingUser = await Professional.findOne({ username });
        if (existingUser) {
            return res.status(400).json({ message: 'Username already exists' });
        }

        // Hash password before saving
        const hashedPassword = await bcrypt.hash(password, 10);

        const newProfessional = new Professional({
            firstname,
            lastname,
            username,
            password: hashedPassword,
            dob,
            address,
            postcode,
            country,
            speciality,
            hourly_rate,
            profile_image,
            description
        });

        await newProfessional.save();
        res.status(201).json({ message: 'Professional created successfully', professional: newProfessional });
    } catch (error) {
        res.status(500).json({ message: 'Error creating professional', error: error.message });
    }
};

// Get all professionals
exports.getAllProfessionals = async (req, res) => {
    try {
        const professionals = await Professional.find();
        res.status(200).json(professionals);
    } catch (error) {
        res.status(500).json({ message: 'Error retrieving professionals', error: error.message });
    }
};

// Get a professional by ID
exports.getProfessionalById = async (req, res) => {
    try {
        const professional = await Professional.findById(req.params.id);
        if (!professional) {
            return res.status(404).json({ message: 'Professional not found' });
        }
        res.status(200).json(professional);
    } catch (error) {
        res.status(500).json({ message: 'Error retrieving professional', error: error.message });
    }
};

// Update a professional by ID
exports.updateProfessional = async (req, res) => {
    try {
        const updates = req.body;
        if (updates.password) {
            updates.password = await bcrypt.hash(updates.password, 10);
        }
        const updatedProfessional = await Professional.findByIdAndUpdate(req.params.id, updates, { new: true });
        if (!updatedProfessional) {
            return res.status(404).json({ message: 'Professional not found' });
        }
        res.status(200).json({ message: 'Professional updated successfully', professional: updatedProfessional });
    } catch (error) {
        res.status(500).json({ message: 'Error updating professional', error: error.message });
    }
};

// Delete a professional by ID
exports.deleteProfessional = async (req, res) => {
    try {
        const deletedProfessional = await Professional.findByIdAndDelete(req.params.id);
        if (!deletedProfessional) {
            return res.status(404).json({ message: 'Professional not found' });
        }
        res.status(200).json({ message: 'Professional deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting professional', error: error.message });
    }
};
