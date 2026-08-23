const Professional = require('../models/Professional');
const User = require('../models/userModel');
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

        // Signed with SECRET_KEY so authMiddleware can actually verify it. Previously this
        // used JWT_SECRET — a second secret no middleware checked (and which fell back to
        // a hardcoded literal), so professional tokens opened nothing.
        // The role claim is what requireRole() reads.
        const token = jwt.sign(
            { id: professional._id, username: professional.username, role: 'professional' },
            process.env.SECRET_KEY,
            { expiresIn: '24h' }
        );

        res.status(200).json({ token, professional: { id: professional._id, username: professional.username } });
    } catch (error) {
        res.status(500).json({ message: 'Error logging in', error: error.message });
    }
};

/** Escape a string for safe use inside a RegExp (emails contain . and + freely). */
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * POST /api/auth/supabase/sync
 *
 * Called by the client immediately after a Supabase sign-in or sign-up. Supabase owns the
 * credential; LabTrack still needs its own User document for medical records to hang off.
 * This is the only place that creates that link, so no other route can conjure accounts as
 * a side effect of a request.
 *
 * Idempotent:
 *   - known supabaseId            → return it
 *   - matching email              → adopt the existing account (migration path)
 *   - neither                     → create a passwordless account
 */
exports.syncSupabaseUser = async (req, res) => {
    try {
        const claims = req.supabaseClaims;
        const supabaseId = claims.sub;
        const email = claims.email;

        if (!email) {
            return res.status(400).json({ message: 'Supabase identity has no email address' });
        }

        let user = await User.findOne({ supabaseId }).select('-password');
        if (user) {
            return res.status(200).json({ message: 'Already linked', linked: 'existing', user });
        }

        // Adopt a legacy account with the same email rather than creating a duplicate.
        // Case-insensitive on purpose: Supabase normalises emails to lowercase, while
        // legacy LabTrack accounts were stored verbatim (e.g. "Test@gmail.com"). An exact
        // match would miss, create a second account, and orphan that user's medical
        // history behind an identity they can no longer reach.
        const emailPattern = new RegExp(`^${escapeRegex(email)}$`, 'i');
        user = await User.findOneAndUpdate(
            { email: emailPattern },
            { $set: { supabaseId } },
            { new: true }
        ).select('-password');
        if (user) {
            console.log('🔗 Linked Supabase identity to existing account:', email);
            return res.status(200).json({ message: 'Account linked', linked: 'by-email', user });
        }

        // Google sign-in supplies these; email sign-up does not
        const meta = claims.user_metadata || {};
        const fullName = meta.full_name || meta.name || '';
        const [firstName = '', ...rest] = fullName.trim().split(' ');

        const created = await User.create({
            supabaseId,
            email,
            username: email,
            firstName,
            lastName: rest.join(' '),
        });

        const user_ = created.toObject();
        delete user_.password;

        console.log('✨ Provisioned LabTrack account for Supabase user:', email);
        return res.status(201).json({ message: 'Account created', linked: 'created', user: user_ });
    } catch (error) {
        // Unique-index race: another concurrent sync won — re-read and return that.
        if (error.code === 11000) {
            const existing = await User.findOne({ supabaseId: req.supabaseClaims.sub }).select('-password');
            if (existing) return res.status(200).json({ message: 'Already linked', linked: 'existing', user: existing });
        }
        console.error('❌ Supabase sync failed:', error);
        return res.status(500).json({ message: 'Error syncing account', error: error.message });
    }
};
