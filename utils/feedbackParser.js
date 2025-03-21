// utils/feedbackParser.js

const extractHealthPlan = (feedback) => {
    const healthPlan = {
        recommended_screenings: [],
        lifestyle_recommendations: [],
        specialist_consultations: [],
        follow_up: "Annual check-ups recommended"
    };

    if (feedback.includes("PSA Testing")) {
        healthPlan.recommended_screenings.push({
            condition: "Prostate Cancer",
            test: "PSA Test",
            starting_age: 40,
            frequency: "Annually"
        });
    }

    if (feedback.includes("MRI/Endoscopic Ultrasound")) {
        healthPlan.recommended_screenings.push({
            condition: "Pancreatic Cancer",
            test: "MRI/Endoscopic Ultrasound",
            starting_age: 50,
            frequency: "Annually"
        });
    }

    if (feedback.includes("Clinical Breast Exam")) {
        healthPlan.recommended_screenings.push({
            condition: "Male Breast Cancer",
            test: "Clinical Breast Exam",
            starting_age: 35,
            frequency: "Annually"
        });
    }

    if (feedback.toLowerCase().includes("exercise")) {
        healthPlan.lifestyle_recommendations.push("Engage in regular physical activity (150 min/week)");
    }

    if (feedback.toLowerCase().includes("limit alcohol")) {
        healthPlan.lifestyle_recommendations.push("Limit alcohol consumption");
    }

    if (feedback.includes("Consult an Oncologist")) {
        healthPlan.specialist_consultations.push({
            speciality: "Oncologist",
            urgency: "Moderate"
        });
    }

    if (feedback.includes("Consult a Genetic Counselor")) {
        healthPlan.specialist_consultations.push({
            speciality: "Genetic Counselor",
            urgency: "High"
        });
    }

    return healthPlan;
};

module.exports = { extractHealthPlan };
