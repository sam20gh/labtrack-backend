/**
 * Plain-language explanations for every analyte in the catalogue.
 *
 * The app is for the public. "MCV 88 fL — normal" tells a non-clinician nothing at all;
 * they cannot tell whether MCV is a hormone, an organ, or a disease, and a result they
 * cannot read is a result they cannot act on. Every biomarker the app shows therefore
 * carries a lay title and two or three sentences of explanation.
 *
 * Lives on the server rather than in the app bundle for one reason: this is clinical copy.
 * A description that turns out to be misleading has to be correctable the same day, not on
 * the next app-store release cycle. The client renders whatever it is given and degrades to
 * the medical name alone when an entry is missing.
 *
 * ── Rules for writing an entry ────────────────────────────────────────────────────────
 *
 * 1. `plainName` is a *label*, not a definition: two or three words that could sit under
 *    the medical name in a list. "Iron stores", not "A protein that stores iron".
 * 2. `whatItIs` explains the substance. `whyItMatters` explains why anyone measures it.
 *    One sentence each, no semicolons, no Latin.
 * 3. `high` and `low` say what an out-of-range value *can* point to, always hedged and
 *    always plural in possibility. These are read by worried people at midnight: they must
 *    never read as a diagnosis, and they must never read as reassurance either. Where a
 *    direction is genuinely not meaningful on its own, say so rather than inventing a
 *    cause.
 * 4. No numbers. Ranges are personal (sex, age, and gene-adjusted per `ReferenceRange`),
 *    and a hardcoded threshold here would contradict the band the user is actually shown.
 * 5. Non-directional analytes still get both keys — omitting one produces a UI with a
 *    dangling half-explanation.
 *
 * Keys are the canonical names from `unitNormaliser.BIOMARKERS`. `auditGlossary()` reports
 * drift in both directions, and `__tests__/biomarkerGlossary.test.js` fails the build on it —
 * an analyte the app can flag but cannot explain is the exact defect this module removes.
 */

/**
 * Every entry is patient-facing text. Nothing here is a diagnosis, and the wording is
 * deliberately "can mean" rather than "means".
 */
const GLOSSARY = {
    // ── Iron ──────────────────────────────────────────────────────────────────────────
    ferritin: {
        plainName: 'Iron stores',
        whatItIs: 'Ferritin is the protein your body keeps its spare iron in, so it shows how much iron you have banked rather than how much is in your blood right now.',
        whyItMatters: 'It is the earliest sign that iron is running down — stores empty long before the blood count itself looks abnormal.',
        low: 'Low ferritin usually means your iron stores are running out, which often shows up as tiredness, breathlessness on stairs, or looking pale. Common causes are diet, heavy periods, pregnancy, or slow blood loss somewhere.',
        high: 'High ferritin can mean too much stored iron, but it also rises with any inflammation, infection, liver strain, or heavy alcohol use — so it is usually interpreted alongside your other results rather than on its own.',
    },
    iron: {
        plainName: 'Iron in your blood',
        whatItIs: 'This is the iron circulating in your blood at the moment the sample was taken, as opposed to the reserves measured by ferritin.',
        whyItMatters: 'Iron is what lets your red blood cells carry oxygen around your body, so too little leaves you tired and short of breath.',
        low: 'Low iron can point to not absorbing or eating enough, or to losing blood somewhere. It is read together with ferritin, because stores can be empty while a single blood reading still looks acceptable.',
        high: 'High iron can follow a supplement or an iron-rich meal shortly before the test, and less often reflects a condition that makes the body absorb too much.',
    },

    // ── Red cells and the blood count ─────────────────────────────────────────────────
    haemoglobin: {
        plainName: 'Oxygen-carrying protein',
        whatItIs: 'Haemoglobin is the protein inside red blood cells that picks up oxygen in your lungs and delivers it to the rest of your body.',
        whyItMatters: 'It is the single most useful measure of whether your blood is doing its main job, and it is how anaemia is identified.',
        low: 'Low haemoglobin is what anaemia means. It commonly causes fatigue, breathlessness, and pale skin, and the usual causes are low iron, low B12 or folate, blood loss, or a long-term illness.',
        high: 'High haemoglobin can simply mean you were dehydrated when the blood was taken. Persistently high readings are followed up because they can relate to smoking, living at altitude, low blood oxygen, or the bone marrow producing too many cells.',
    },
    rbc: {
        plainName: 'Red blood cell count',
        whatItIs: 'The number of red blood cells in a set volume of blood — the cells themselves, rather than the haemoglobin they carry.',
        whyItMatters: 'Together with haemoglobin and cell size it separates the different causes of anaemia from one another.',
        low: 'A low count means fewer cells available to carry oxygen, which can come from blood loss, a nutrient shortage, or reduced production in the bone marrow.',
        high: 'A high count is often dehydration. When it persists it is investigated alongside haemoglobin, since the two usually move together.',
    },
    haematocrit: {
        plainName: 'Share of blood that is red cells',
        whatItIs: 'The percentage of your blood volume made up of red blood cells, with the rest being liquid plasma.',
        whyItMatters: 'It is a quick check on how thick or dilute your blood is, and it tracks closely with haemoglobin.',
        low: 'A low share generally accompanies anaemia, or means the blood is diluted — during pregnancy, for instance.',
        high: 'A high share most often reflects dehydration, which concentrates the blood. Repeated high readings are looked into further.',
    },
    mcv: {
        plainName: 'Average red blood cell size',
        whatItIs: 'MCV stands for mean corpuscular volume, which is simply the average size of your red blood cells.',
        whyItMatters: 'Cell size is the clue that tells you *why* someone is anaemic, because different causes make cells too small or too large in a characteristic way.',
        low: 'Smaller than usual cells point towards iron deficiency, or towards an inherited difference in how your body builds haemoglobin.',
        high: 'Larger than usual cells point towards a shortage of vitamin B12 or folate, and can also follow regular alcohol use or an underactive thyroid.',
    },
    wbc: {
        plainName: 'Infection-fighting cells',
        whatItIs: 'White blood cells are your immune system in the bloodstream, and this is a count of how many are circulating.',
        whyItMatters: 'The count rises and falls with infection, inflammation, and stress on the body, so it is a broad signal that something is or is not going on.',
        low: 'A low count can leave you more prone to infection. It can follow a recent viral illness, certain medicines, or a problem with how the bone marrow is producing cells.',
        high: 'A high count usually means your body is fighting an infection or dealing with inflammation. It also rises with physical stress, smoking, and steroid medicines.',
    },
    platelets: {
        plainName: 'Clotting cells',
        whatItIs: 'Platelets are the small cell fragments that clump together to plug a wound and stop bleeding.',
        whyItMatters: 'Too few and you bruise or bleed easily, too many and blood can clot when it should not.',
        low: 'A low count can mean easier bruising and bleeding, and can follow certain infections, medicines, liver problems, or an immune reaction against your own platelets.',
        high: 'A high count is often a temporary reaction to infection, inflammation, or low iron, and less commonly reflects the bone marrow making too many.',
    },

    // ── Cholesterol and blood fats ────────────────────────────────────────────────────
    total_cholesterol: {
        plainName: 'Total cholesterol',
        whatItIs: 'The combined amount of all the cholesterol in your blood, both the kind that harms arteries and the kind that protects them.',
        whyItMatters: 'It is a starting point for heart and stroke risk, though the split between the good and bad kinds below matters more than this single number.',
        low: 'A low total is not usually a concern in itself, and is occasionally seen with an overactive thyroid, liver conditions, or poor nutrition.',
        high: 'A high total means more cholesterol available to build up in artery walls over the years, which raises the long-term risk of heart attack and stroke.',
    },
    ldl_cholesterol: {
        plainName: 'The harmful cholesterol',
        whatItIs: 'LDL carries cholesterol out to your body, and any it leaves behind can build up inside the walls of your arteries.',
        whyItMatters: 'Of all the cholesterol numbers, this is the one most directly tied to furring up of the arteries, and the one treatment aims at.',
        low: 'A low LDL is generally a good thing for your arteries and is the target of cholesterol treatment.',
        high: 'A high LDL means more cholesterol being deposited in artery walls, quietly and without symptoms, raising the risk of heart attack and stroke over years. Diet, exercise, and medication all lower it.',
    },
    hdl_cholesterol: {
        plainName: 'The protective cholesterol',
        whatItIs: 'HDL collects excess cholesterol from around your body and carries it back to the liver to be removed.',
        whyItMatters: 'It is the one cholesterol measure where higher is better, because it works against the build-up that LDL causes.',
        low: 'A low HDL means less of this clearing-up activity, and is linked to a higher risk of heart disease. Regular exercise and stopping smoking are the things that raise it most.',
        high: 'A high HDL is generally favourable, and usually goes with regular physical activity.',
    },
    triglycerides: {
        plainName: 'Blood fats',
        whatItIs: 'Triglycerides are the main form of fat in your blood, and they come both from the food you eat and from what your body makes out of spare calories.',
        whyItMatters: 'They are strongly influenced by what you eat and drink, so they respond faster to changes in habits than cholesterol does.',
        low: 'A low level is not generally a concern.',
        high: 'A high level is linked to heart disease and, when very high, to inflammation of the pancreas. The usual drivers are alcohol, sugary food and drink, being overweight, and poorly controlled diabetes. Note that eating shortly before the test raises it.',
    },

    // ── Blood sugar ───────────────────────────────────────────────────────────────────
    hba1c: {
        plainName: 'Average blood sugar',
        whatItIs: 'HbA1c measures how much sugar has stuck to your red blood cells, which reflects your average blood sugar over roughly the last two to three months.',
        whyItMatters: 'Unlike a single glucose reading it cannot be gamed by skipping breakfast, so it is what diabetes is diagnosed and monitored with.',
        low: 'A low result is uncommon and can occur with anaemia or after recent blood loss, because it depends on the lifespan of your red blood cells.',
        high: 'A raised result means your average blood sugar has been running high, which is how prediabetes and diabetes are identified. Sustained high sugar damages blood vessels, eyes, kidneys, and nerves over time.',
    },
    fasting_glucose: {
        plainName: 'Blood sugar level',
        whatItIs: 'The amount of sugar in your blood after not eating overnight, which is a snapshot of a single moment.',
        whyItMatters: 'It shows how well your body is handling sugar at rest, and it is used alongside HbA1c to identify diabetes.',
        low: 'A low reading can cause shakiness, sweating, and confusion. It is most often seen in people taking diabetes medication, and occasionally after a long gap without food.',
        high: 'A high reading suggests your body is struggling to move sugar out of the blood, which is the pattern seen in prediabetes and diabetes. Eating or drinking anything but water before the test also raises it.',
    },

    // ── Thyroid ───────────────────────────────────────────────────────────────────────
    tsh: {
        plainName: 'Thyroid control signal',
        whatItIs: 'TSH is the message your brain sends to your thyroid gland telling it how much thyroid hormone to make.',
        whyItMatters: 'Because it is the instruction rather than the hormone, it moves in the opposite direction to thyroid activity, which makes it the most sensitive early test of thyroid trouble.',
        low: 'A low TSH means the brain is easing off, which usually indicates an overactive thyroid — weight loss, a racing heart, anxiety, feeling too hot.',
        high: 'A high TSH means the brain is pushing harder because the thyroid is underperforming — tiredness, weight gain, feeling cold, and low mood are typical.',
    },
    free_t4: {
        plainName: 'Thyroid hormone',
        whatItIs: 'T4 is the actual hormone your thyroid produces, and the free portion is the part available for your body to use.',
        whyItMatters: 'It is measured with TSH to confirm what the control signal is suggesting and to show how far the thyroid is off.',
        low: 'A low level means your thyroid is producing too little hormone, which slows the body down — fatigue, weight gain, and feeling cold.',
        high: 'A high level means too much hormone, which speeds the body up — weight loss, palpitations, tremor, and sleeplessness.',
    },

    // ── Kidneys ───────────────────────────────────────────────────────────────────────
    creatinine: {
        plainName: 'Kidney waste product',
        whatItIs: 'Creatinine is a waste product your muscles make continuously, and your kidneys are responsible for clearing it out.',
        whyItMatters: 'Because production is fairly steady, the amount left in your blood is a good indicator of how well your kidneys are filtering.',
        low: 'A low level is rarely a concern and usually reflects lower muscle mass.',
        high: 'A high level suggests the kidneys are not clearing waste as efficiently as expected. It also rises temporarily with dehydration, a very high-protein diet, intense exercise, or a large amount of muscle.',
    },
    egfr: {
        plainName: 'Kidney filtering rate',
        whatItIs: 'An estimate of how much blood your kidneys clean each minute, calculated from your creatinine along with your age and sex.',
        whyItMatters: 'It is the number kidney health is graded by, and it is easier to interpret than creatinine on its own.',
        low: 'A lower rate means the kidneys are filtering less well than expected. Mild reductions are common with age. A persistently low result is what chronic kidney disease is defined by, and is followed up.',
        high: 'A high rate is not a concern — a result at or above the normal figure indicates the kidneys are filtering well.',
    },
    urea: {
        plainName: 'Protein waste product',
        whatItIs: 'Urea is what is left over after your body breaks down protein, and your kidneys remove it from the blood.',
        whyItMatters: 'It is read alongside creatinine, and the difference between the two helps separate a kidney problem from simple dehydration.',
        low: 'A low level can follow a low-protein diet, pregnancy, or liver conditions, and is not usually a concern by itself.',
        high: 'A high level often means dehydration or a lot of protein in the diet. It can also indicate the kidneys are not clearing waste properly, particularly when creatinine is raised too.',
    },
    uric_acid: {
        plainName: 'Gout-related waste',
        whatItIs: 'Uric acid is a waste product from breaking down substances found in many foods and in your own cells, and it leaves through the kidneys.',
        whyItMatters: 'When there is too much it can form sharp crystals in joints, which is what gout is, and it can also form kidney stones.',
        low: 'A low level is uncommon and not usually significant.',
        high: 'A high level raises the chance of gout — typically a sudden, very painful, swollen joint, often the big toe — and of kidney stones. Alcohol, red meat, shellfish, and sugary drinks all push it up. Many people with a high level never develop symptoms.',
    },

    // ── Liver ─────────────────────────────────────────────────────────────────────────
    alt: {
        plainName: 'Liver enzyme',
        whatItIs: 'ALT is an enzyme found mostly inside liver cells, which leaks into the blood when those cells are irritated or damaged.',
        whyItMatters: 'It is the most liver-specific of the routine liver tests, so a rise points fairly directly at the liver.',
        low: 'A low level is not a concern.',
        high: 'A raised level means liver cells are under some strain. Common causes are fat build-up in the liver, alcohol, certain medicines including some over-the-counter ones, and viral infections. Mild rises are common and often reversible.',
    },
    ast: {
        plainName: 'Liver and muscle enzyme',
        whatItIs: 'AST is an enzyme found in the liver but also in muscle and the heart, so it is not specific to one organ.',
        whyItMatters: 'Comparing it with ALT helps show whether a raised result is coming from the liver or from somewhere else, such as muscle.',
        low: 'A low level is not a concern.',
        high: 'A raised level can reflect liver strain, but also hard exercise or a muscle injury in the days before the test. It is interpreted next to ALT rather than alone.',
    },
    ggt: {
        plainName: 'Bile duct enzyme',
        whatItIs: 'GGT is an enzyme concentrated in the liver and the bile ducts that drain it.',
        whyItMatters: 'It is particularly sensitive to alcohol and to blockages in the bile ducts, and it confirms whether a raised alkaline phosphatase is coming from the liver.',
        low: 'A low level is not a concern.',
        high: 'A raised level most commonly reflects alcohol intake, fat build-up in the liver, or a problem with bile flow. Several common medicines raise it too.',
    },
    alp: {
        plainName: 'Liver and bone enzyme',
        whatItIs: 'Alkaline phosphatase is an enzyme that comes mainly from the bile ducts of the liver and from bone.',
        whyItMatters: 'Because it has two sources, it points at either the liver or the bones, and GGT is used to tell which.',
        low: 'A low level is uncommon and can relate to certain nutritional or inherited conditions.',
        high: 'A raised level can indicate bile not draining freely, or increased bone activity. It is normally higher in growing teenagers and in pregnancy, which is expected rather than a problem.',
    },
    bilirubin: {
        plainName: 'Waste from old blood cells',
        whatItIs: 'Bilirubin is the yellow substance left when worn-out red blood cells are broken down, and the liver clears it into bile.',
        whyItMatters: 'It shows how well the liver is processing and draining this waste, and it is what makes skin and eyes look yellow when it builds up.',
        low: 'A low level is not a concern.',
        high: 'A raised level can mean the liver is not processing it fast enough, that bile is not draining, or that red blood cells are being broken down more quickly than usual. A mild persistent rise is often Gilbert\'s syndrome, a common and harmless inherited variation.',
    },
    albumin: {
        plainName: 'Main blood protein',
        whatItIs: 'Albumin is the most abundant protein in your blood, made by the liver, and it keeps fluid inside your blood vessels while ferrying other substances around.',
        whyItMatters: 'It reflects both how well the liver is producing protein and your general nutritional state over recent months.',
        low: 'A low level can occur with liver or kidney conditions, poor nutrition, or any significant ongoing inflammation, and can lead to swelling in the ankles.',
        high: 'A high level is almost always dehydration concentrating the blood rather than a problem with the protein itself.',
    },
    total_protein: {
        plainName: 'All blood proteins',
        whatItIs: 'The combined amount of albumin and the antibody proteins circulating in your blood.',
        whyItMatters: 'It gives a broad view of nutrition, liver function, and immune activity in one number.',
        low: 'A low level can reflect poor nutrition, or a liver or kidney condition, and usually prompts a look at albumin separately.',
        high: 'A high level can be dehydration, or increased antibody production during a long-running infection or inflammation.',
    },

    // ── Salts and minerals ────────────────────────────────────────────────────────────
    sodium: {
        plainName: 'Salt balance',
        whatItIs: 'Sodium is the main salt in the fluid around your cells, and your kidneys and hormones hold it within a narrow band.',
        whyItMatters: 'It governs how much water your body holds, and it matters to nerve and muscle function including the heart.',
        low: 'A low level usually reflects too much water relative to salt rather than too little salt. It can cause headache, nausea, and confusion, and several common medicines contribute.',
        high: 'A high level generally means not enough water — dehydration — rather than too much salt in the diet, and typically causes thirst.',
    },
    potassium: {
        plainName: 'Heart and muscle salt',
        whatItIs: 'Potassium is a mineral your nerves and muscles need to fire correctly, and your heart is especially sensitive to it.',
        whyItMatters: 'The safe band is narrow, and readings outside it in either direction can disturb heart rhythm, so it is taken seriously.',
        low: 'A low level can cause muscle weakness, cramps, and palpitations. Water tablets, vomiting, and diarrhoea are common causes.',
        high: 'A high level can affect heart rhythm and needs prompt attention. It can also be a false reading if the sample was squeezed or delayed on the way to the lab, so it is often rechecked.',
    },
    chloride: {
        plainName: 'Salt balance partner',
        whatItIs: 'Chloride is the salt that travels with sodium and helps keep your body fluids and their acidity balanced.',
        whyItMatters: 'It is rarely interesting alone, but read next to sodium it helps explain what is happening to your fluid balance.',
        low: 'A low level often accompanies prolonged vomiting, or fluid shifts from certain medicines.',
        high: 'A high level usually accompanies dehydration, and is interpreted alongside sodium rather than on its own.',
    },
    calcium: {
        plainName: 'Bone and nerve mineral',
        whatItIs: 'Calcium is best known for bone, but the amount in your blood is tightly controlled because nerves, muscles, and clotting all depend on it.',
        whyItMatters: 'Blood calcium is held steady by hormones and the kidneys, so a result outside the band points at that control system rather than at your diet.',
        low: 'A low level can cause tingling around the mouth and fingers and muscle cramps, and is often related to vitamin D or to the parathyroid glands.',
        high: 'A high level can cause thirst, constipation, and fatigue, and is usually investigated because the common causes are an overactive parathyroid gland or, less often, something else needing attention.',
    },

    // ── Vitamins ──────────────────────────────────────────────────────────────────────
    vitamin_d: {
        plainName: 'Sunshine vitamin',
        whatItIs: 'Vitamin D is made in your skin from sunlight and taken in from a few foods, and this test measures the stored form.',
        whyItMatters: 'It lets your body absorb calcium, so it underpins bone strength, and it also has a part in muscle function and immunity.',
        low: 'Low vitamin D is very common, especially in winter, in people who cover up or stay indoors, and in those with darker skin. It can cause aching bones and muscles and tiredness, and it is straightforward to correct with supplements.',
        high: 'A high level nearly always comes from taking too much in supplement form, which over time can push calcium up.',
    },
    vitamin_b12: {
        plainName: 'Nerve and blood vitamin',
        whatItIs: 'Vitamin B12 comes almost entirely from animal foods and is needed to build red blood cells and maintain your nerves.',
        whyItMatters: 'A shortage causes both anaemia and nerve symptoms, and the nerve damage can become permanent if it is left long enough.',
        low: 'A low level can cause tiredness, pins and needles, poor balance, and memory problems. It is more likely on a vegan diet, after certain stomach surgery, on long-term acid-reducing or diabetes medication, and with an immune condition that blocks absorption.',
        high: 'A high level usually just means you are taking a supplement. Rarely, when unexplained, it is looked into further.',
    },
    folate: {
        plainName: 'Vitamin B9',
        whatItIs: 'Folate is a B vitamin from green vegetables, pulses, and fortified foods, and it is needed to build new cells.',
        whyItMatters: 'It works with B12 to make healthy red blood cells, and it is especially important before and during early pregnancy to protect the baby\'s spine.',
        low: 'A low level can cause anaemia with enlarged red blood cells and tiredness. Diet, alcohol, pregnancy, and some medicines are the usual causes.',
        high: 'A high level is generally harmless and usually reflects supplements or fortified food.',
    },

    // ── Inflammation ──────────────────────────────────────────────────────────────────
    crp: {
        plainName: 'Inflammation marker',
        whatItIs: 'C-reactive protein is made by the liver whenever there is inflammation anywhere in the body, and it rises and falls quickly.',
        whyItMatters: 'It tells you that inflammation is present and roughly how much, though it does not say where it is coming from.',
        low: 'A low result means no significant inflammation was detectable, which is the expected finding.',
        high: 'A raised result means something is inflaming somewhere. A large rise usually means an infection. A small persistent rise can accompany conditions such as arthritis, obesity, or smoking, and is interpreted in the context of how you feel.',
    },

    // ── Screening ─────────────────────────────────────────────────────────────────────
    psa: {
        plainName: 'Prostate marker',
        whatItIs: 'PSA is a protein made by the prostate gland, and a small amount normally circulates in the blood of men.',
        whyItMatters: 'It is the main blood test used in checking prostate health, though it is a starting point for a conversation rather than an answer on its own.',
        low: 'A low result is the expected finding and is reassuring for prostate screening purposes.',
        high: 'A raised result needs discussion with a doctor, but it is not by itself a sign of cancer. The prostate naturally enlarges with age, and infection, recent cycling, and recent ejaculation all raise it temporarily.',
    },
};

/**
 * Analytes real reports carry that `unitNormaliser` does not yet normalise.
 *
 * These arrive through the fallback path in `biomarkerController.canonicalise`, which slugs
 * whatever the report printed — so they are stored under run-together keys like
 * `redcelldistributionwidth`, never range-checked, and shown with the flag `unknown`.
 *
 * They still need explaining, and arguably need it *more*: a value the app cannot judge is
 * one the person has to judge themselves, and "Neutrophils 4.1" is no more readable than
 * "MCV 88". Kept separate from `GLOSSARY` so `auditGlossary()` stays meaningful — an entry
 * here is a documented gap in the catalogue, not drift.
 *
 * Moving one of these into `unitNormaliser` later is the real fix; it would give the analyte
 * a unit, a reference range, and a flag. Nothing here should be read as a substitute for
 * that, and an entry can simply move to `GLOSSARY` when it happens.
 *
 * Each carries a `label` — the properly spelled medical name — because the fallback path
 * stores `displayName` as the same run-together slug as `name`. Without it the row title
 * renders as "redcelldistributionwidth", which is less readable than the medical term the
 * whole exercise set out to translate.
 */
const UNCATALOGUED = {
    // ── White cell differential — the breakdown behind the total WBC ──────────────────
    neutrophils: {
        label: 'Neutrophils',
        plainName: 'Bacteria-fighting cells',
        whatItIs: 'Neutrophils are the most common type of white blood cell and the first to arrive when bacteria get in.',
        whyItMatters: 'They are the part of the immune system that deals with everyday bacterial infection, so the count moves quickly when you are unwell.',
        low: 'A low count can leave you more vulnerable to bacterial infection, and can follow a viral illness, certain medicines, or a problem with production in the bone marrow.',
        high: 'A high count usually means the body is fighting a bacterial infection or dealing with inflammation, and it also rises with physical stress, injury, smoking, and steroid medicines.',
    },
    lymphocytes: {
        label: 'Lymphocytes',
        plainName: 'Virus-fighting cells',
        whatItIs: 'Lymphocytes are the white blood cells that handle viruses and that carry your immune memory of past infections and vaccines.',
        whyItMatters: 'They tend to move in the opposite direction to neutrophils, so the balance between the two hints at what kind of illness is going on.',
        low: 'A low count can follow a recent infection, steroid treatment, or a condition affecting the immune system, and is often temporary.',
        high: 'A high count commonly accompanies a viral infection such as glandular fever. A count that stays high without explanation is investigated further.',
    },
    monocytes: {
        label: 'Monocytes',
        plainName: 'Clean-up immune cells',
        whatItIs: 'Monocytes are white blood cells that clear away dead cells and debris and help coordinate the rest of the immune response.',
        whyItMatters: 'They rise in longer-running infections and inflammation rather than in short-lived ones.',
        low: 'A low count is uncommon and rarely significant by itself.',
        high: 'A high count can accompany a long-running infection, an inflammatory condition, or recovery from a recent illness.',
    },
    eosinophils: {
        label: 'Eosinophils',
        plainName: 'Allergy and parasite cells',
        whatItIs: 'Eosinophils are white blood cells involved in allergic reactions and in defending against parasites.',
        whyItMatters: 'They are one of the few blood results that points fairly specifically at allergy, asthma, or a parasitic infection.',
        low: 'A low count is normal and not a concern.',
        high: 'A high count is often linked to allergies, hay fever, asthma, eczema, or a drug reaction, and less commonly to a parasitic infection.',
    },
    basophils: {
        label: 'Basophils',
        plainName: 'Allergy-response cells',
        whatItIs: 'Basophils are the rarest white blood cells and release the chemicals behind allergic and inflammatory reactions.',
        whyItMatters: 'They are present in such small numbers that the count is mainly useful when it is unexpectedly high.',
        low: 'A low count is normal and carries no significance, since the usual number is close to zero anyway.',
        high: 'A high count is uncommon and can accompany allergic reactions, inflammation, or an underactive thyroid.',
    },

    // ── Red cell indices reported with every full blood count ─────────────────────────
    mch: {
        label: 'MCH',
        plainName: 'Oxygen protein per cell',
        whatItIs: 'MCH stands for mean corpuscular haemoglobin — the average amount of the oxygen-carrying protein packed into each red blood cell.',
        whyItMatters: 'It moves with cell size, and the two together narrow down which kind of anaemia is present.',
        low: 'A low value means cells are carrying less haemoglobin than usual, which most often points to iron deficiency.',
        high: 'A high value goes with larger red blood cells, which points towards a shortage of vitamin B12 or folate.',
    },
    mchc: {
        label: 'MCHC',
        plainName: 'Oxygen protein concentration',
        whatItIs: 'MCHC is how tightly the oxygen-carrying protein is packed inside your red blood cells, as a concentration rather than an amount.',
        whyItMatters: 'It is used alongside the other red cell measures to sort out the cause of an anaemia.',
        low: 'A low value is typically seen in iron deficiency, where cells are both smaller and paler than usual.',
        high: 'A high value is uncommon and can indicate a condition in which red blood cells are more fragile than normal. It is sometimes a laboratory artefact and gets rechecked.',
    },
    redcelldistributionwidth: {
        label: 'RDW',
        plainName: 'Variation in cell size',
        whatItIs: 'RDW describes how much your red blood cells vary in size from one another, rather than how big they are on average.',
        whyItMatters: 'It often changes before the average size does, so it can be the earliest hint that a nutrient is running short.',
        low: 'A low value means your red blood cells are uniform in size, which is the expected finding.',
        high: 'A high value means the cells vary more than usual, which commonly happens when iron, B12, or folate is running low, or when a shortage is just starting to correct.',
    },

    // ── Calculated lipid values — arithmetic on the measured ones ─────────────────────
    nonhdlcholesterol: {
        label: 'Non-HDL Cholesterol',
        plainName: 'All the harmful cholesterol',
        whatItIs: 'Your total cholesterol with the protective HDL portion subtracted, leaving everything that can contribute to build-up in artery walls.',
        whyItMatters: 'It captures more of the harmful particles than LDL alone, and unlike LDL it stays reliable even if you did not fast before the test.',
        low: 'A lower value is better for your arteries and is what treatment aims for.',
        high: 'A high value means more cholesterol-carrying particles able to deposit in artery walls, raising the long-term risk of heart attack and stroke.',
    },
    cholesteroltohdlratio: {
        label: 'Cholesterol / HDL Ratio',
        plainName: 'Cholesterol balance',
        whatItIs: 'Your total cholesterol divided by the protective HDL portion, which expresses the balance between the two as a single number.',
        whyItMatters: 'The balance predicts heart risk better than either number alone, because the same total means something different depending on how much of it is protective.',
        low: 'A lower ratio means a larger share of your cholesterol is the protective kind, which is favourable.',
        high: 'A high ratio means too little of the protective kind relative to the total, which is linked to a higher risk of heart disease. Exercise and stopping smoking improve it.',
    },
    estimatedaverageglucose: {
        label: 'Estimated Average Glucose',
        plainName: 'Average blood sugar, converted',
        whatItIs: 'Your HbA1c expressed as an everyday blood sugar number, so it can be compared with the readings from a home glucose meter.',
        whyItMatters: 'It is not a separate test — it is the same result in more familiar units, which makes it easier to relate to day-to-day readings.',
        low: 'A low value reflects a low HbA1c and is interpreted in the same way.',
        high: 'A high value reflects a raised HbA1c, meaning average blood sugar has been running high over the past two to three months.',
    },
};

/**
 * Aliases for the fallback keys `biomarkerController.canonicalise` produces when a report
 * names an analyte the catalogue does not define. Without these, a value stored as
 * `mean_corpuscular_volume` would show no explanation while `mcv` shows one, which reads to
 * the user as the app knowing about one of their results and not the other.
 */
const KEY_ALIASES = {
    mean_corpuscular_volume: 'mcv',
    // Seen on live reports: the lab printed the words out, so `slug()` ran them together
    // and the value never reached the `hba1c` canonical key. It is therefore stored
    // unflagged and untrended — see docs/KNOWN-ISSUES.md. The alias at least explains it.
    glycosylatedhemoglobinhba1c: 'hba1c',
    glycatedhaemoglobinhba1c: 'hba1c',
    calculatedldl: 'ldl_cholesterol',
    ldlcholesterolcalculated: 'ldl_cholesterol',
    mean_corpuscular_haemoglobin: 'mch',
    mean_corpuscular_hemoglobin: 'mch',
    meancorpuscularhaemoglobin: 'mch',
    mean_corpuscular_haemoglobin_concentration: 'mchc',
    meancorpuscularhaemoglobinconcentration: 'mchc',
    rdw: 'redcelldistributionwidth',
    red_cell_distribution_width: 'redcelldistributionwidth',
    non_hdl_cholesterol: 'nonhdlcholesterol',
    cholesterol_hdl_ratio: 'cholesteroltohdlratio',
    total_cholesterol_hdl_ratio: 'cholesteroltohdlratio',
    estimated_average_glucose: 'estimatedaverageglucose',
    eag: 'estimatedaverageglucose',
    glycated_haemoglobin: 'hba1c',
    glycosylated_haemoglobin: 'hba1c',
    a1c: 'hba1c',
    hemoglobin: 'haemoglobin',
    hematocrit: 'haematocrit',
    glucose: 'fasting_glucose',
    white_blood_cell_count: 'wbc',
    red_blood_cell_count: 'rbc',
    c_reactive_protein: 'crp',
    total_bilirubin: 'bilirubin',
    alkaline_phosphatase: 'alp',
    gamma_gt: 'ggt',
    vitamin_b_12: 'vitamin_b12',
    '25_oh_vitamin_d': 'vitamin_d',
};

/** Normalise a lookup key the same way stored biomarker names are normalised. */
const normaliseKey = (name) =>
    String(name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/**
 * The explainer for one analyte, or null when we have nothing honest to say about it.
 *
 * Null rather than a generic placeholder: "this measures something in your blood" is worse
 * than no text at all, because it looks like an answer.
 */
/**
 * Catalogue display names, so a `GLOSSARY` entry never has to restate one.
 *
 * Needed because a report can reach a catalogue analyte through the *fallback* slug path —
 * a lab printing "Glycosylated Hemoglobin HbA1c" stores `displayName` as that run-together
 * slug, and the row would title with it despite the catalogue knowing the analyte as
 * "HbA1c". Built once, lazily, to keep the require out of module load order.
 */
let catalogueLabels = null;
const labelFor = (canonicalKey) => {
    if (!catalogueLabels) {
        const { listBiomarkers } = require('./unitNormaliser');
        catalogueLabels = Object.fromEntries(listBiomarkers().map((b) => [b.name, b.displayName]));
    }
    return catalogueLabels[canonicalKey] || null;
};

const explain = (name) => {
    const key = normaliseKey(name);
    // Reports arrive with and without separators — `canonicalise` strips them entirely for
    // uncatalogued analytes, so "Red Cell Distribution Width" lands as one run-together
    // word while "vitamin_b12" keeps its underscores. Try both spellings of the key.
    const squashed = key.replace(/_/g, '');

    for (const candidate of [key, squashed, KEY_ALIASES[key], KEY_ALIASES[squashed]]) {
        if (!candidate) continue;
        for (const table of [GLOSSARY, UNCATALOGUED]) {
            const entry = table[candidate];
            if (entry) return { label: entry.label || labelFor(candidate), ...entry };
        }
    }
    return null;
};

/**
 * The line worth showing beside a result, chosen by which way the value is off.
 *
 * A person looking at a flagged result wants "what does high mean for me" — not the full
 * definition — so the flag picks the sentence rather than the UI showing all of it.
 */
const explainFlag = (name, flag) => {
    const entry = explain(name);
    if (!entry) return null;
    if (['low', 'critical_low'].includes(flag)) return entry.low;
    if (['high', 'critical_high'].includes(flag)) return entry.high;
    return null;
};

/** Every entry from both tables, keyed by name — for the catalogue endpoint and for tests. */
const listGlossary = () =>
    [...Object.entries(GLOSSARY), ...Object.entries(UNCATALOGUED)]
        .map(([name, entry]) => ({ name, ...entry }));

/**
 * Drift between the glossary and the analyte catalogue, in both directions.
 *
 * `missing` is the one that matters: an analyte the app can store and flag but cannot
 * explain will render as a bare medical term to a member of the public, which is the exact
 * problem this module exists to remove.
 */
const auditGlossary = () => {
    const { listBiomarkers } = require('./unitNormaliser');
    const catalogue = listBiomarkers().map((b) => b.name);
    return {
        missing: catalogue.filter((n) => !GLOSSARY[n]),
        orphaned: Object.keys(GLOSSARY).filter((n) => !catalogue.includes(n)),
        // Analytes explained here but absent from the catalogue: each one is a value the app
        // stores without a unit, a range, or a verdict. Not an error, but a standing list of
        // what `unitNormaliser` should absorb next.
        uncatalogued: Object.keys(UNCATALOGUED),
    };
};

module.exports = {
    GLOSSARY, UNCATALOGUED, explain, explainFlag, listGlossary, auditGlossary, normaliseKey,
};
