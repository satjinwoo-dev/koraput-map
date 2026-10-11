// @ts-check
/* ============================================================================
   MapUnite advice — ask first ("Bhai, ek baat bolun?")
   ==============================================================================
   Before a tip, the app asks a one-second question and listens for about
   3.5 s. The tip is spoken only after a yes; "nahi" or silence drops it.
   Pure: no DOM, no timers. voice.js supplies the two real-world pieces
   (speak-and-wait, listen-once) and this file runs the conversation.

     classifyReply(text | alternatives)  → "yes" | "no" | "unclear" | "silence"
     promptFor({ category, style })      → the question, e.g.
                                           "Bhai, network ke baare mein ek baat bolun?"
     runAsk({ prompt, speak, listen })   → { answer, heard }

   How replies are read (Hinglish, Roman or Devanagari, from the en-IN recognizer):
     yes      haan, haa, ji, bol, bolo, bata, batao, sunao, kya hai, kya hua,
              hmm, theek hai, chal, ok, yes, yeah, sure, what, go ahead, "bol na",
              "kyun nahi" (why not)
     no       nahi, nahin, na (on its own), mat, abhi nahi, baad mein, rehne do,
              chup, busy, no, not now, later, stop, cancel
     A "no" word wins over a "yes" word ("haan… nahi abhi nahi" is no), except
     "kyun nahi". Anything else is "unclear" and is treated like silence:
     when in doubt, stay quiet.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUAdvice || (/** @type {any} */ (root).MUAdvice = {}); ns.ask = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    /** Devanagari words the recognizer sometimes returns, mapped to their Roman spelling. */
    const DEVANAGARI = [
        [/हाँ|हां|(^|\s)हा(?=\s|$)/g, "$1haan"], [/नहीं|नही|नहिं/g, "nahi"], [/(^|\s)ना(?=\s|$)/g, "$1na"], [/मत/g, "mat"], [/बोलो|बोलिए|बोलिये/g, "bolo"],
        [/बोल/g, "bol"], [/बताओ|बताइए|बताइये/g, "batao"], [/बता/g, "bata"], [/सुनाओ/g, "sunao"], [/क्या/g, "kya"], [/है/g, "hai"],
        [/हुआ/g, "hua"], [/जी/g, "ji"], [/ठीक/g, "theek"], [/अभी/g, "abhi"], [/बाद/g, "baad"], [/में/g, "mein"], [/चुप/g, "chup"],
        [/क्यों|क्यूँ|क्यू/g, "kyun"], [/चलो|चल/g, "chal"], [/रहने/g, "rehne"], [/दो/g, "do"]
    ];

    /** @param {string} t */
    function normalize(t) {
        let s = String(t || "").toLowerCase();
        for (const [re, rep] of DEVANAGARI) s = s.replace(/** @type {RegExp} */ (re), /** @type {string} */ (rep));
        return s.replace(/[’`]/g, "'").replace(/[^\p{L}\p{N}'\s]/gu, " ").replace(/\s+/g, " ").trim();
    }

    const WHY_NOT = /\b(kyu|kyun|kyon|kyo|why) ?(nahi|nahin|nai|not)\b/;
    const NO = /\b(nahi+|nahin|nai|nhi|mat|abhi nahi|baad mein|baad me|baad main|rehne (do|de)|chup|band karo?|busy|no+|nope|nah|not now|later|stop|cancel|skip|shut up)\b/;
    const LONE_NA = /^(na+|naa+|nah)( (bhai|yaar|abhi|re))*$/;          // "na" on its own; "bol na" is a yes
    const YES = /\b(haa?n*|haanji|han+|ha|ji|jee|bol|bolo|boliye|bolna|bata|batao|bataiye|sunao|suna|kya|hmm+|hm+|theek|thik|chal|chalo|achha|accha|acha|ok|okay|okey|yes|yeah|yep|yup|ya|sure|what|go ahead|go on|tell me)\b/;

    /**
     * @param {string|string[]|null|undefined} reply one transcript or the recognizer's alternatives (best first)
     * @returns {"yes"|"no"|"unclear"|"silence"}
     */
    function classifyReply(reply) {
        const alts = (Array.isArray(reply) ? reply : [reply]).map(normalize).filter(Boolean);
        if (!alts.length) return "silence";
        /** @param {string} t */
        const one = (t) => {
            if (WHY_NOT.test(t)) return "yes";
            if (NO.test(t) || LONE_NA.test(t)) return "no";
            if (YES.test(t)) return "yes";
            return "unclear";
        };
        // the best guess decides; later alternatives only help when it's unclear
        for (const t of alts) { const r = one(t); if (r !== "unclear") return r; }
        return "unclear";
    }

    const TOPICS = {
        desi: { network: "network ke baare mein", fatigue: "break ke baare mein", rest: "rukne ke baare mein", weather: "mausam ke baare mein", fuel: "petrol ke baare mein", eco: "mileage ke baare mein", convoy: "group ke baare mein", speed: "speed ke baare mein", route: "raste ke baare mein" },
        plain: { network: "the network", fatigue: "a break", rest: "a stop", weather: "the weather", fuel: "fuel", eco: "mileage", convoy: "the group", speed: "your speed", route: "the route" }
    };
    const PROMPTS = {
        desi: { topic: ["Bhai, {topic} ek baat bolun?", "{Topic} kuch bataun bhai?"], plain: ["Bhai, ek baat bolun?", "Kuch bataun bhai?", "Bhai, sun. Bolun?"] },
        plain: { topic: ["Quick one about {topic}. Want it?"], plain: ["Can I tell you something?", "Quick tip. Want it?"] }
    };

    /**
     * The question before a tip: short (about a second), mentioning the topic when it's known.
     * @param {{ category?: string, style?: string, rng?: () => number, avoid?: string }} [o]
     */
    function promptFor(o = {}) {
        const style = o.style === "plain" ? "plain" : "desi";
        const rng = o.rng || Math.random;
        const topic = /** @type {any} */ (TOPICS[style])[o.category || ""] || null;
        const list = topic ? PROMPTS[style].topic : PROMPTS[style].plain;
        const lines = list.map((l) => l.replace("{topic}", topic || "").replace("{Topic}", topic ? topic.charAt(0).toUpperCase() + topic.slice(1) : ""));
        const pool = lines.length > 1 && o.avoid ? lines.filter((l) => l !== o.avoid) : lines;
        return pool[Math.floor(rng() * pool.length) % pool.length];
    }

    /**
     * One question → one answer.
     *   speak(text)  → Promise<boolean>   true once the question has been heard in full
     *   listen(ms)   → Promise<null | { text, alternatives? } | { error }>   null = silence
     * @param {{ prompt: string, speak: (t: string) => Promise<boolean>, listen: (ms: number) => Promise<any>, listenMs?: number, classify?: (r: any) => string }} o
     * @returns {Promise<{ answer: "yes"|"no"|"silence"|"unclear"|"interrupted"|"unavailable", heard: string, error?: string }>}
     */
    async function runAsk(o) {
        const classify = o.classify || classifyReply;
        let spoke = false;
        try { spoke = await o.speak(o.prompt); } catch (e) { spoke = false; }
        if (!spoke) return { answer: "interrupted", heard: "" };
        /** @type {any} */ let r = null;
        try { r = await o.listen(Number.isFinite(o.listenMs) ? /** @type {number} */ (o.listenMs) : 3500); } catch (e) { r = { error: "error" }; }
        if (!r) return { answer: "silence", heard: "" };
        if (r.error) return { answer: r.error === "interrupted" ? "interrupted" : "unavailable", heard: "", error: r.error };
        const heard = String(r.text || (r.alternatives && r.alternatives[0]) || "");
        const answer = /** @type {any} */ (classify(r.alternatives && r.alternatives.length ? r.alternatives : heard));
        return { answer, heard };
    }

    return { classifyReply, promptFor, runAsk, normalize, TOPICS };
});
