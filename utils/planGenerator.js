const { extractHealthPlan } = require('./feedbackParser');

const calculateAge = (dob) => {
    const birthDate = new Date(dob);
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const isBeforeBirthday =
        today.getMonth() < birthDate.getMonth() ||
        (today.getMonth() === birthDate.getMonth() && today.getDate() < birthDate.getDate());
    return isBeforeBirthday ? age - 1 : age;
};

const generateUserPlan = (feedbackText, user, products, professionals) => {
    const healthPlan = extractHealthPlan(feedbackText);
    const userAge = calculateAge(user.dob);

    const plan = [];

    // Handle recommended tests
    for (const screening of healthPlan.recommended_screenings) {
        const { test, starting_age, frequency } = screening;

        if (userAge >= starting_age) {
            const productMatch = products.find(p =>
                p.name.toLowerCase().includes(test.toLowerCase())
            );

            const occurrences = Array.from({ length: 10 }, (_, i) => ({
                age: userAge + i,
                productID: productMatch?._id?.$oid || null,
                test
            }));

            plan.push({
                type: "test",
                test,
                frequency,
                start_age: userAge,
                productID: productMatch?._id?.$oid || null,
                occurrences
            });
        }
    }

    // Handle specialist consultations
    for (const consult of healthPlan.specialist_consultations) {
        const { speciality } = consult;

        const matchingProfessional = professionals.find(p =>
            p.speciality.some(spec => spec.toLowerCase().includes(speciality.toLowerCase()))
        );

        plan.push({
            type: "consultation",
            speciality,
            professionalID: matchingProfessional?._id?.$oid || null,
            scheduled_age: 50 // can be made dynamic if needed
        });
    }

    // Flatten and sort plan by age
    const sortedPlan = plan.flatMap(entry => {
        if (entry.type === "test") {
            return entry.occurrences.map(o => ({
                type: "test",
                test: o.test,
                age: o.age,
                productID: o.productID
            }));
        } else {
            return [{
                type: "consultation",
                speciality: entry.speciality,
                age: entry.scheduled_age,
                professionalID: entry.professionalID
            }];
        }
    }).sort((a, b) => a.age - b.age);

    return sortedPlan;
};

module.exports = { generateUserPlan };
