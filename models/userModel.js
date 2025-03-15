const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    firstName: String,
    lastName: String,
    username: { type: String, unique: true, required: true },
    email: { type: String, unique: true, required: true },
    phone: String,
    dob: { type: String, required: true },
    gender: { type: String, enum: ['Male', 'Female'] },
    height: { type: Number, default: null },
    weight: { type: Number, default: null },
    password: { type: String, required: true }
});

module.exports = mongoose.model('User', UserSchema);
