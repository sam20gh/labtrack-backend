const mongoose = require('mongoose');

const ProfessionalSchema = new mongoose.Schema({
    firstname: { type: String, required: true },
    lastname: { type: String, required: true },
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }, // This should be hashed before storing
    dob: { type: Date, required: true },
    address: { type: String, required: true },
    postcode: { type: String, required: true },
    country: { type: String, required: true },
    speciality: [{
        type: String, enum: [
            "Allergy and Immunology", "Anesthesiology", "Cardiology", "Cardiothoracic Surgery",
            "Colorectal Surgery", "Critical Care Medicine", "Dermatology", "Emergency Medicine",
            "Endocrinology", "Family Medicine", "Gastroenterology", "General Surgery",
            "Geriatrics", "Hematology", "Hepatology", "Hospital Medicine", "Infectious Disease",
            "Internal Medicine", "Interventional Radiology", "Medical Genetics", "Neonatology",
            "Nephrology", "Neurology", "Neurosurgery", "Nuclear Medicine", "Obstetrics and Gynaecology (OB/GYN)",
            "Oncology", "Ophthalmology", "Orthopaedic Surgery", "Otolaryngology (ENT)",
            "Pain Management", "Palliative Care", "Pathology", "Paediatrics",
            "Physical Medicine and Rehabilitation (PM&R)", "Plastic Surgery", "Psychiatry",
            "Pulmonology", "Radiation Oncology", "Radiology", "Rheumatology",
            "Sleep Medicine", "Sports Medicine", "Thoracic Surgery", "Transplant Surgery",
            "Trauma Surgery", "Urology", "Vascular Surgery"
        ]
    }], // Multiple specialities allowed
    hourly_rate: { type: Number, required: true },
    profile_image: { type: String, required: true }, // URL or file path
    description: { type: String, required: true }
}, { timestamps: true });

const Professional = mongoose.model('Professional', ProfessionalSchema);

module.exports = Professional;
