// utils/feedbackParser.js
//
// DEPRECATED (Phase 4). Keyword matching over AI prose: it recognised only a handful of
// exact phrases and silently discarded everything else. Superseded by the schema-enforced
// output of utils/interpretationEngine.js.
//
// Still referenced by the legacy /api/plans endpoints, which Phase 5 replaces with
// PlanItem generation from structured interpretations. Do not extend this file — add
// capability to the interpretation schema instead.

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

    // `speciality` MUST use the Professional.speciality enum spelling — planGenerator
    // matches by substring, so practitioner nouns ("Oncologist") match no enum value
    // ("Oncology") and the consultation is silently dropped from the plan.
    if (feedback.includes("Consult an Oncologist")) {
        healthPlan.specialist_consultations.push({
            speciality: "Oncology",
            urgency: "Moderate"
        });
    }

    if (feedback.includes("Consult a Genetic Counselor")) {
        healthPlan.specialist_consultations.push({
            speciality: "Medical Genetics",
            urgency: "High"
        });
    }

    return healthPlan;
};

module.exports = { extractHealthPlan };
