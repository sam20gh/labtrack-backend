const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    username: { type: String, unique: true, required: true },
    email: { type: String, unique: true, required: true },
    phone: { type: String, required: true },
    dob: { type: String, required: true },
    gender: { type: String, enum: ['Male', 'Female'], required: true },
    height: { type: Number, default: null },
    weight: { type: Number, default: null },
    password: { type: String, required: true }
}, { timestamps: true });

const User = mongoose.model('User', UserSchema);

module.exports = User;
