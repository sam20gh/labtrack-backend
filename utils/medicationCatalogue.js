/**
 * Plain-language drug catalogue, and the deterministic interaction rules over it.
 *
 * This module is the safety floor of the medication checker. It is deliberately NOT an AI
 * output: `medicationEngine.js` calls Claude to read a photograph and to write the prose a
 * person reads, but the question "is this pair dangerous" is answered here, by a table, so
 * that the answer cannot vary between two runs of the same check.
 *
 * Why a table at all when a model knows these interactions perfectly well:
 *
 *   - **A model that silently misses warfarin + ibuprofen once in two hundred calls is not
 *     acceptable, and there is no way to know which call it was.** The table always fires.
 *     The model may add findings the table does not carry; it may never remove or downgrade
 *     one the table produced. `mergeFindings` in `medicationEngine.js` enforces that.
 *   - A rule is reviewable by a clinician as a diff. A prompt is not.
 *
 * Lives on the server for the same reason `biomarkerGlossary.js` does: this is clinical
 * copy, and a wrong line has to be fixable the same day rather than on the next app-store
 * release. The client renders whatever it is given and degrades to the drug's own name when
 * an entry is missing.
 *
 * ── Coverage is stated, never assumed ─────────────────────────────────────────────────
 *
 * The catalogue is a few dozen common drugs, not a formulary. A medication it does not know
 * cannot be classified, so it cannot be run against the rules — and the check says so, by
 * name, in `uncheckable`. **Silence from this module is not clearance.** Every caller
 * surfaces that distinction; see `SAFETY_FOOTER`.
 *
 * ── Writing an entry ──────────────────────────────────────────────────────────────────
 *
 * 1. `plainName` is a label of about 34 characters, not a definition — "Cholesterol
 *    tablet", not "A drug that inhibits HMG-CoA reductase".
 * 2. `classes` is what the rules match on. Getting these right matters more than the prose:
 *    a drug filed under the wrong class is a missed interaction.
 * 3. No doses, no numbers. Dosing is prescriber-specific and age-adjusted, and a figure
 *    here will eventually contradict the label on someone's box.
 * 4. `sideEffects.serious` is the "seek help" list, and is rendered in red. Keep it to
 *    things a member of the public can recognise without a clinician.
 */

/** Appended to every rendered interaction check. The checker never issues an all-clear. */
const SAFETY_FOOTER =
    'This check looks at what LabTrack knows about your medicines. It cannot see anything '
    + 'you have not added, and no automated check replaces your pharmacist or doctor. Never '
    + 'stop or change a prescribed medicine because of what you read here — take this to '
    + 'them and ask.';

/**
 * Severity vocabulary, worst first. Deliberately words rather than a percentage: the
 * symptom checker learned that a number on a clinical screen reads as certainty, and here
 * it would be certainty about harm.
 */
const SEVERITY = ['severe', 'moderate', 'mild'];

const severityRank = (s) => {
    const i = SEVERITY.indexOf(s);
    return i === -1 ? SEVERITY.length : i;
};

/** True when `a` is at least as serious as `b`. */
const atLeastAsSevere = (a, b) => severityRank(a) <= severityRank(b);

// ── The catalogue ────────────────────────────────────────────────────────────────────

const DRUGS = {
    // ── Cardiovascular: statins ───────────────────────────────────────────────────────
    atorvastatin: {
        plainName: 'Cholesterol tablet',
        brandNames: ['Lipitor', 'Atorvaliq'],
        classes: ['statin'],
        treats: 'High cholesterol',
        whatItIs: 'Atorvastatin is a statin — it lowers the amount of cholesterol your liver makes.',
        whyItMatters: 'Lowering cholesterol over years reduces the chance of a heart attack or a stroke, which is why it is usually taken long term rather than until you feel better.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature, out of direct sunlight. It does not need refrigerating.',
        sideEffects: {
            minor: ['Muscle aches', 'Headache', 'Wind or indigestion', 'Feeling sick'],
            serious: ['Muscle pain or weakness that is severe or spreading', 'Dark or tea-coloured urine', 'Yellowing of the skin or eyes'],
        },
    },
    simvastatin: {
        plainName: 'Cholesterol tablet',
        brandNames: ['Zocor'],
        classes: ['statin'],
        treats: 'High cholesterol',
        whatItIs: 'Simvastatin is a statin — it lowers the amount of cholesterol your liver makes.',
        whyItMatters: 'It is usually taken in the evening, because the liver makes most of its cholesterol overnight.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature, away from damp.',
        sideEffects: {
            minor: ['Muscle aches', 'Constipation', 'Headache'],
            serious: ['Severe or spreading muscle pain', 'Dark urine', 'Yellowing of the skin or eyes'],
        },
    },
    rosuvastatin: {
        plainName: 'Cholesterol tablet',
        brandNames: ['Crestor'],
        classes: ['statin'],
        treats: 'High cholesterol',
        whatItIs: 'Rosuvastatin is a statin — it lowers the cholesterol your liver produces.',
        whyItMatters: 'It is less affected by grapefruit than some other statins, but it interacts with several other medicines.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature.',
        sideEffects: {
            minor: ['Muscle aches', 'Headache', 'Feeling sick'],
            serious: ['Severe muscle pain or weakness', 'Dark urine'],
        },
    },

    // ── Cardiovascular: blood pressure and heart ──────────────────────────────────────
    lisinopril: {
        plainName: 'Blood pressure tablet',
        brandNames: ['Zestril', 'Prinivil'],
        classes: ['ace_inhibitor', 'antihypertensive'],
        treats: 'High blood pressure and heart failure',
        whatItIs: 'Lisinopril is an ACE inhibitor. It relaxes your blood vessels so your heart does not have to push as hard.',
        whyItMatters: 'It also protects the kidneys in people with diabetes, which is often why it is chosen over other blood pressure tablets.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature, in the original container.',
        sideEffects: {
            minor: ['A dry, tickly cough', 'Dizziness when standing up', 'Headache'],
            serious: ['Swelling of the lips, tongue or throat', 'Very little or no urine', 'Fainting'],
        },
    },
    ramipril: {
        plainName: 'Blood pressure tablet',
        brandNames: ['Altace', 'Tritace'],
        classes: ['ace_inhibitor', 'antihypertensive'],
        treats: 'High blood pressure and heart failure',
        whatItIs: 'Ramipril is an ACE inhibitor, which widens your blood vessels to bring blood pressure down.',
        whyItMatters: 'The dry cough it can cause is harmless but persistent, and is the usual reason people are switched to a different type.',
        form: 'capsule',
        prescriptionOnly: true,
        storage: 'Room temperature.',
        sideEffects: {
            minor: ['Dry cough', 'Dizziness', 'Tiredness'],
            serious: ['Swelling of the face, lips or throat', 'Fainting'],
        },
    },
    losartan: {
        plainName: 'Blood pressure tablet',
        brandNames: ['Cozaar'],
        classes: ['arb', 'antihypertensive'],
        treats: 'High blood pressure',
        whatItIs: 'Losartan blocks a hormone that tightens blood vessels, so they stay relaxed.',
        whyItMatters: 'It works much like an ACE inhibitor but rarely causes the dry cough, so it is often the replacement when that becomes a problem.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature, away from damp.',
        sideEffects: {
            minor: ['Dizziness', 'Tiredness', 'Blocked nose'],
            serious: ['Swelling of the face or throat', 'Fainting', 'Irregular heartbeat'],
        },
    },
    amlodipine: {
        plainName: 'Blood pressure tablet',
        brandNames: ['Norvasc'],
        classes: ['calcium_channel_blocker', 'antihypertensive'],
        treats: 'High blood pressure and angina',
        whatItIs: 'Amlodipine relaxes the muscle in your artery walls so blood flows more easily.',
        whyItMatters: 'Swollen ankles are its most common nuisance effect and usually settle or respond to a dose change.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature, in the original packet.',
        sideEffects: {
            minor: ['Swollen ankles', 'Flushing', 'Headache', 'Tiredness'],
            serious: ['Chest pain that is new or worse', 'Fainting', 'Very fast heartbeat'],
        },
    },
    bisoprolol: {
        plainName: 'Heart rate tablet',
        brandNames: ['Zebeta', 'Cardicor'],
        classes: ['beta_blocker', 'antihypertensive'],
        treats: 'High blood pressure, angina and heart failure',
        whatItIs: 'Bisoprolol is a beta blocker. It slows your heart and lets it beat with less effort.',
        whyItMatters: 'Because it slows the heart, it blunts the racing pulse that normally warns you of a low blood sugar — which matters if you also treat diabetes.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature.',
        sideEffects: {
            minor: ['Tiredness', 'Cold hands and feet', 'Slow pulse'],
            serious: ['Very slow or irregular heartbeat', 'Wheezing or breathlessness', 'Fainting'],
        },
    },
    digoxin: {
        plainName: 'Heart rhythm tablet',
        brandNames: ['Lanoxin'],
        classes: ['digoxin', 'cardiac_glycoside'],
        treats: 'Irregular heartbeat and heart failure',
        whatItIs: 'Digoxin steadies and strengthens the heartbeat.',
        whyItMatters: 'The helpful dose and the toxic dose are unusually close, so quite ordinary things — a new water tablet, a stomach upset — can tip it over.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature, away from damp.',
        sideEffects: {
            minor: ['Feeling sick', 'Loss of appetite', 'Tiredness'],
            serious: ['Seeing halos or yellow-green tinges', 'Confusion', 'Very slow or irregular pulse', 'Repeated vomiting'],
        },
    },
    amiodarone: {
        plainName: 'Heart rhythm tablet',
        brandNames: ['Cordarone'],
        classes: ['amiodarone', 'antiarrhythmic', 'enzyme_inhibitor'],
        treats: 'Serious irregular heart rhythms',
        whatItIs: 'Amiodarone settles dangerous heart rhythms.',
        whyItMatters: 'It stays in the body for weeks after the last dose, so its interactions continue long after someone stops taking it.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature, protected from light.',
        sideEffects: {
            minor: ['Metallic taste', 'Sensitivity to sunlight', 'Feeling sick'],
            serious: ['New cough or breathlessness', 'Vision changes', 'Yellowing of the skin or eyes'],
        },
    },
    isosorbide_mononitrate: {
        plainName: 'Angina tablet',
        brandNames: ['Imdur', 'Monomil'],
        classes: ['nitrate'],
        treats: 'Angina',
        whatItIs: 'A nitrate, which widens blood vessels so the heart gets blood more easily.',
        whyItMatters: 'Nitrates and erectile dysfunction tablets both drop blood pressure, and together they can drop it dangerously.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature, in the original container.',
        sideEffects: {
            minor: ['Headache', 'Flushing', 'Dizziness'],
            serious: ['Fainting', 'Very fast heartbeat', 'Blurred vision'],
        },
    },
    furosemide: {
        plainName: 'Water tablet',
        brandNames: ['Lasix'],
        classes: ['loop_diuretic', 'diuretic'],
        treats: 'Fluid build-up and heart failure',
        whatItIs: 'Furosemide is a water tablet — it makes your kidneys pass extra salt and water.',
        whyItMatters: 'It flushes out potassium along with the water, which is why potassium is often checked or replaced alongside it.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature, protected from light.',
        sideEffects: {
            minor: ['Passing urine more often', 'Thirst', 'Dizziness when standing'],
            serious: ['Muscle cramps or weakness', 'Irregular heartbeat', 'Fainting', 'Hearing changes'],
        },
    },
    spironolactone: {
        plainName: 'Water tablet',
        brandNames: ['Aldactone'],
        classes: ['potassium_sparing_diuretic', 'diuretic', 'potassium_raising'],
        treats: 'Heart failure, fluid build-up and some hormonal conditions',
        whatItIs: 'Spironolactone removes fluid but, unlike most water tablets, holds on to potassium.',
        whyItMatters: 'That retained potassium is the reason it interacts with several very common blood pressure medicines.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature.',
        sideEffects: {
            minor: ['Feeling sick', 'Breast tenderness', 'Dizziness'],
            serious: ['Muscle weakness', 'Irregular or slow heartbeat', 'Numbness or tingling'],
        },
    },

    // ── Blood thinners and antiplatelets ──────────────────────────────────────────────
    warfarin: {
        plainName: 'Blood thinning tablet',
        brandNames: ['Coumadin', 'Jantoven'],
        classes: ['anticoagulant', 'warfarin'],
        treats: 'Preventing and treating blood clots',
        whatItIs: 'Warfarin slows down clotting so a clot is less likely to form or grow.',
        whyItMatters: 'It has more interactions than almost any other common medicine, and many of them are with things you can buy without a prescription.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature, protected from light.',
        sideEffects: {
            minor: ['Bruising more easily', 'Bleeding a little longer from small cuts'],
            serious: ['Blood in urine or stools', 'Black tarry stools', 'Coughing or vomiting blood', 'A bad headache after a bump to the head'],
        },
    },
    apixaban: {
        plainName: 'Blood thinning tablet',
        brandNames: ['Eliquis'],
        classes: ['anticoagulant', 'doac'],
        treats: 'Preventing and treating blood clots',
        whatItIs: 'Apixaban blocks one step of the clotting process directly.',
        whyItMatters: 'It does not need the regular blood tests warfarin does, but it still raises bleeding risk with painkillers and other thinners.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature.',
        sideEffects: {
            minor: ['Bruising', 'Nosebleeds', 'Bleeding longer from cuts'],
            serious: ['Blood in urine or stools', 'Black tarry stools', 'Coughing up blood', 'Unusual or severe headache'],
        },
    },
    clopidogrel: {
        plainName: 'Anti-clotting tablet',
        brandNames: ['Plavix'],
        classes: ['antiplatelet'],
        treats: 'Preventing heart attack and stroke',
        whatItIs: 'Clopidogrel stops platelets sticking together to form a clot.',
        whyItMatters: 'It needs the liver to switch it on, so a few common stomach medicines can weaken it.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature, away from damp.',
        sideEffects: {
            minor: ['Bruising', 'Nosebleeds', 'Indigestion'],
            serious: ['Blood in urine or stools', 'Black tarry stools', 'Bleeding that will not stop'],
        },
    },

    // ── Painkillers and anti-inflammatories ───────────────────────────────────────────
    ibuprofen: {
        plainName: 'Anti-inflammatory painkiller',
        brandNames: ['Advil', 'Nurofen', 'Motrin'],
        classes: ['nsaid', 'analgesic'],
        treats: 'Pain, inflammation and fever',
        whatItIs: 'Ibuprofen is an anti-inflammatory painkiller, sold both on prescription and over the counter.',
        whyItMatters: 'Being available without a prescription does not make it minor — it is involved in more serious interactions than most prescribed drugs.',
        form: 'tablet',
        prescriptionOnly: false,
        storage: 'Room temperature, away from damp.',
        sideEffects: {
            minor: ['Indigestion', 'Feeling sick', 'Headache'],
            serious: ['Black tarry stools', 'Vomiting blood or what looks like coffee grounds', 'Severe stomach pain', 'Swelling of the ankles'],
        },
    },
    naproxen: {
        plainName: 'Anti-inflammatory painkiller',
        brandNames: ['Aleve', 'Naprosyn'],
        classes: ['nsaid', 'analgesic'],
        treats: 'Pain and inflammation, often in joints',
        whatItIs: 'Naproxen is a longer-acting anti-inflammatory painkiller.',
        whyItMatters: 'It lasts longer than ibuprofen, so its effect on the stomach and kidneys lasts longer too.',
        form: 'tablet',
        prescriptionOnly: false,
        storage: 'Room temperature.',
        sideEffects: {
            minor: ['Indigestion', 'Heartburn', 'Dizziness'],
            serious: ['Black tarry stools', 'Vomiting blood', 'Severe stomach pain', 'Swollen ankles'],
        },
    },
    aspirin: {
        plainName: 'Aspirin',
        brandNames: ['Disprin', 'Ecotrin'],
        classes: ['nsaid', 'antiplatelet', 'analgesic'],
        treats: 'Pain and fever, or at a low dose, preventing clots',
        whatItIs: 'Aspirin thins the blood at a low daily dose and relieves pain at higher ones.',
        whyItMatters: 'Low-dose aspirin is a blood thinner, not a painkiller, and adding another thinner or an anti-inflammatory on top of it stacks the bleeding risk.',
        form: 'tablet',
        prescriptionOnly: false,
        storage: 'Room temperature, away from damp. Discard if it smells of vinegar.',
        sideEffects: {
            minor: ['Indigestion', 'Bruising more easily'],
            serious: ['Black tarry stools', 'Vomiting blood', 'Ringing in the ears', 'Wheezing'],
        },
    },
    paracetamol: {
        plainName: 'Everyday painkiller',
        brandNames: ['Tylenol', 'Panadol', 'Acetaminophen'],
        classes: ['paracetamol', 'analgesic'],
        treats: 'Pain and fever',
        whatItIs: 'Paracetamol relieves pain and brings a temperature down. It is not an anti-inflammatory.',
        whyItMatters: 'It is in a great many cold and flu remedies under other names, and the risk is taking it twice over without realising.',
        form: 'tablet',
        prescriptionOnly: false,
        storage: 'Room temperature.',
        sideEffects: {
            minor: ['Rarely causes side effects at the recommended dose'],
            serious: ['Yellowing of the skin or eyes', 'Pain in the upper right of the abdomen', 'Any suspected overdose, even if you feel well'],
        },
    },
    codeine: {
        plainName: 'Strong painkiller',
        brandNames: ['Co-codamol (with paracetamol)'],
        classes: ['opioid', 'cns_depressant', 'analgesic'],
        treats: 'Pain that milder painkillers have not settled',
        whatItIs: 'Codeine is a mild opioid, often combined with paracetamol in one tablet.',
        whyItMatters: 'It slows breathing, and anything else that does the same — alcohol, sleeping tablets, some anxiety medicines — adds to that.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature, somewhere others cannot reach it.',
        sideEffects: {
            minor: ['Constipation', 'Drowsiness', 'Feeling sick'],
            serious: ['Slow or shallow breathing', 'Being very hard to wake', 'Confusion'],
        },
    },
    tramadol: {
        plainName: 'Strong painkiller',
        brandNames: ['Ultram'],
        classes: ['opioid', 'cns_depressant', 'serotonergic', 'analgesic'],
        treats: 'Moderate to severe pain',
        whatItIs: 'Tramadol is an opioid painkiller that also acts on serotonin.',
        whyItMatters: 'That second action is why it interacts with antidepressants in a way other opioids do not.',
        form: 'capsule',
        prescriptionOnly: true,
        storage: 'Room temperature, out of reach of others.',
        sideEffects: {
            minor: ['Feeling sick', 'Dizziness', 'Constipation', 'Dry mouth'],
            serious: ['Slow or shallow breathing', 'Seizures', 'Agitation with shivering and a fast heartbeat'],
        },
    },
    methotrexate: {
        plainName: 'Immune-suppressing tablet',
        brandNames: ['Trexall'],
        classes: ['methotrexate', 'immunosuppressant'],
        treats: 'Rheumatoid arthritis, psoriasis and some cancers',
        whatItIs: 'Methotrexate damps down an overactive immune system.',
        whyItMatters: 'For arthritis it is taken once a WEEK, and taking it daily by mistake is a well-known and serious error.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature, in the original container, away from others.',
        sideEffects: {
            minor: ['Feeling sick', 'Tiredness', 'Mouth ulcers'],
            serious: ['Sore throat or fever', 'Unusual bruising or bleeding', 'Breathlessness or a dry cough', 'Severe mouth ulcers'],
        },
    },

    // ── Diabetes ──────────────────────────────────────────────────────────────────────
    metformin: {
        plainName: 'Diabetes tablet',
        brandNames: ['Glucophage', 'Fortamet'],
        classes: ['biguanide', 'antidiabetic'],
        treats: 'Type 2 diabetes',
        whatItIs: 'Metformin lowers the sugar your liver releases and helps your body respond to insulin.',
        whyItMatters: 'It is cleared by the kidneys, so anything that puts the kidneys under strain — dehydration, a scan dye, some painkillers — matters more than it would otherwise.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature, away from damp.',
        sideEffects: {
            minor: ['Loose stools', 'Feeling sick', 'Metallic taste', 'Wind'],
            serious: ['Deep or fast breathing', 'Severe muscle pain', 'Unusual tiredness with cold hands and feet', 'Repeated vomiting'],
        },
    },
    gliclazide: {
        plainName: 'Diabetes tablet',
        brandNames: ['Diamicron'],
        classes: ['sulfonylurea', 'antidiabetic', 'hypoglycaemic'],
        treats: 'Type 2 diabetes',
        whatItIs: 'Gliclazide pushes the pancreas to release more insulin.',
        whyItMatters: 'Unlike metformin it can drive blood sugar too low, so skipped meals and alcohol both matter.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature.',
        sideEffects: {
            minor: ['Feeling shaky or hungry', 'Sweating', 'Headache'],
            serious: ['Confusion or difficulty waking', 'Seizures', 'Repeated low blood sugars'],
        },
    },
    insulin: {
        plainName: 'Insulin',
        brandNames: ['Lantus', 'Humalog', 'NovoRapid'],
        classes: ['insulin', 'antidiabetic', 'hypoglycaemic'],
        treats: 'Type 1 and some type 2 diabetes',
        whatItIs: 'Insulin replaces or tops up the hormone that moves sugar out of your blood.',
        whyItMatters: 'It is the one medicine here whose storage genuinely matters — heat or freezing destroys it without changing how it looks.',
        form: 'injection',
        prescriptionOnly: true,
        storage: 'Unopened pens in the fridge, never the freezer. The pen in use can stay at room temperature for the period stated on its label.',
        sideEffects: {
            minor: ['Redness or lumps where you inject', 'Weight gain'],
            serious: ['Confusion or difficulty waking', 'Seizures', 'Sweating with shaking and a racing heart'],
        },
    },

    // ── Mental health ─────────────────────────────────────────────────────────────────
    sertraline: {
        plainName: 'Antidepressant',
        brandNames: ['Zoloft', 'Lustral'],
        classes: ['ssri', 'antidepressant', 'serotonergic'],
        treats: 'Depression, anxiety and panic',
        whatItIs: 'Sertraline is an SSRI. It raises the amount of serotonin available in the brain.',
        whyItMatters: 'It takes a few weeks to help, and stopping it suddenly causes withdrawal effects — which is why it is tapered rather than dropped.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature.',
        sideEffects: {
            minor: ['Feeling sick', 'Trouble sleeping', 'Dry mouth', 'Headache'],
            serious: ['Agitation with shivering, sweating and a racing heart', 'Thoughts of harming yourself', 'Unusual bruising or bleeding'],
        },
    },
    escitalopram: {
        plainName: 'Antidepressant',
        brandNames: ['Lexapro', 'Cipralex'],
        classes: ['ssri', 'antidepressant', 'serotonergic', 'qt_prolonging'],
        treats: 'Depression and anxiety',
        whatItIs: 'Escitalopram is an SSRI, working on serotonin in the brain.',
        whyItMatters: 'At higher doses it can affect the heart\'s electrical timing, which is why the dose is capped rather than raised indefinitely.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature.',
        sideEffects: {
            minor: ['Feeling sick', 'Trouble sleeping', 'Sweating', 'Tiredness'],
            serious: ['Agitation with shivering and a fast heartbeat', 'Fainting or palpitations', 'Thoughts of harming yourself'],
        },
    },
    citalopram: {
        plainName: 'Antidepressant',
        brandNames: ['Celexa', 'Cipramil'],
        classes: ['ssri', 'antidepressant', 'serotonergic', 'qt_prolonging'],
        treats: 'Depression and anxiety',
        whatItIs: 'Citalopram is an SSRI antidepressant.',
        whyItMatters: 'Like escitalopram it has a dose ceiling because of its effect on heart rhythm.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature.',
        sideEffects: {
            minor: ['Dry mouth', 'Sweating', 'Feeling sick', 'Drowsiness'],
            serious: ['Palpitations or fainting', 'Agitation with shivering and sweating', 'Thoughts of harming yourself'],
        },
    },
    lithium: {
        plainName: 'Mood stabiliser',
        brandNames: ['Priadel', 'Camcolit'],
        classes: ['lithium', 'mood_stabiliser'],
        treats: 'Bipolar disorder',
        whatItIs: 'Lithium steadies mood over the long term.',
        whyItMatters: 'The useful level and the toxic level are close, and the kidneys control it — so dehydration, water tablets and common painkillers can all push it too high.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature.',
        sideEffects: {
            minor: ['Mild hand tremor', 'Thirst', 'Passing more urine'],
            serious: ['Coarse shaking', 'Slurred speech', 'Vomiting or diarrhoea that will not stop', 'Unsteadiness or confusion'],
        },
    },
    diazepam: {
        plainName: 'Anxiety or muscle relaxant tablet',
        brandNames: ['Valium'],
        classes: ['benzodiazepine', 'cns_depressant'],
        treats: 'Anxiety, muscle spasm and some seizures',
        whatItIs: 'Diazepam is a benzodiazepine — it calms the nervous system.',
        whyItMatters: 'It slows breathing, and combined with alcohol or an opioid painkiller that effect multiplies rather than adds.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature, somewhere secure.',
        sideEffects: {
            minor: ['Drowsiness', 'Unsteadiness', 'Confusion in older people'],
            serious: ['Slow or shallow breathing', 'Being very hard to wake', 'Memory blanks'],
        },
    },
    sumatriptan: {
        plainName: 'Migraine tablet',
        brandNames: ['Imigran', 'Imitrex'],
        classes: ['triptan', 'serotonergic'],
        treats: 'Migraine attacks',
        whatItIs: 'Sumatriptan narrows the widened blood vessels behind a migraine.',
        whyItMatters: 'Because it acts on serotonin it needs care alongside antidepressants that do the same.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature.',
        sideEffects: {
            minor: ['Tingling', 'Flushing', 'Drowsiness', 'A tight feeling in the chest or throat'],
            serious: ['Chest pain or pressure that does not pass', 'Weakness on one side', 'Slurred speech'],
        },
    },

    // ── Hormones and thyroid ──────────────────────────────────────────────────────────
    levothyroxine: {
        plainName: 'Thyroid hormone tablet',
        brandNames: ['Synthroid', 'Euthyrox', 'Eltroxin'],
        classes: ['thyroid_hormone'],
        treats: 'An underactive thyroid',
        whatItIs: 'Levothyroxine replaces the thyroid hormone your body is not making enough of.',
        whyItMatters: 'It is absorbed poorly if anything else is in the stomach, which is why it is taken on an empty stomach well before breakfast.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature, protected from light and damp.',
        sideEffects: {
            minor: ['Usually none once the dose is right'],
            serious: ['Racing or irregular heartbeat', 'Chest pain', 'Marked weight loss with sweating and tremor'],
        },
    },
    prednisolone: {
        plainName: 'Steroid tablet',
        brandNames: ['Deltasone', 'Prednisone'],
        classes: ['corticosteroid', 'immunosuppressant'],
        treats: 'Inflammation, asthma flares and autoimmune conditions',
        whatItIs: 'Prednisolone is a steroid that damps down inflammation quickly.',
        whyItMatters: 'After more than a few weeks the body stops making its own steroid, so it has to be reduced gradually rather than stopped.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature.',
        sideEffects: {
            minor: ['Increased appetite', 'Trouble sleeping', 'Mood changes', 'Indigestion'],
            serious: ['Black tarry stools', 'Severe stomach pain', 'Signs of infection', 'Marked mood or behaviour change'],
        },
    },

    // ── Stomach ───────────────────────────────────────────────────────────────────────
    omeprazole: {
        plainName: 'Stomach acid tablet',
        brandNames: ['Prilosec', 'Losec'],
        classes: ['ppi', 'enzyme_inhibitor', 'acid_suppressant'],
        treats: 'Heartburn, reflux and stomach ulcers',
        whatItIs: 'Omeprazole reduces how much acid your stomach makes.',
        whyItMatters: 'Less stomach acid changes how some other medicines are absorbed or activated.',
        form: 'capsule',
        prescriptionOnly: false,
        storage: 'Room temperature, away from damp.',
        sideEffects: {
            minor: ['Headache', 'Wind', 'Loose stools or constipation'],
            serious: ['Severe or watery diarrhoea', 'Muscle cramps or spasms', 'Unusual tiredness with a fast heartbeat'],
        },
    },
    lansoprazole: {
        plainName: 'Stomach acid capsule',
        brandNames: ['Prevacid', 'Zoton'],
        classes: ['ppi', 'acid_suppressant'],
        treats: 'Heartburn, reflux and ulcers',
        whatItIs: 'Lansoprazole reduces stomach acid production.',
        whyItMatters: 'Long courses are reviewed rather than repeated indefinitely, because reduced acid affects how some minerals are absorbed.',
        form: 'capsule',
        prescriptionOnly: false,
        storage: 'Room temperature.',
        sideEffects: {
            minor: ['Headache', 'Wind', 'Feeling sick'],
            serious: ['Severe watery diarrhoea', 'Muscle cramps', 'Unusual tiredness'],
        },
    },

    // ── Anti-infectives ───────────────────────────────────────────────────────────────
    amoxicillin: {
        plainName: 'Antibiotic',
        brandNames: ['Amoxil'],
        classes: ['penicillin', 'antibiotic'],
        treats: 'Bacterial infections',
        whatItIs: 'Amoxicillin is a penicillin antibiotic.',
        whyItMatters: 'The course is finished even once you feel better, because stopping early leaves the hardiest bacteria behind.',
        form: 'capsule',
        prescriptionOnly: true,
        storage: 'Capsules at room temperature. A made-up liquid usually goes in the fridge and is thrown away after the days stated on the bottle.',
        sideEffects: {
            minor: ['Feeling sick', 'Loose stools', 'Thrush'],
            serious: ['A rash with swelling or wheezing', 'Severe or bloody diarrhoea', 'Yellowing of the skin or eyes'],
        },
    },
    clarithromycin: {
        plainName: 'Antibiotic',
        brandNames: ['Klaricid', 'Biaxin'],
        classes: ['macrolide', 'antibiotic', 'enzyme_inhibitor', 'qt_prolonging'],
        treats: 'Chest, throat and skin infections',
        whatItIs: 'Clarithromycin is a macrolide antibiotic.',
        whyItMatters: 'It blocks a liver enzyme that clears many other medicines, so a short course can push a long-term medicine to a dangerous level.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature, away from damp.',
        sideEffects: {
            minor: ['Taste changes', 'Feeling sick', 'Indigestion'],
            serious: ['Severe or bloody diarrhoea', 'Palpitations or fainting', 'Yellowing of the skin or eyes'],
        },
    },
    ciprofloxacin: {
        plainName: 'Antibiotic',
        brandNames: ['Cipro'],
        classes: ['fluoroquinolone', 'antibiotic', 'qt_prolonging'],
        treats: 'Urinary and some other bacterial infections',
        whatItIs: 'Ciprofloxacin is a fluoroquinolone antibiotic.',
        whyItMatters: 'It can inflame tendons, and dairy or indigestion remedies taken at the same time stop it being absorbed.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature, protected from damp.',
        sideEffects: {
            minor: ['Feeling sick', 'Loose stools', 'Headache'],
            serious: ['Tendon pain or swelling, especially at the heel', 'Numbness or tingling', 'Severe diarrhoea', 'Palpitations'],
        },
    },
    metronidazole: {
        plainName: 'Antibiotic',
        brandNames: ['Flagyl'],
        classes: ['nitroimidazole', 'antibiotic'],
        treats: 'Dental, gut and some other infections',
        whatItIs: 'Metronidazole treats infections caused by bacteria that grow without oxygen.',
        whyItMatters: 'Alcohol during the course, and for a couple of days after, causes a sudden and severe reaction.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature, protected from light.',
        sideEffects: {
            minor: ['Metallic taste', 'Feeling sick', 'Furred tongue'],
            serious: ['Numbness or tingling in hands or feet', 'Seizures', 'Severe diarrhoea'],
        },
    },
    trimethoprim: {
        plainName: 'Antibiotic',
        brandNames: ['Trimpex', 'Monotrim'],
        classes: ['trimethoprim', 'antibiotic', 'potassium_raising', 'folate_antagonist'],
        treats: 'Urine infections',
        whatItIs: 'Trimethoprim is an antibiotic used mainly for urinary infections.',
        whyItMatters: 'It raises potassium and works against folate, which is what puts it on the list beside several long-term medicines.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature.',
        sideEffects: {
            minor: ['Feeling sick', 'Itching', 'Rash'],
            serious: ['A widespread or blistering rash', 'Muscle weakness', 'Sore throat with fever', 'Unusual bruising'],
        },
    },

    // ── Respiratory ───────────────────────────────────────────────────────────────────
    salbutamol: {
        plainName: 'Reliever inhaler',
        brandNames: ['Ventolin', 'Albuterol', 'ProAir'],
        classes: ['saba', 'bronchodilator'],
        treats: 'Asthma and other wheezing conditions',
        whatItIs: 'Salbutamol opens up the airways within minutes.',
        whyItMatters: 'Needing it more often than usual is a warning that the underlying condition is not controlled, not a reason to simply use it more.',
        form: 'inhaler',
        prescriptionOnly: true,
        storage: 'Room temperature. Do not pierce or burn the canister, and keep it away from heat.',
        sideEffects: {
            minor: ['Shaky hands', 'Fast heartbeat', 'Headache'],
            serious: ['Needing it far more often than usual', 'Chest tightness that does not lift after using it', 'Very fast or irregular heartbeat'],
        },
    },

    // ── Supplements that behave like drugs ────────────────────────────────────────────
    potassium: {
        plainName: 'Potassium supplement',
        brandNames: ['Sando-K', 'Slow-K'],
        classes: ['potassium_supplement', 'potassium_raising', 'supplement'],
        treats: 'Low potassium',
        whatItIs: 'A potassium supplement, usually given when a water tablet has washed too much out.',
        whyItMatters: 'Too much potassium is as dangerous as too little, and several common blood pressure medicines already raise it.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature.',
        sideEffects: {
            minor: ['Feeling sick', 'Stomach discomfort'],
            serious: ['Muscle weakness', 'Numbness or tingling', 'Slow or irregular heartbeat'],
        },
    },
    calcium: {
        plainName: 'Calcium supplement',
        brandNames: ['Calcichew', 'Adcal'],
        classes: ['mineral_supplement', 'polyvalent_cation', 'supplement'],
        treats: 'Low calcium and bone protection',
        whatItIs: 'A calcium supplement, often combined with vitamin D.',
        whyItMatters: 'It binds to several medicines in the stomach and stops them being absorbed, so timing matters more than the dose.',
        form: 'tablet',
        prescriptionOnly: false,
        storage: 'Room temperature.',
        sideEffects: {
            minor: ['Constipation', 'Wind', 'Bloating'],
            serious: ['Severe constipation', 'Confusion', 'Bone pain with unusual thirst'],
        },
    },
    ferrous_sulfate: {
        plainName: 'Iron supplement',
        brandNames: ['Ferrograd', 'Feosol'],
        classes: ['iron_supplement', 'polyvalent_cation', 'supplement'],
        treats: 'Iron deficiency',
        whatItIs: 'An iron tablet, used to rebuild iron stores.',
        whyItMatters: 'Like calcium, it binds other medicines in the stomach — separating them by a few hours solves it.',
        form: 'tablet',
        prescriptionOnly: false,
        storage: 'Room temperature, well out of reach of children — an iron overdose in a small child is a medical emergency.',
        sideEffects: {
            minor: ['Constipation or loose stools', 'Black stools, which is expected', 'Stomach discomfort'],
            serious: ['Severe stomach pain', 'Vomiting blood', 'Any amount swallowed by a child'],
        },
    },
    sildenafil: {
        plainName: 'Erectile dysfunction tablet',
        brandNames: ['Viagra', 'Revatio'],
        classes: ['pde5_inhibitor'],
        treats: 'Erectile dysfunction, and in another form, lung blood pressure',
        whatItIs: 'Sildenafil relaxes blood vessels to improve blood flow.',
        whyItMatters: 'Combined with a nitrate heart medicine it can drop blood pressure to a dangerous level.',
        form: 'tablet',
        prescriptionOnly: true,
        storage: 'Room temperature.',
        sideEffects: {
            minor: ['Headache', 'Flushing', 'Blocked nose', 'Indigestion'],
            serious: ['An erection lasting more than four hours', 'Sudden loss of vision or hearing', 'Chest pain during sex'],
        },
    },
};

// ── Name resolution ──────────────────────────────────────────────────────────────────

/** Normalise for lookup: lowercase, strip anything that is not a letter or a digit. */
const slug = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Brand and alternate spellings → catalogue key. Built once at load. */
const ALIASES = (() => {
    const map = {};
    for (const [key, drug] of Object.entries(DRUGS)) {
        map[key] = key;
        map[slug(key)] = key;
        for (const brand of drug.brandNames || []) map[slug(brand)] = key;
    }
    // Spellings and forms real labels use that are not brand names
    Object.assign(map, {
        acetaminophen: 'paracetamol',
        albuterol: 'salbutamol',
        prednisone: 'prednisolone',
        frusemide: 'furosemide',
        ferrous_fumarate: 'ferrous_sulfate',
        ferrous_gluconate: 'ferrous_sulfate',
        iron: 'ferrous_sulfate',
        calcium_carbonate: 'calcium',
        potassium_chloride: 'potassium',
        asa: 'aspirin',
        acetylsalicylic_acid: 'aspirin',
        co_codamol: 'codeine',
        levothyroxine_sodium: 'levothyroxine',
        isosorbide: 'isosorbide_mononitrate',
    });
    return map;
})();

/**
 * Look up a drug by any name a label or a person might use.
 * @returns {{key:string, drug:object}|null} null when the catalogue does not know it
 */
const lookup = (name) => {
    const key = ALIASES[slug(name)];
    return key ? { key, drug: DRUGS[key] } : null;
};

/**
 * The classes the rules match on, for one drug name.
 * Returns an empty array for an unknown drug — which is why every caller has to
 * distinguish "no classes" from "no interactions". They are not the same claim.
 */
const classesFor = (name) => lookup(name)?.drug.classes || [];

/** The patient-facing entry, or null. The client falls back to the drug's own name. */
const explain = (name) => {
    const hit = lookup(name);
    if (!hit) return null;
    const { key, drug } = hit;
    return {
        key,
        plainName: drug.plainName,
        brandNames: drug.brandNames || [],
        treats: drug.treats,
        whatItIs: drug.whatItIs,
        whyItMatters: drug.whyItMatters,
        form: drug.form,
        prescriptionOnly: drug.prescriptionOnly,
        storage: drug.storage,
        sideEffects: drug.sideEffects,
        classes: drug.classes,
    };
};

// ── Interaction rules ────────────────────────────────────────────────────────────────

/**
 * Drug-to-drug rules.
 *
 * `between` is a pair of class lists: the rule fires when one medication carries any class
 * from the first list and a DIFFERENT medication carries any from the second. Matching on
 * class rather than on name is what keeps this table to a readable size — "any NSAID with
 * any anticoagulant" is one rule, not the forty name pairs it expands to.
 *
 * `effect` says what could happen, in the second person. `action` says what to do, and is
 * always something the person can actually act on today.
 */
const INTERACTIONS = [
    {
        id: 'anticoagulant-nsaid',
        between: [['anticoagulant'], ['nsaid']],
        severity: 'severe',
        effect: 'Both of these make bleeding more likely, and together the risk is much higher than either alone — most often as bleeding in the stomach or gut, which can happen without warning.',
        action: 'Do not take an anti-inflammatory painkiller alongside a blood thinner unless your doctor has specifically told you to. Paracetamol is the usual alternative for pain. Speak to your pharmacist before your next dose.',
    },
    {
        id: 'anticoagulant-antiplatelet',
        between: [['anticoagulant'], ['antiplatelet']],
        severity: 'severe',
        effect: 'Two medicines that both reduce clotting, working in different ways. Some people are prescribed both deliberately after a stent or a heart attack, but the combination markedly raises bleeding risk.',
        action: 'Check with your doctor that both are meant to be taken together. If nobody has told you they are, treat this as urgent and ask today.',
    },
    {
        id: 'warfarin-antibiotic',
        between: [['warfarin'], ['macrolide', 'nitroimidazole', 'fluoroquinolone', 'trimethoprim']],
        severity: 'severe',
        effect: 'This antibiotic makes warfarin act more strongly, so your blood thins further than intended — sometimes several days into the course.',
        action: 'Tell whoever prescribed the antibiotic that you take warfarin. You will usually need your clotting checked during the course rather than at your normal interval.',
    },
    {
        id: 'statin-macrolide',
        between: [['statin'], ['macrolide']],
        severity: 'severe',
        effect: 'This antibiotic stops your liver clearing the statin, so it builds up. The risk is serious muscle breakdown, which can damage the kidneys.',
        action: 'Ask your prescriber — statins are often paused for the few days of the antibiotic course. Report any severe muscle pain, weakness, or dark urine straight away.',
    },
    {
        id: 'statin-amiodarone',
        between: [['statin'], ['amiodarone']],
        severity: 'moderate',
        effect: 'Amiodarone slows the clearance of some statins, raising the level in your blood and with it the risk of muscle damage.',
        action: 'This combination is used, but usually with a dose cap on the statin. Check the dose is right for someone taking amiodarone, and report muscle pain.',
    },
    {
        id: 'ace-potassium',
        between: [['ace_inhibitor', 'arb'], ['potassium_raising']],
        severity: 'severe',
        effect: 'Both raise the potassium in your blood. Too much potassium interferes with the heart\'s rhythm, and it usually causes no symptoms until it is already dangerous.',
        action: 'This pairing is sometimes intended, but it needs blood tests to stay safe. Confirm with your doctor that your potassium is being monitored.',
    },
    {
        id: 'ace-nsaid',
        between: [['ace_inhibitor', 'arb'], ['nsaid']],
        severity: 'moderate',
        effect: 'Anti-inflammatory painkillers work against blood pressure medicines and put the kidneys under strain, particularly if you are also on a water tablet or become dehydrated.',
        action: 'Use paracetamol for everyday pain instead where you can. If you need an anti-inflammatory regularly, ask your doctor to check your kidney function.',
    },
    {
        id: 'triple-whammy',
        between: [['diuretic'], ['nsaid']],
        severity: 'moderate',
        effect: 'A water tablet and an anti-inflammatory together reduce blood flow through the kidneys. With a blood pressure medicine as the third, this is a well-known cause of sudden kidney injury.',
        action: 'Avoid anti-inflammatory painkillers while on a water tablet where you can, and stop them if you become unwell with vomiting or diarrhoea. Ask your pharmacist what to use instead.',
    },
    {
        id: 'ssri-nsaid',
        between: [['ssri'], ['nsaid']],
        severity: 'moderate',
        effect: 'SSRIs reduce how well platelets stick together, and anti-inflammatories irritate the stomach lining. Together they raise the chance of bleeding from the stomach.',
        action: 'Mention it to your doctor — a stomach-protecting medicine is often added when both are needed. Report black or tarry stools immediately.',
    },
    {
        id: 'serotonin-syndrome',
        between: [['ssri'], ['serotonergic', 'triptan']],
        severity: 'severe',
        effect: 'Two medicines that both raise serotonin can push it too high. That causes agitation, shivering, sweating, a racing heart and muscle twitching, and it can come on within hours.',
        action: 'Do not start the second one without asking your prescriber. If you already take both and feel agitated, shivery and hot with a fast heartbeat, seek urgent medical help.',
    },
    {
        id: 'lithium-nsaid',
        between: [['lithium'], ['nsaid']],
        severity: 'severe',
        effect: 'Anti-inflammatory painkillers stop the kidneys clearing lithium, so its level rises into the toxic range.',
        action: 'Avoid anti-inflammatories entirely while on lithium unless your prescriber has arranged monitoring. Coarse shaking, slurred speech or persistent vomiting need urgent attention.',
    },
    {
        id: 'lithium-diuretic',
        between: [['lithium'], ['diuretic', 'ace_inhibitor', 'arb']],
        severity: 'severe',
        effect: 'These reduce how much lithium your kidneys remove, which lets it build up to a toxic level.',
        action: 'Confirm your lithium level is being monitored. Get urgent help for coarse shaking, unsteadiness, slurred speech, or vomiting that will not stop.',
    },
    {
        id: 'digoxin-diuretic',
        between: [['digoxin'], ['loop_diuretic']],
        severity: 'severe',
        effect: 'Water tablets lower potassium, and low potassium makes the heart far more sensitive to digoxin — so digoxin can become toxic at a dose that was previously fine.',
        action: 'Make sure your potassium is checked. Seeing yellow-green halos, feeling confused, or repeated vomiting are signs of digoxin toxicity and need same-day advice.',
    },
    {
        id: 'digoxin-amiodarone',
        between: [['digoxin'], ['amiodarone']],
        severity: 'severe',
        effect: 'Amiodarone roughly doubles the digoxin level in the blood.',
        action: 'The digoxin dose is normally halved when amiodarone is started. Check with your prescriber that this was done.',
    },
    {
        id: 'nitrate-pde5',
        between: [['nitrate'], ['pde5_inhibitor']],
        severity: 'severe',
        effect: 'Both widen blood vessels. Together they can drop your blood pressure suddenly and far enough to cause collapse.',
        action: 'Never take an erectile dysfunction tablet if you take nitrates for angina, including a spray or patch used only when needed. Ask your doctor about alternatives.',
    },
    {
        id: 'opioid-cns',
        between: [['opioid'], ['benzodiazepine', 'cns_depressant']],
        severity: 'severe',
        effect: 'Both slow your breathing, and the effect is more than the sum of the two. This combination is the most common cause of accidental overdose.',
        action: 'Only take both if a prescriber has knowingly decided you should. Anyone you live with should know to call an ambulance if you are very hard to wake or breathing slowly.',
    },
    {
        id: 'methotrexate-nsaid',
        between: [['methotrexate'], ['nsaid']],
        severity: 'severe',
        effect: 'Anti-inflammatory painkillers slow the removal of methotrexate, letting it build up and damage the bone marrow.',
        action: 'Do not take over-the-counter anti-inflammatories with methotrexate without your specialist\'s agreement. A sore throat, fever, or unusual bruising needs an urgent blood count.',
    },
    {
        id: 'methotrexate-trimethoprim',
        between: [['methotrexate'], ['folate_antagonist']],
        severity: 'severe',
        effect: 'Both work against folate. Together they can cause a severe drop in blood cells.',
        action: 'This pairing is generally avoided. Contact your prescriber before taking the antibiotic, and get an urgent blood test if you develop a fever, mouth ulcers, or bruising.',
    },
    {
        id: 'levothyroxine-binder',
        between: [['thyroid_hormone'], ['polyvalent_cation']],
        severity: 'moderate',
        effect: 'Calcium and iron bind levothyroxine in the stomach, so much less of it is absorbed and your thyroid treatment quietly stops working properly.',
        action: 'Keep them at least four hours apart — levothyroxine first thing on an empty stomach, the supplement later in the day. Nothing needs to stop.',
    },
    {
        id: 'levothyroxine-ppi',
        between: [['thyroid_hormone'], ['ppi']],
        severity: 'mild',
        effect: 'Reduced stomach acid can lower how much levothyroxine you absorb, so your dose may not go as far as it did.',
        action: 'No change is needed on your own, but mention it if your thyroid blood test drifts — the dose may need reviewing.',
    },
    {
        id: 'clopidogrel-ppi',
        between: [['antiplatelet'], ['enzyme_inhibitor']],
        severity: 'moderate',
        effect: 'Clopidogrel has to be switched on by a liver enzyme, and omeprazole blocks that enzyme — so the clopidogrel may protect you less well.',
        action: 'Ask your pharmacist about a different stomach medicine. Lansoprazole and famotidine are usually suggested instead.',
    },
    {
        id: 'quinolone-binder',
        between: [['fluoroquinolone'], ['polyvalent_cation']],
        severity: 'moderate',
        effect: 'Calcium, iron and indigestion remedies bind this antibiotic in the stomach and can stop enough of it being absorbed to treat the infection.',
        action: 'Take the antibiotic two hours before, or six hours after, the supplement. Do not take them together.',
    },
    {
        id: 'qt-prolonging-pair',
        between: [['qt_prolonging'], ['qt_prolonging']],
        severity: 'moderate',
        effect: 'Both of these can stretch the heart\'s electrical recovery time. Together that raises the chance of a dangerous rhythm, particularly if your potassium is low.',
        action: 'Mention the combination to your prescriber — it is often fine, but sometimes needs an ECG. Report fainting or palpitations promptly.',
    },
    {
        id: 'sulfonylurea-beta-blocker',
        between: [['hypoglycaemic'], ['beta_blocker']],
        severity: 'moderate',
        effect: 'Beta blockers hide the racing heart and shakiness that normally warn you your blood sugar is dropping, so a hypo can reach a dangerous level before you notice it.',
        action: 'Test your blood sugar more often rather than relying on how you feel, particularly when starting the beta blocker. Sweating usually still occurs and is worth heeding.',
    },
    {
        id: 'corticosteroid-nsaid',
        between: [['corticosteroid'], ['nsaid']],
        severity: 'moderate',
        effect: 'Both irritate the stomach lining, and together they clearly raise the chance of a stomach ulcer or a bleed.',
        action: 'Ask whether you need a stomach-protecting medicine while you are on both. Black or tarry stools need same-day attention.',
    },
];

/**
 * Drug-to-food and drug-to-drink rules.
 *
 * The design surfaces these on the medication detail screen — grapefruit juice marked
 * "Strong", alcohol marked "Weak" — so they are first-class here rather than prose buried
 * in the drug entry.
 */
const FOOD_INTERACTIONS = [
    {
        id: 'statin-grapefruit',
        classes: ['statin'],
        // Rosuvastatin is not affected; excluded by name rather than by inventing a class
        excludeDrugs: ['rosuvastatin'],
        substance: 'Grapefruit and grapefruit juice',
        severity: 'moderate',
        effect: 'Grapefruit blocks the enzyme that clears this statin, so more of it stays in your blood. That raises the risk of muscle pain and, rarely, of serious muscle damage.',
        action: 'Avoid grapefruit and grapefruit juice while taking it. Other citrus fruits are fine.',
    },
    {
        id: 'warfarin-vitamink',
        classes: ['warfarin'],
        substance: 'Leafy greens and vitamin K',
        severity: 'moderate',
        effect: 'Vitamin K works against warfarin. Big swings in how much you eat — a sudden health kick of kale and spinach, or stopping one — move your clotting level.',
        action: 'You do not need to avoid greens. Keep the amount roughly steady from week to week, and tell your clinic if your diet changes a lot.',
    },
    {
        id: 'warfarin-alcohol',
        classes: ['warfarin'],
        substance: 'Alcohol',
        severity: 'moderate',
        effect: 'Binge drinking raises your clotting level sharply and adds its own bleeding risk. Steady, regular drinking can push it the other way.',
        action: 'Keep alcohol light and even rather than saved up for the weekend. Discuss what is reasonable for you at your clotting clinic.',
    },
    {
        id: 'metronidazole-alcohol',
        classes: ['nitroimidazole'],
        substance: 'Alcohol',
        severity: 'severe',
        effect: 'Alcohol with this antibiotic causes a sudden reaction — flushing, violent nausea, vomiting, a pounding headache and a racing heart.',
        action: 'No alcohol during the course, and for 48 hours after the last dose. That includes what is in some mouthwashes and cough remedies.',
    },
    {
        id: 'cns-alcohol',
        classes: ['opioid', 'benzodiazepine', 'cns_depressant'],
        substance: 'Alcohol',
        severity: 'severe',
        effect: 'Alcohol adds to the way this medicine slows your breathing and dulls your alertness. Together they can stop your breathing while you sleep.',
        action: 'Do not drink while taking it. If you have been drinking, do not take an extra dose to make up for a missed one.',
    },
    {
        id: 'hypoglycaemic-alcohol',
        classes: ['hypoglycaemic'],
        substance: 'Alcohol',
        severity: 'moderate',
        effect: 'Alcohol stops your liver releasing stored sugar, so a hypo can arrive hours later — often overnight — and be mistaken for being drunk.',
        action: 'Eat carbohydrate when you drink, test before bed, and make sure someone with you knows you take diabetes medication.',
    },
    {
        id: 'levothyroxine-food',
        classes: ['thyroid_hormone'],
        substance: 'Food, coffee and soya',
        severity: 'moderate',
        effect: 'Food — coffee and soya especially — cuts how much levothyroxine you absorb, which can leave a correct dose working like a smaller one.',
        action: 'Take it with water at least 30 minutes before breakfast or coffee, at the same time each day.',
    },
    {
        id: 'quinolone-dairy',
        classes: ['fluoroquinolone'],
        substance: 'Milk and dairy',
        severity: 'moderate',
        effect: 'The calcium in dairy binds this antibiotic in the stomach so that much less of it reaches the infection.',
        action: 'Leave two hours between the tablet and any milk, yoghurt or cheese.',
    },
    {
        id: 'ppi-none',
        classes: ['ace_inhibitor', 'arb'],
        substance: 'Salt substitutes',
        severity: 'moderate',
        effect: 'Low-sodium salt substitutes are mostly potassium chloride, and this medicine already raises your potassium.',
        action: 'Use ordinary salt sparingly rather than a potassium-based substitute, and mention it if you already use one.',
    },
];

/**
 * Drug-to-condition rules, matched against `User.healthAssessment.conditions`.
 *
 * `match` is tested against the lowercased condition name. Kept deliberately narrow: a
 * loose pattern here produces a warning on a condition the person does not have, and a
 * false alarm on a medicines screen teaches people to dismiss the real ones.
 */
const CONDITION_INTERACTIONS = [
    {
        id: 'nsaid-ulcer',
        classes: ['nsaid'],
        match: /\b(ulcer|gastritis|gi bleed|stomach bleed|reflux disease)\b/,
        severity: 'severe',
        effect: 'Anti-inflammatory painkillers irritate the stomach lining, and you have a condition that already makes bleeding there more likely.',
        action: 'Use paracetamol instead where you can. If you need an anti-inflammatory, ask about a stomach-protecting medicine alongside it.',
    },
    {
        id: 'nsaid-kidney',
        classes: ['nsaid'],
        match: /\b(kidney disease|renal|ckd|kidney failure)\b/,
        severity: 'severe',
        effect: 'Anti-inflammatories reduce blood flow through the kidneys, which matters more when kidney function is already reduced.',
        action: 'Check with your doctor before taking these at all, including ones bought over the counter.',
    },
    {
        id: 'nsaid-heart-failure',
        classes: ['nsaid'],
        match: /\b(heart failure|cardiac failure)\b/,
        severity: 'moderate',
        effect: 'Anti-inflammatories make the body hold on to fluid, which can worsen heart failure.',
        action: 'Avoid them where possible, and report new breathlessness or swollen ankles.',
    },
    {
        id: 'beta-blocker-asthma',
        classes: ['beta_blocker'],
        match: /\b(asthma|copd|bronchospasm)\b/,
        severity: 'severe',
        effect: 'Beta blockers can tighten the airways, which is a particular problem in asthma.',
        action: 'Make sure your prescriber knows you have this. Some beta blockers are safer than others, but the choice is theirs to make. Report any new wheeze.',
    },
    {
        id: 'metformin-kidney',
        classes: ['biguanide'],
        match: /\b(kidney disease|renal|ckd|kidney failure)\b/,
        severity: 'severe',
        effect: 'Metformin is cleared by the kidneys. When they are not working well it can build up and cause a rare but serious acid build-up in the blood.',
        action: 'Your kidney function should be checked regularly, and metformin paused if you become dehydrated. Confirm the plan with your doctor.',
    },
    {
        id: 'steroid-diabetes',
        classes: ['corticosteroid'],
        match: /\b(diabetes|diabetic)\b/,
        severity: 'moderate',
        effect: 'Steroids raise blood sugar, sometimes a great deal, for as long as the course lasts.',
        action: 'Test more often while you are on it. Your diabetes medication may need adjusting during the course and back again afterwards.',
    },
    {
        id: 'ssri-bleeding',
        classes: ['ssri'],
        match: /\b(ulcer|gi bleed|stomach bleed|bleeding disorder)\b/,
        severity: 'moderate',
        effect: 'SSRIs make platelets less sticky, which adds to an existing tendency to bleed.',
        action: 'Mention it to your prescriber — it does not usually mean stopping, but it may mean adding stomach protection.',
    },
];

// ── Running the rules ────────────────────────────────────────────────────────────────

/** Does this medication carry any of these classes? */
const hasAny = (classes, wanted) => wanted.some((c) => classes.includes(c));

/**
 * Run every deterministic rule over a list of medications.
 *
 * @param {{name:string, _id?:any}[]} medications  what the person takes
 * @param {string[]} [conditions]                  condition names from the health assessment
 * @returns {{findings:object[], uncheckable:string[], checkedCount:number}}
 *
 * `uncheckable` names the medications the catalogue could not classify. It is not a
 * footnote: those drugs were not tested against anything, and a caller that renders the
 * findings without it is telling the person something the check did not establish.
 */
const runRules = (medications = [], conditions = []) => {
    const resolved = medications
        .filter((m) => m && m.name)
        .map((m) => ({
            name: m.name,
            id: m._id ? String(m._id) : undefined,
            hit: lookup(m.name),
        }));

    const known = resolved.filter((r) => r.hit);
    const uncheckable = resolved.filter((r) => !r.hit).map((r) => r.name);

    const findings = [];

    // Drug ↔ drug. Each unordered pair once.
    for (let i = 0; i < known.length; i++) {
        for (let j = i + 1; j < known.length; j++) {
            const a = known[i];
            const b = known[j];

            // The same drug entered twice is a duplicate, not an interaction — but it is
            // worth saying, because double-dosing under a brand name and a generic name is
            // a real and common way people come to harm.
            if (a.hit.key === b.hit.key) {
                findings.push({
                    id: 'duplicate',
                    kind: 'duplicate',
                    severity: 'moderate',
                    source: 'rule',
                    between: [a.name, b.name],
                    effect: `"${a.name}" and "${b.name}" are the same medicine under different names, so taking both means taking a double dose.`,
                    action: 'Check the boxes and speak to your pharmacist before your next dose. Two names for one medicine is one of the commonest ways people take too much by accident.',
                });
                continue;
            }

            const ca = a.hit.drug.classes;
            const cb = b.hit.drug.classes;

            for (const rule of INTERACTIONS) {
                const [left, right] = rule.between;
                const forward = hasAny(ca, left) && hasAny(cb, right);
                const backward = hasAny(cb, left) && hasAny(ca, right);
                if (!forward && !backward) continue;

                findings.push({
                    id: rule.id,
                    kind: 'drug',
                    severity: rule.severity,
                    source: 'rule',
                    between: forward ? [a.name, b.name] : [b.name, a.name],
                    effect: rule.effect,
                    action: rule.action,
                });
            }
        }
    }

    // Drug ↔ food
    for (const r of known) {
        for (const rule of FOOD_INTERACTIONS) {
            if (rule.excludeDrugs?.includes(r.hit.key)) continue;
            if (!hasAny(r.hit.drug.classes, rule.classes)) continue;
            findings.push({
                id: rule.id,
                kind: 'food',
                severity: rule.severity,
                source: 'rule',
                between: [r.name, rule.substance],
                effect: rule.effect,
                action: rule.action,
            });
        }
    }

    // Drug ↔ condition
    const conditionNames = conditions.filter(Boolean).map((c) => String(c).toLowerCase());
    for (const r of known) {
        for (const rule of CONDITION_INTERACTIONS) {
            if (!hasAny(r.hit.drug.classes, rule.classes)) continue;
            const matched = conditionNames.find((c) => rule.match.test(c));
            if (!matched) continue;
            findings.push({
                id: rule.id,
                kind: 'condition',
                severity: rule.severity,
                source: 'rule',
                between: [r.name, matched],
                effect: rule.effect,
                action: rule.action,
            });
        }
    }

    return { findings: dedupe(findings), uncheckable, checkedCount: known.length };
};

/**
 * Collapse findings that say the same thing about the same pair.
 *
 * Two rules can both fire on one pair — a diuretic that is also potassium-raising trips
 * both `ace-potassium` and `triple-whammy`. Showing the person the same warning twice makes
 * the screen look broken and buries the findings that are distinct.
 */
const dedupe = (findings) => {
    const seen = new Map();
    for (const f of findings) {
        const key = `${f.id}::${[...f.between].sort().join('|')}`;
        const existing = seen.get(key);
        if (!existing || atLeastAsSevere(f.severity, existing.severity)) seen.set(key, f);
    }
    return [...seen.values()].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
};

/** Highest severity present, or null when nothing fired. Never "safe" — see SAFETY_FOOTER. */
const worstSeverity = (findings = []) =>
    findings.reduce((worst, f) => (worst === null || atLeastAsSevere(f.severity, worst) ? f.severity : worst), null);

/**
 * Every class the rules can act on, as a flat sorted list.
 * Passed to the model so it classifies unknown drugs into a vocabulary the table shares,
 * rather than inventing class names nothing matches.
 */
const KNOWN_CLASSES = [...new Set([
    ...Object.values(DRUGS).flatMap((d) => d.classes),
    ...INTERACTIONS.flatMap((r) => r.between.flat()),
    ...FOOD_INTERACTIONS.flatMap((r) => r.classes),
    ...CONDITION_INTERACTIONS.flatMap((r) => r.classes),
])].sort();

/** Every catalogue key, for the search screen's A–Z and "most common" lists. */
const catalogueList = () =>
    Object.entries(DRUGS)
        .map(([key, d]) => ({
            key,
            name: key.replace(/_/g, ' '),
            plainName: d.plainName,
            brandNames: d.brandNames || [],
            treats: d.treats,
            form: d.form,
            classes: d.classes,
            prescriptionOnly: d.prescriptionOnly,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

/**
 * Substring search over names, brand names and what the drug treats.
 * Bidirectional substring matching, the same convention product and professional matching
 * already use elsewhere in this codebase.
 */
const search = (query, limit = 25) => {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return catalogueList().slice(0, limit);

    return catalogueList()
        .map((entry) => {
            const name = entry.name.toLowerCase();
            const brands = entry.brandNames.map((b) => b.toLowerCase());
            let score = null;
            if (name === q || brands.includes(q)) score = 0;
            else if (name.startsWith(q) || brands.some((b) => b.startsWith(q))) score = 1;
            else if (name.includes(q) || brands.some((b) => b.includes(q))) score = 2;
            else if ((entry.treats || '').toLowerCase().includes(q)) score = 3;
            else if ((entry.plainName || '').toLowerCase().includes(q)) score = 4;
            return score === null ? null : { entry, score };
        })
        .filter(Boolean)
        .sort((a, b) => a.score - b.score || a.entry.name.localeCompare(b.entry.name))
        .slice(0, limit)
        .map((r) => r.entry);
};

module.exports = {
    DRUGS,
    INTERACTIONS,
    FOOD_INTERACTIONS,
    CONDITION_INTERACTIONS,
    KNOWN_CLASSES,
    SEVERITY,
    SAFETY_FOOTER,
    lookup,
    slug,
    explain,
    classesFor,
    runRules,
    worstSeverity,
    severityRank,
    atLeastAsSevere,
    catalogueList,
    search,
};
