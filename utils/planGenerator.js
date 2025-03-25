
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
    const birthYear = new Date(user.dob).getFullYear();
    const currentYear = new Date().getFullYear();

    const plan = [];

    // Handle screenings and match to products
    for (const screening of healthPlan.recommended_screenings) {
        const { test, starting_age, frequency } = screening;

        const productMatch = products.find(p =>
            p.name.toLowerCase().includes(test.toLowerCase()) ||
            test.toLowerCase().includes(p.name.toLowerCase())
        );
        if (!productMatch) {
            console.warn("⚠️ No matching product for test:", test);
        }
        if (userAge >= starting_age && productMatch) {
            const occurrences = Array.from({ length: 10 }, (_, i) => {
                const age = userAge + i;
                const year = birthYear + age;
                return {
                    age,
                    year,
                    test,
                    productID: productMatch._id?.$oid || productMatch._id || null,
                    productName: productMatch.name
                };
            });

            plan.push({
                type: "test",
                test,
                frequency,
                productID: productMatch._id?.$oid || productMatch._id || null,
                productName: productMatch.name,
                start_age: userAge,
                occurrences
            });
        }
    }

    // Handle specialist consultations and match to professionals
    for (const consult of healthPlan.specialist_consultations) {
        const { speciality } = consult;

        const matchingProfessional = professionals.find(p =>
            p.speciality.some(spec =>
                spec.toLowerCase().includes(speciality.toLowerCase()) ||
                speciality.toLowerCase().includes(spec.toLowerCase())
            )
        );

        if (matchingProfessional) {
            const scheduled_age = 50;
            const year = birthYear + scheduled_age;

            plan.push({
                type: "consultation",
                speciality,
                professionalID: matchingProfessional._id?.$oid || matchingProfessional._id || null,
                professionalName: matchingProfessional.firstname + " " + matchingProfessional.lastname,
                scheduled_age,
                year
            });
        }
    }

    // Flatten and sort
    const sortedPlan = plan.flatMap(entry => {
        if (entry.type === "test") {
            return entry.occurrences.map(o => ({
                type: "test",
                test: o.test,
                age: o.age,
                year: o.year,
                productID: o.productID,
                productName: o.productName
            }));
        } else {
            return [{
                type: "consultation",
                speciality: entry.speciality,
                age: entry.scheduled_age,
                year: entry.year,
                professionalID: entry.professionalID,
                professionalName: entry.professionalName
            }];
        }
    }).sort((a, b) => a.age - b.age);

    return sortedPlan;
};

module.exports = { generateUserPlan };
