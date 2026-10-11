// @ts-check
/* ============================================================================
   MapUnite Master AI — phrase packs (desi Hinglish + plain English)
   ==============================================================================
   Words only, no logic. Each kind matches a report kind an agent sends; each
   severity has its own lines (see persona.js for the format and filters).

   desi  = what the Master SAYS (Hinglish voice). Spoken only: no titles.
   plain = English. Spoken when the voice style is "plain", and ALWAYS what
           the screen shows (title + sub), whatever the voice's style.
           Every kind needs a plain entry with title and sub.
   To add lines for a new agent, add a block here or call
   MUMaster.live.persona.addPhrases("desi", { … }) from the agent's file.

   House style for the desi voice
     - Friendly big-brother Hinglish, Roman script (the TTS voice is en-IN).
     - Warnings say what to DO: "speed kam kar", "agle safe spot pe ruk".
     - Never suggest using the phone while moving: "ruk ke" before any call,
       message or tap.
     - No insults, nothing about the rider's looks, caste, religion or region.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const W = /** @type {any} */ (root); (W.MUMaster || (W.MUMaster = {})).phrases = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const desi = {
        // ---------------------------------------------------------------- network agent
        "network.weak": {
            warning: [
                { say: "{{name}}, network kamzor ho raha hai. Route phone mein save hai, bas traffic update thode late aayenge." },
                { say: "Signal down ho raha hai {{name}}. Navigation chalta rahega, tension mat le." }
            ],
            advice: [
                { say: "{{name}}, yahan network thoda weak hai. Kuch load hone mein time lage toh ghabrana mat." },
                { say: "Signal thoda kam hai {{name}}, par main yahin hoon." }
            ]
        },
        "network.lost": {
            warning: [
                { say: "Network gaya {{name}}! Ghabra mat, route offline chalta rahega." },
                { say: "{{name}}, ab signal bilkul nahi hai. Navigation offline chal raha hai, aaram se chala." }
            ],
            advice: [
                { say: "{{name}}, network chala gaya hai. Wapas aate hi sab sync kar dunga." }
            ]
        },
        "network.restored": {
            advice: [
                { say: "Network wapas aa gaya {{name}}, sab sync ho raha hai." },
                { say: "Chalo {{name}}, signal aa gaya. Ab sab live hai." }
            ],
            info: [{ say: "Network theek hai." }]
        },
        "network.zone-ahead": {
            advice: [
                { say: "{{name}}, {{distanceM|km}} aage network gayab hota hai, pichhli baar bhi gaya tha. Kisi ko update bhejna hai toh ruk ke abhi bhej de." },
                { say: "Heads up {{name}}, {{distanceM|km}} baad signal chala jaata hai. Route save hai, bas ghar pe batana hai toh pehle ruk ke bata de." }
            ]
        },

        // ---------------------------------------------------------------- ride agent
        "ride.break-due": {
            advice: [
                { say: "{{name}}, {{ridingSec|min}} se lagatar chala raha hai. Agle achhe spot pe das minute ka break le, chai-paani ho jaye." },
                { say: "Thoda ruk ja {{name}}. {{ridingSec|min}} ho gaye, kamar seedhi kar le, paani pi le." }
            ],
            warning: [
                { say: "{{name}}, {{ridingSec|min}} se bina ruke chala raha hai. Ab break zaroori hai, agle safe spot pe ruk ja." },
                { say: "Bas {{name}}, ab ruk. Thakaan mein galti hoti hai. Agle safe jagah pe bike side laga." }
            ]
        },
        "ride.break-taken": { info: [{ say: "Break ho gaya, fresh start." }] },
        "ride.started": { info: [{ say: "Ride shuru. Main saath hoon." }] },
        "ride.ended": { info: [{ say: "Ride khatam. Badhiya chalaya." }] },

        // ---------------------------------------------------------------- vision agent (break-time fatigue check)
        "vision.offer": {
            advice: [
                { say: "{{name}}, ruke ho toh ek 10 second ka fatigue check kar lein? Screen pe Start dabao, phone aankh ke saamne rakhna." },
                { say: "{{name}}, break ho raha hai toh aankhon ka chhota sa check karein? Start dabao, bas phone ki taraf dekhna." }
            ]
        },
        "fatigue.high": {
            warning: [
                { say: "{{name}}, {{detail}}. Abhi aage mat badh. Bees minute aaram kar, chai pi, chehre pe paani maar." },
                { say: "{{name}}, aankhen bahut thaki lag rahi hain. Abhi aage mat badh, bees minute aaram kar, ho sake toh chhoti si jhapki le le." }
            ]
        },
        "fatigue.moderate": {
            advice: [
                { say: "{{name}}, thodi thakaan dikh rahi hai, {{detail}}. Das-pandrah minute aur ruk ja, paani pi, phir aaram se chalna." },
                { say: "{{name}}, thodi thakaan dikh rahi hai. Das-pandrah minute aur ruk ja, paani pi, phir aaram se chalna." }
            ]
        },
        "fatigue.low": {
            advice: [
                { say: "{{name}}, check mein zyada thakaan nahi dikhi. Phir bhi {{ridingSec|min}} se chala raha hai, paani pi ke hi nikalna. Neend aaye toh ruk jaana." },
                { say: "{{name}}, check mein zyada thakaan nahi dikhi. Paani pi ke hi nikalna, aur neend aaye toh turant ruk jaana." }
            ]
        },
        "fatigue.retry": {
            advice: [{ say: "{{name}}, chehra theek se nahi dikha. Roshni ki taraf muh karke, visor utha ke, dobara try karein?" }]
        },
        "vision.unavailable": {
            advice: [{ say: "{{name}}, abhi camera check nahi ho paaya. Koi baat nahi, break pura le ke hi chalna." }]
        },

        // ---------------------------------------------------------------- road agent (unified road model)
        "road.hazard": {
            warning: [
                { say: "{{name}}, {{distanceM|round}} metre aage {{hazard}} hai. Dheere kar." },
                { say: "Dhyan se {{name}}, aage {{hazard}} hai, {{distanceM|round}} metre pe." }
            ]
        },
        "traffic.closing-fast": { warning: [{ say: "Dhyan se! Aage {{vehicle}} bahut paas aa raha hai, gap bana." }] },
        "traffic.wrong-side": { warning: [{ say: "Dhyan se {{name}}, saamne se {{vehicle}} galat side se aa raha hai." }] },
        "traffic.cutting-in": { warning: [{ say: "{{name}}, {{vehicle}} beech mein ghus raha hai, dhyan se." }] },
        "perception.degraded": {
            advice: [{ say: "{{name}}, camera wala AI abhi kam kaam kar raha hai, phone garam hai ya view saaf nahi. Sadak pe poora dhyan khud rakhna." }]
        },

        // ---------------------------------------------------------------- ready for the next agents
        "weather.ahead": {
            warning: [
                { say: "{{name}}, {{distanceM|km}} aage {{condition}} hai. Speed kam kar aur aage wale se gap bada rakh." }
            ],
            advice: [
                { say: "{{name}}, aage {{condition}} ke chances hain. Raincoat haath ke paas rakh." }
            ]
        },
        "rest.stop": {
            advice: [
                { say: "{{name}}, {{distanceM|km}} aage {{place}} hai. Wahan rukte hain?" },
                { say: "Chai ka mann hai {{name}}? {{distanceM|km}} aage {{place}} hai." }
            ]
        },

        // ---------------------------------------------------------------- generic fallbacks (a kind with no lines yet)
        "*": {
            critical: [{ say: "Dhyan se {{name}}! Speed kam kar, aage khatra hai." }],
            warning: [{ say: "{{name}}, dhyan de. Detail screen pe daal di hai, ruk ke dekh lena." }],
            advice: [{ say: "{{name}}, ek kaam ki baat screen pe hai. Ruk ke dekh lena." }],
            info: [{ say: "Update aaya hai." }]
        }
    };

    const plain = {
        "network.weak": {
            warning: [{ say: "The network is getting weak. Your route is saved; live traffic may lag.", title: "Weak network", sub: "Route saved, live updates may lag" }],
            advice: [{ say: "The network is weak here, so some things may load slowly.", title: "Weak network", sub: "Some things may be slow" }]
        },
        "network.lost": {
            warning: [{ say: "No signal. Navigation keeps working offline.", title: "No signal", sub: "Navigation works offline" }],
            advice: [{ say: "The network is gone. I'll sync when it's back.", title: "No signal", sub: "Will sync when it's back" }]
        },
        "network.restored": {
            advice: [{ say: "The network is back. Syncing now.", title: "Network back", sub: "Syncing" }],
            info: [{ say: "Network is fine.", title: "Network fine", sub: "" }]
        },
        "network.zone-ahead": {
            advice: [{ say: "The signal usually drops in {{distanceM|km}}. If you need to message anyone, stop and do it now.", title: "No-signal zone ahead", sub: "In {{distanceM|km}}" }]
        },
        "ride.break-due": {
            advice: [{ say: "You've been riding for {{ridingSec|min}}. Take a ten-minute break at the next good spot.", title: "Time for a break", sub: "{{ridingSec|min}} of riding" }],
            warning: [{ say: "{{ridingSec|min}} without a stop. Please take a break at the next safe place.", title: "Break needed", sub: "{{ridingSec|min}} non-stop" }]
        },
        "ride.break-taken": { info: [{ say: "Break done.", title: "Break done", sub: "" }] },
        "ride.started": { info: [{ say: "Ride started.", title: "Ride started", sub: "" }] },
        "ride.ended": { info: [{ say: "Ride finished.", title: "Ride finished", sub: "" }] },
        "vision.offer": { advice: [{ say: "You've stopped. Want a 10-second fatigue check? Tap Start and look at the phone.", title: "Fatigue check?", sub: "10 seconds, on your phone" }] },
        "fatigue.high": {
            warning: [
                { say: "{{detail}}. Please don't ride on yet. Rest for twenty minutes, have some tea, splash water on your face.", title: "High fatigue", sub: "{{detail}}" },
                { say: "Your eyes look very tired. Please don't ride on yet. Rest for twenty minutes, a short nap if you can.", title: "High fatigue", sub: "Rest twenty minutes" }
            ]
        },
        "fatigue.moderate": {
            advice: [
                { say: "Some signs of fatigue: {{detail}}. Rest ten or fifteen minutes more and drink water.", title: "Moderate fatigue", sub: "{{detail}}" },
                { say: "Some signs of fatigue. Rest ten or fifteen minutes more and drink water.", title: "Moderate fatigue", sub: "Rest a bit more" }
            ]
        },
        "fatigue.low": {
            advice: [
                { say: "Few signs of fatigue. You've ridden {{ridingSec|min}}, so drink water before you go, and stop if you feel sleepy.", title: "Low fatigue", sub: "Drink water first" },
                { say: "Few signs of fatigue. Drink water before you go, and stop if you feel sleepy.", title: "Low fatigue", sub: "Stop if sleepy" }
            ]
        },
        "fatigue.retry": { advice: [{ say: "I couldn't see your face clearly. Face the light, lift your visor, and try again?", title: "Face not seen", sub: "Face the light" }] },
        "vision.unavailable": { advice: [{ say: "The camera check didn't work this time. Take your full break anyway.", title: "Check unavailable", sub: "Take the full break" }] },
        "road.hazard": { warning: [{ say: "{{hazard}} in {{distanceM|round}} metres. Slow down.", title: "{{hazard}} ahead", sub: "In {{distanceM|round}} m" }] },
        "traffic.closing-fast": { warning: [{ say: "Careful! {{vehicle}} close ahead. Keep your distance.", title: "{{vehicle}} close ahead", sub: "Gap closing: {{ttcS}} s" }] },
        "traffic.wrong-side": { warning: [{ say: "Careful, a vehicle is coming on the wrong side.", title: "Wrong-side vehicle", sub: "{{vehicle}} ahead" }] },
        "traffic.cutting-in": { warning: [{ say: "Careful, a vehicle is cutting in.", title: "Vehicle cutting in", sub: "{{vehicle}}" }] },
        "perception.degraded": { advice: [{ say: "The road camera AI is limited right now: the phone is hot or the view isn't clear. Keep your own eyes on the road.", title: "Road AI limited", sub: "Phone hot or view unclear" }] },
        "weather.ahead": {
            warning: [{ say: "{{condition}} in {{distanceM|km}}. Slow down and keep a longer gap.", title: "{{condition}} ahead", sub: "In {{distanceM|km}}" }],
            advice: [{ say: "{{condition}} is likely ahead. Keep your rain gear handy.", title: "Weather changing", sub: "{{condition}} ahead" }]
        },
        "rest.stop": { advice: [{ say: "{{place}} is {{distanceM|km}} ahead. Want to stop there?", title: "{{place}}", sub: "In {{distanceM|km}}" }] },
        "*": {
            critical: [{ say: "Careful! Slow down, there's a hazard ahead.", title: "Careful!", sub: "Slow down: hazard ahead" }],
            warning: [{ say: "Heads up. Details are on the screen; check them when you stop.", title: "Heads up", sub: "Check the details when you stop" }],
            advice: [{ say: "There's a tip on the screen for when you stop.", title: "Tip", sub: "For when you stop" }],
            info: [{ say: "Update.", title: "Update", sub: "" }]
        }
    };

    /** @param {{ addPhrases: (style: "desi"|"plain", pack: any) => void }} persona */
    function install(persona) {
        persona.addPhrases("desi", desi);
        persona.addPhrases("plain", plain);
        return persona;
    }

    return { desi, plain, install };
});
