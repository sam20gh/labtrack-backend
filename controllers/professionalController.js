const Professional = require('../models/Professional');
const bcrypt = require('bcrypt');

/**
 * The fields a request may set on a directory entry.
 *
 * `updateProfessional` used to pass `req.body` to `findByIdAndUpdate` whole. Two fields
 * make that worth closing: `_id`, and `userId` — the sparse-unique link deciding which
 * `Professional` a signed-in clinician's reviews and plan items are attributed to
 * (`utils/resolveProfessional.js`). Reassigning that from a directory form would move
 * somebody's clinical sign-offs onto another record, and nothing would report it. The link
 * is made deliberately elsewhere, never as a side effect of editing an address.
 *
 * `password` is absent on purpose: it is hashed on its own path below.
 */
const EDITABLE = [
    'firstname', 'lastname', 'username', 'dob', 'address', 'postcode',
    'country', 'speciality', 'hourly_rate', 'profile_image', 'description',
];

/**
 * The profile photograph.
 *
 * The schema's comment says "URL or file path", and a file path is the half that does not
 * work: this is drawn as a circular avatar on five mobile surfaces, so a `file:///…` from
 * an image picker — or a bare `uploads/abc123` from the server's own temp directory —
 * renders on the machine that chose it and as a blank circle everywhere else. The write
 * succeeds, and nothing reports it. The same guard the product gallery and `createMeal`
 * apply, except that here the field is required, so a bad value is **refused** rather than
 * dropped: a professional silently created with no photograph would fail schema validation
 * with a message about a missing field, naming neither the cause nor the fix.
 *
 * `http` is tolerated for the directory photographs that predate Cloudflare storage.
 * `POST /api/images/upload` always answers with https.
 */
const IMAGE_URL = /^https?:\/\/\S+$/i;

const badImage = (value) =>
    typeof value !== 'string' || !IMAGE_URL.test(value.trim())
        ? 'profile_image must be a URL (upload one through POST /api/images/upload). ' +
          'A local file path renders only on the device that chose it.'
        : null;

/** Take only the fields a client may write, trimming the image URL. */
const editablePatch = (body) => {
    const patch = {};
    for (const key of EDITABLE) {
        if (body[key] === undefined) continue;
        patch[key] = key === 'profile_image' ? String(body[key]).trim() : body[key];
    }
    return patch;
};

// Create a new professional
exports.createProfessional = async (req, res) => {
    try {
        const { firstname, lastname, username, password, dob, address, postcode, country, speciality, hourly_rate, profile_image, description } = req.body;

        const imageProblem = badImage(profile_image);
        if (imageProblem) return res.status(400).json({ message: imageProblem });
        
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
            profile_image: String(profile_image).trim(),
            description
        });

        await newProfessional.save();

        const created = newProfessional.toObject();
        delete created.password;

        res.status(201).json({ message: 'Professional created successfully', professional: created });
    } catch (error) {
        res.status(500).json({ message: 'Error creating professional', error: error.message });
    }
};

// Get all professionals
/**
 * GET /api/professionals/specialities — the speciality enum, read off the schema.
 *
 * Served rather than retyped in each client, because this list is load-bearing in a way a
 * dropdown usually is not: `planGeneratorV2` matches a recommended consultation to a
 * professional by speciality substring, so a value the enum does not contain produces a
 * referral nothing can ever resolve. The classic version of that mistake is the
 * practitioner noun — "Cardiologist" instead of "Cardiology" — which looks right in a form
 * and matches nothing.
 *
 * Reading `enumValues` off the schema means the portal cannot drift from the model: add a
 * speciality in one place and every client offers it.
 */
exports.getSpecialities = async (req, res) => {
    try {
        const values = Professional.schema.path('speciality').caster.enumValues;
        res.json({ specialities: [...values].sort((a, b) => a.localeCompare(b)) });
    } catch (error) {
        res.status(500).json({ message: 'Error reading specialities', error: error.message });
    }
};

exports.getAllProfessionals = async (req, res) => {
    try {
        const professionals = await Professional.find().select('-password');
        res.status(200).json(professionals);
    } catch (error) {
        res.status(500).json({ message: 'Error retrieving professionals', error: error.message });
    }
};

// Get a professional by ID
exports.getProfessionalById = async (req, res) => {
    try {
        const professional = await Professional.findById(req.params.id).select('-password');
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
        if (req.body.profile_image !== undefined) {
            const imageProblem = badImage(req.body.profile_image);
            if (imageProblem) return res.status(400).json({ message: imageProblem });
        }

        const updates = editablePatch(req.body);
        if (req.body.password) {
            updates.password = await bcrypt.hash(req.body.password, 10);
        }
        const updatedProfessional = await Professional.findByIdAndUpdate(
            req.params.id,
            updates,
            { new: true, runValidators: true }
        ).select('-password');
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

// Exported for the tests, which assert the sanitising rules directly.
exports._internal = { EDITABLE, badImage, editablePatch };
