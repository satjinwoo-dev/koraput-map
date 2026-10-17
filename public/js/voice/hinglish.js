// @ts-check
/* ============================================================================
   MapUnite voice — Hinglish text for neural voices
   ==============================================================================
   The Master's desi lines are written in Roman Hinglish ("Bhai, 800 metre aage
   gaddha hai"). Read by an English voice they come out robotic ("gad-dha",
   "aage" as "age"); read by a Hindi voice in Roman script they are guessed.
   Neural Hindi voices (Google Chirp 3 HD hi-IN, Android's Google hi-IN voices,
   ElevenLabs multilingual) speak Hinglish naturally when Hindi words are in
   Devanagari and English words stay in Latin, the way people text:

     "Bhai, 800 metre aage gaddha hai. Dheere kar."
       → "भाई, 800 मीटर आगे गड्ढा है. धीरे कर."            (lang hi-IN)
     "Speed breaker in 200 metres."  → unchanged          (lang en-IN)

   prepare(text, { relaxed }) → { lang, text, markup, hinglish, unknown }
     lang      "hi-IN" for Hinglish lines, "en-IN" for English ones
     text      what the voice reads
     markup    the same with "[pause short]" between sentences (Google Chirp 3
               HD "markup" input; relaxed lines only: advice breathes, warnings
               don't)
     unknown   Roman words that are neither in the lexicon nor known English
               (names, places): left as they are

   The lexicon is hand-curated for every word the Master speaks (a test checks
   that every word of the desi phrase pack is covered), plus common riding words.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const W = /** @type {any} */ (root); (W.MUVoice || (W.MUVoice = {})).hinglish = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    /** Roman Hinglish → Devanagari. Keys lower case. */
    const LEXICON = Object.freeze({
        // people, address
        bhai: "भाई", bhaiya: "भैया", yaar: "यार", ji: "जी", haan: "हाँ", haanji: "हाँजी", nahi: "नहीं", nahin: "नहीं", na: "ना", mat: "मत",
        // pronouns, particles, postpositions
        main: "मैं", hum: "हम", tum: "तुम", aap: "आप", tu: "तू", tera: "तेरा", teri: "तेरी", mera: "मेरा", meri: "मेरी", apna: "अपना", apni: "अपनी",
        ka: "का", ke: "के", ki: "की", ko: "को", ne: "ने", se: "से", mein: "में", pe: "पे", par: "पर", tak: "तक", hi: "ही", bhi: "भी", toh: "तो", to: "तो",
        aur: "और", ya: "या", ab: "अब", abhi: "अभी", phir: "फिर", jab: "जब", tab: "तब", kya: "क्या", kyun: "क्यों", kaise: "कैसे", kahan: "कहाँ",
        kuch: "कुछ", koi: "कोई", kisi: "किसी", sab: "सब", bas: "बस", sa: "सा", si: "सी", wala: "वाला", wale: "वाले", wali: "वाली",
        yahan: "यहाँ", yahin: "यहीं", wahan: "वहाँ", wahin: "वहीं", idhar: "इधर", udhar: "उधर",
        // to be
        hai: "है", hain: "हैं", hoon: "हूँ", ho: "हो", tha: "था", thi: "थी", the: "थे", hota: "होता", hoti: "होती", hone: "होने", hua: "हुआ",
        raha: "रहा", rahi: "रही", rahe: "रहे", rahega: "रहेगा", rahegi: "रहेगी",
        // verbs
        aa: "आ", aate: "आते", aaya: "आया", aaye: "आए", aayenge: "आएँगे", aao: "आओ",
        ja: "जा", jaana: "जाना", jaata: "जाता", jaati: "जाती", jaye: "जाए", gaya: "गया", gayi: "गई", gaye: "गए",
        kar: "कर", karo: "करो", karein: "करें", karke: "करके", karna: "करना", kiya: "किया",
        de: "दे", do: "दो", di: "दी", diya: "दिया", dunga: "दूँगा",
        le: "ले", lo: "लो", lein: "लें", lena: "लेना", liya: "लिया",
        dekh: "देख", dekho: "देखो", dekhna: "देखना", dikh: "दिख", dikha: "दिखा", dikhi: "दिखी",
        chal: "चल", chalo: "चलो", chala: "चला", chalao: "चलाओ", chalaya: "चलाया", chalna: "चलना", chalta: "चलता", chalte: "चलते",
        ruk: "रुक", ruko: "रुको", ruke: "रुके", rukne: "रुकने", rukte: "रुकते", rukna: "रुकना",
        rakh: "रख", rakho: "रखो", rakhna: "रखना", reh: "रह", rehna: "रहना",
        lag: "लग", laga: "लगा", lage: "लगे", lagi: "लगी", lagana: "लगाना", lagatar: "लगातार",
        bata: "बता", bataya: "बताया", batao: "बताओ", batana: "बताना", bataun: "बताऊँ", bol: "बोल", bolo: "बोलो", bolun: "बोलूँ", sun: "सुन", suno: "सुनो",
        bana: "बना", bhej: "भेज", bhejna: "भेजना", daal: "डाल", dabao: "दबाओ", maar: "मार", utha: "उठा", nikalna: "निकलना",
        ghabra: "घबरा", ghabrana: "घबराना", ghus: "घुस", pi: "पी", piyo: "पियो", sake: "सके", sakte: "सकते", sakta: "सकता",
        milega: "मिलेगा", milegi: "मिलेगी", mila: "मिला", paaya: "पाया", pada: "पड़ा", padega: "पड़ेगा", bachenge: "बचेंगे", bacho: "बचो",
        badh: "बढ़", badhao: "बढ़ाओ", shuru: "शुरू", khatam: "ख़त्म", jhuk: "झुक", latak: "लटक", jhapak: "झपक",
        // nouns
        baat: "बात", baar: "बार", aankh: "आँख", aankhen: "आँखें", aankhon: "आँखों", chehra: "चेहरा", chehre: "चेहरे", muh: "मुँह", sir: "सिर",
        haath: "हाथ", kamar: "कमर", saans: "साँस", neend: "नींद", jhapki: "झपकी", thakaan: "थकान", palkein: "पलकें", ubaasi: "उबासी",
        doosre: "दूसरे", doosra: "दूसरा",
        // the voice tones (js/master/phrases-tone.js)
        aankhein: "आँखें", abe: "अबे", andha: "अंधा", apne: "अपने", baji: "बजी", ban: "बन", banda: "बंदा", bhool: "भूल", chalayein: "चलाएँ", degi: "देगी", dhyaan: "ध्यान", dikhti: "दिखती", ekdum: "एकदम", guzre: "गुज़रे", hilegi: "हिलेगी", hisaab: "हिसाब", jahan: "जहाँ", jayega: "जाएगा", khaya: "खाया", khuli: "खुली", kripya: "कृपया", maan: "मान", makhan: "मक्खन", mehsoos: "महसूस", nikle: "निकले", oye: "ओए", padi: "पड़ी", rakhein: "रखें", rasta: "रास्ता", sarkar: "सरकार", tod: "तोड़", udd: "उड़", uske: "उसके", usko: "उसको", wahi: "वही", warna: "वरना", yaad: "याद", yeh: "यह", aakhri: "आख़िरी", anumaan: "अनुमान", dekha: "देखा", guzra: "गुज़रा", jaankari: "जानकारी", mutaabik: "मुताबिक़",
        pakka: "पक्का", sarkari: "सरकारी",
        sadak: "सड़क", raasta: "रास्ता", raste: "रास्ते", raaste: "रास्ते", haalat: "हालत", pata: "पता", pakki: "पक्की", kachchi: "कच्ची", bataunga: "बताऊँगा", gaddha: "गड्ढा", gaddhe: "गड्ढे", jhatka: "झटका", jhatke: "झटके",
        gaadi: "गाड़ी", paani: "पानी", chai: "चाय", tapri: "टपरी", dhaba: "ढाबा", ghar: "घर", jagah: "जगह", taraf: "तरफ़", beech: "बीच",
        mausam: "मौसम", baarish: "बारिश", dhoop: "धूप", kohra: "कोहरा", dhund: "धुंध", toofan: "तूफ़ान", aandhi: "आँधी", hawa: "हवा", roshni: "रोशनी",
        khatra: "ख़तरा", galti: "ग़लती", kaam: "काम", aaram: "आराम", mann: "मन", baare: "बारे", ghante: "घंटे", ghanta: "घंटा",
        nishaan: "निशान", bajri: "बजरी", ret: "रेत", malba: "मलबा", kinara: "किनारा", tel: "तेल", keechad: "कीचड़",
        paidal: "पैदल", thela: "ठेला", gaay: "गाय", bhains: "भैंस", kutta: "कुत्ता", janwar: "जानवर",
        // adjectives, adverbs
        aage: "आगे", peeche: "पीछे", paas: "पास", door: "दूर", saamne: "सामने", saath: "साथ", neeche: "नीचे", upar: "ऊपर",
        pehle: "पहले", pehli: "पहली", baaki: "बाकी", har: "हर", is: "इस", baad: "बाद", agle: "अगले", agla: "अगला", pichhle: "पिछले", pichhli: "पिछली", dobara: "दोबारा", wapas: "वापस", turant: "तुरंत",
        achanak: "अचानक", dheere: "धीरे", jaldi: "जल्दी", bahut: "बहुत", zyada: "ज़्यादा", kam: "कम", thoda: "थोड़ा", thodi: "थोड़ी", thode: "थोड़े",
        kaafi: "काफ़ी", bilkul: "बिल्कुल", poora: "पूरा", pura: "पूरा", khud: "ख़ुद", sirf: "सिर्फ़",
        achha: "अच्छा", achhi: "अच्छी", achhe: "अच्छे", badhiya: "बढ़िया", theek: "ठीक", kharab: "ख़राब", galat: "ग़लत", saaf: "साफ़",
        zaroori: "ज़रूरी", garam: "गरम", thanda: "ठंडा", thaki: "थकी", thaka: "थका", kamzor: "कमज़ोर", bhaari: "भारी", bada: "बड़ा", badi: "बड़ी",
        chhota: "छोटा", chhoti: "छोटी", seedha: "सीधा", seedhi: "सीधी", gayab: "ग़ायब", khula: "खुला", tuta: "टूटा", geeli: "गीली", bhara: "भरा",
        band: "बंद", zor: "ज़ोर", dhyan: "ध्यान", bina: "बिना", ek: "एक", das: "दस", bees: "बीस", pandrah: "पंद्रह", ubad: "ऊबड़", khabad: "खाबड़",
        // loanwords said the Indian way inside Hinglish (units mostly)
        metre: "मीटर", metres: "मीटर", meter: "मीटर", meters: "मीटर", km: "किलोमीटर", minute: "मिनट", minutes: "मिनट", second: "सेकंड", seconds: "सेकंड"
    });

    /** English words that stay in Latin script inside Hinglish (neural Hindi voices read them with an Indian accent). */
    const ENGLISH = Object.freeze(new Set([
        "ai", "auto", "bike", "brake", "break", "breaker", "bus", "camera", "chances", "check", "cycle", "detail", "down", "e-rickshaw", "fatigue",
        "fresh", "gap", "group", "heads", "late", "live", "load", "manhole", "mileage", "navigation", "network", "offline", "ok", "okay", "petrol",
        "phone", "raincoat", "ride", "route", "rumble", "safe", "save", "screen", "side", "signal", "speed", "spot", "start", "strip", "sync",
        "tempo", "tension", "time", "tractor", "traffic", "truck", "try", "tyre", "up", "update", "view", "visor", "weak", "gps", "helmet",
        "tip", "app", "battery", "charge", "map", "location", "selfie", "mode", "please", "sorry", "thanks", "rickshaw", "e",
        "report", "riders", "rider", "sensor", "feel", "hero", "limit"
    ]));

    /** Words that are Hindi in our lines but also English (or too short) to prove a line is Hinglish on their own. */
    const AMBIGUOUS = Object.freeze(new Set(["do", "main", "sir", "is", "har", "ban", "band", "pi", "ho", "to", "sun", "na", "ya", "hi", "de", "le", "lo", "pe", "se",
        "sa", "si", "ja", "aa", "door", "the", "tab", "ret", "tel", "bas", "par", "mat", "kam", "metre", "metres", "meter", "meters", "km",
        "minute", "minutes", "second", "seconds"]));

    const WORD = /[A-Za-z]+(?:-[A-Za-z]+)*/g;

    /** @param {string} w lower-case word (hyphen compounds by part) @returns {string|null} */
    function toDevanagari(w) {
        if (Object.prototype.hasOwnProperty.call(LEXICON, w)) return /** @type {any} */ (LEXICON)[w];
        if (w.includes("-")) {
            const parts = w.split("-").map((p) => (Object.prototype.hasOwnProperty.call(LEXICON, p) ? /** @type {any} */ (LEXICON)[p] : null));
            if (parts.every(Boolean)) return parts.join("-");
        }
        return null;
    }

    /** True when the line is Hinglish (enough clearly-Hindi words). @param {string} text */
    function isHinglish(text) {
        const words = String(text).toLowerCase().match(WORD) || [];
        let strong = 0;
        for (const w of words) if (toDevanagari(w) && !AMBIGUOUS.has(w) && !ENGLISH.has(w)) strong++;
        return strong >= 2 || (strong >= 1 && words.length <= 4);
    }

    /**
     * @param {string} text a line as the persona wrote it
     * @param {{ relaxed?: boolean }} [o] relaxed: advice (pauses between sentences); otherwise urgent (no added pauses)
     * @returns {{ lang: "hi-IN"|"en-IN", text: string, markup: string, hinglish: boolean, unknown: string[] }}
     */
    function prepare(text, o = {}) {
        const src = String(text || "").replace(/\s+/g, " ").trim();
        if (!isHinglish(src)) {
            const t = src;
            return { lang: "en-IN", text: t, markup: o.relaxed ? addPauses(t) : t, hinglish: false, unknown: [] };
        }
        /** @type {string[]} */ const unknown = [];
        const out = src.replace(WORD, (m) => {
            const w = m.toLowerCase();
            const d = toDevanagari(w);
            if (d && !ENGLISH.has(w)) return d;
            if (!ENGLISH.has(w) && !unknown.includes(m)) unknown.push(m);
            return m;
        })
            // "..." and "…" are breaths, not letters to read
            .replace(/\s*(\.\.\.|…)\s*/g, ", ")
            .replace(/\s+([,.?!])/g, "$1");
        return { lang: "hi-IN", text: out, markup: o.relaxed ? addPauses(out) : out, hinglish: true, unknown };
    }

    /** Short pauses between sentences (Google Chirp 3 HD markup). @param {string} t */
    function addPauses(t) {
        return t.replace(/([.?!])\s+(?=\S)/g, "$1 [pause short] ");
    }

    return { prepare, isHinglish, toDevanagari, LEXICON, ENGLISH, AMBIGUOUS };
});
