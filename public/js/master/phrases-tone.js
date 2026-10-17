// @ts-check
/* ============================================================================
   MapUnite Master AI — voice tones for the Hinglish voice: Family and Rowdy
   ==============================================================================
   Settings → Community road reports → "Rowdy voice" (off by default).

     family  DEFAULT. Polite "aap" Hinglish: "Aage gaddhe ki report hai, kripya
             dhyaan se chalayein."
     rowdy   Opt-in street banter: "tu", "abe", "bhai", mild roasting
             ("andha hai kya?"). For fun, and for sharing.

   Covered so far: the RoadPulse lines (bump warnings, rough road, the Route
   Truth answers). Every other kind keeps its desi line (phrases-desi.js) in
   both tones. English (plain style) and the screen are the same in both.

   What the tone may change: the words. What it may NOT change, in any tone:
     - the facts: every number, count and source still comes from the
       RoadSense log through the same placeholders;
     - the safety message: every warning still tells the rider to slow down,
       and no line ever tells a rider to speed up or race ("kheench le",
       "full speed", "bhaga"). A "clear" road only means no bumps were felt,
       so even the happy line keeps "limit mein rakh" and what a phone can't feel;
     - no slurs and no abuse of anyone's family, caste, religion or gender:
       roasting the rider's riding, never the rider's identity.
   test/master/tone.test.mjs checks all three.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else {
        const M = /** @type {any} */ (root).MUMaster || (/** @type {any} */ (root).MUMaster = {});
        const pack = factory();
        M.phrasesTone = pack;
        (M.phrasePacks || (M.phrasePacks = [])).push(pack);
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const TONES = Object.freeze(["family", "rowdy"]);

    /** Family: polite, "aap", "kripya". No {{name}}: a formal voice doesn't call the rider "bhai". */
    const family = {
        "road.bump-ahead": {
            warning: [{ say: "{{distanceM|round}} metre aage gaddha ya breaker hai, jahan pichhli baar jhatka laga tha. Kripya dheere chalayein." }]
        },
        "road.bump-reported": {
            warning: [{ say: "{{distanceM|round}} metre aage gaddhe ki report hai, {{evidence}}. Kripya dhyaan se chalayein." }]
        },
        "road.rough-stretch": {
            advice: [{ say: "Aage sadak kharab hai. Kripya speed kam rakhein." }]
        },
        "road.truth": {
            advice: [{ say: "{{where}} pe {{verified}} pakki report hai: {{kinds}}. Pehli {{distanceM|km}} aage, {{hazard}}: {{evidence}}, {{confidence}}." }]
        },
        "road.truth-unconfirmed": {
            advice: [{ say: "{{where}} pe koi pakki report nahi hai, sirf {{candidates}} kachchi report hai. Pehli {{distanceM|km}} aage, {{hazard}}: {{evidence}}. Kripya dhyaan se chalayein." }]
        },
        "road.truth-clear": {
            advice: [{ say: "{{where}} saaf hai: {{clearRiders}} riders ko koi jhatka mehsoos nahi hua, aakhri baar {{clearAgo}}. Phir bhi phone paani ya bajri mehsoos nahi kar sakta, kripya dhyaan rakhein." }]
        },
        "road.truth-partly-clear": {
            advice: [{ say: "{{where}} mein {{clearM|km}} saaf hai, {{clearRiders}} riders ke mutaabik, aakhri baar {{clearAgo}}. Baaki sadak ki haalat pata nahi." }]
        },
        "road.truth-ridden": {
            advice: [{ say: "{{where}} se abhi sirf ek rider guzre hain, {{riddenAgo}}, aur koi jhatka nahi laga. Yeh abhi pakka nahi hai, kripya dhyaan se chalayein." }]
        },
        "road.truth-unknown": {
            advice: [{ say: "{{where}} ki koi report nahi hai, na sensor se na riders se. Haalat pata nahi, kripya dhyaan se chalayein." }]
        },
        "road.truth-also-clear": {
            advice: [{ say: "Baaki mein se {{clearM|km}} saaf hai, {{clearRiders}} riders ke mutaabik." }]
        },
        "road.truth-rest-unknown": {
            advice: [{ say: "Baaki sadak ki haalat pata nahi." }]
        },
        "road.truth-official": {
            advice: [{ say: "Sarkari jaankari: {{officialM|km}} aage {{officialKind}}, {{officialRefs}} ke mutaabik." }]
        },
        "road.truth-predicted": {
            advice: [{ say: "Ek anumaan bhi hai: {{predictedM|km}} aage {{predictedKind}} ka khatra, {{predictedBy}} se. Kisi ne dekha nahi hai, yeh pakka nahi." }]
        },
        "road.route-truth": {
            advice: [{ say: "Is raaste pe {{verified}} pakki report hai: {{kinds}}. Har ek se pehle bataunga. Baaki sadak ki haalat pata nahi." }]
        }
    };

    /** Rowdy: street "tu/abe/bhai", roasting the riding, never the rider's identity; always "slow down", never "speed up". */
    const rowdy = {
        "road.bump-ahead": {
            warning: [
                { say: "Abe {{name}}, {{distanceM|round}} metre aage wahi gaddha hai jahan pichhli baar jhatka khaya tha. Bhool gaya kya? Dheere kar!" },
                { say: "Yaad hai {{name}}? {{distanceM|round}} metre aage wahi jhatka. Speed kam kar, warna phir se kamar hilegi!" }
            ]
        },
        "road.bump-reported": {
            warning: [
                { say: "Abe aage {{distanceM|round}} metre pe gaddha ya breaker hai, {{riders}} riders ne bataya. Andha hai kya? Dheere kar le warna udd jayega!" },
                { say: "Oye {{name}}, {{distanceM|round}} metre aage jhatka hai, {{riders}} riders bata ke gaye. Hero mat ban, dheere kar!" }
            ]
        },
        "road.rough-stretch": {
            advice: [{ say: "Sadak ki band baji padi hai {{name}}, speed kam kar warna kamar tod degi." }]
        },
        "road.truth": {
            advice: [{ say: "Sun {{name}}, {{where}} pe {{verified}} pakki report hai: {{kinds}}. Pehli {{distanceM|km}} aage, {{hazard}}: {{evidenceTu}}. Aankhein khuli rakh." }]
        },
        "road.truth-unconfirmed": {
            advice: [{ say: "{{where}} pe pakka kuch nahi hai {{name}}, bas {{candidates}} kachchi report hai. Pehli {{distanceM|km}} aage, {{hazard}}: {{evidenceTu}}. Dekh ke chala." }]
        },
        "road.truth-clear": {
            advice: [{ say: "Rasta ekdum makhan hai {{name}}, {{clearRiders}} riders bina jhatke nikle, aakhri baar {{clearAgo}}. Par meter limit mein rakh, paani ya bajri phone ko nahi dikhti." }]
        },
        "road.truth-partly-clear": {
            advice: [{ say: "{{clearM|km}} tak rasta makhan hai {{name}}, {{clearRiders}} riders ne check kiya. Uske aage ka apne ko pata nahi, khud dekh ke chala." }]
        },
        "road.truth-ridden": {
            advice: [{ say: "{{where}} se abhi bas ek banda guzra hai, {{riddenAgo}}, usko jhatka nahi laga. Ek ki baat pe mat ja {{name}}, dekh ke chala." }]
        },
        "road.truth-unknown": {
            advice: [{ say: "{{name}}, aage ka apne ko pata nahi hai, apna khud dekh ke chala le." }]
        },
        "road.truth-also-clear": {
            advice: [{ say: "Baaki mein se {{clearM|km}} makhan hai, {{clearRiders}} riders ne check kiya." }]
        },
        "road.truth-rest-unknown": {
            advice: [{ say: "Baaki ka apne ko pata nahi, dekh ke chala." }]
        },
        "road.truth-official": {
            advice: [{ say: "Sarkar bol rahi hai: {{officialM|km}} aage {{officialKind}}, {{officialRefs}} ke hisaab se." }]
        },
        "road.truth-predicted": {
            advice: [{ say: "Ek anumaan bhi hai, {{predictedBy}} wala: {{predictedM|km}} aage {{predictedKind}} ka khatra. Kisi ne dekha nahi, pakka mat maan." }]
        },
        "road.route-truth": {
            advice: [{ say: "Sun {{name}}, is raaste pe {{verified}} pakki report hai: {{kinds}}. Har ek se pehle bata dunga, baaki tu khud dekh ke chala." }]
        }
    };

    /** @param {{ addPhrases: (style: any, pack: any) => void }} persona */
    function install(persona) {
        persona.addPhrases("desi.family", family);
        persona.addPhrases("desi.rowdy", rowdy);
        return persona;
    }

    return { TONES, family, rowdy, install };
});
