// @ts-check
/* ============================================================================
   MapUnite Master AI — phrase pack for the cognitive engines
   ==============================================================================
   The words for the 2 km radar, places, Deep Search, destination safety and
   music agents. Same rules as phrases-desi.js (read its header): desi lines are
   SPOKEN only, plain lines are English and always what the SCREEN shows; every
   kind has both. master-app.js installs this pack after the base one, so a
   kind that exists in both (weather.ahead, rest.stop) just gets more lines.

   Two placeholders this pack relies on:
     {{now}}        the agent sets data.now = "abhi" (screen: "Now") for weather
                    that is HERE; a line with {{now}} is skipped for weather ahead,
                    and a line with {{distanceM|km}} is skipped for weather here.
     {{x}} + data.screen.x   Hinglish word spoken, English word on screen
                    (e.g. data.dir = "utraai", data.screen.dir = "descent").

   WORDS also exports the small vocabularies agents need (condition names,
   reasons), so an agent never hard-codes a sentence.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else {
        const M = /** @type {any} */ (root).MUMaster || (/** @type {any} */ (root).MUMaster = {});
        const pack = factory();
        M.phrasesRadar = pack;
        (M.phrasePacks || (M.phrasePacks = [])).push(pack);
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    /** Vocabulary the agents put into data / data.screen. */
    const WORDS = Object.freeze({
        hazard: {
            storm: { desi: "toofan aur bijli", plain: "Thunderstorm" },
            "heavy-rain": { desi: "tez baarish", plain: "Heavy rain" },
            rain: { desi: "baarish", plain: "Rain" },
            drizzle: { desi: "boonda-baandi", plain: "Drizzle" },
            freezing: { desi: "barf aur jamaav", plain: "Ice or snow" },
            fog: { desi: "ghana kohra", plain: "Fog" },
            wind: { desi: "tez hawa", plain: "Strong wind" },
            heat: { desi: "bahut garmi", plain: "Extreme heat" },
            cold: { desi: "kadaake ki thand", plain: "Severe cold" },
            dust: { desi: "dhool aur dhuaan", plain: "Dust" },
            dry: { desi: "sookhi garam hawa", plain: "Very dry air" },
            "rain-soon": { desi: "baarish", plain: "Rain" }
        },
        osmHazard: {
            dangerous_junction: { desi: "khatarnak chauraha", plain: "Dangerous junction" },
            curve: { desi: "tez mod", plain: "Sharp bend" },
            curves: { desi: "lagatar mod", plain: "Series of bends" },
            landslide: { desi: "landslide wala ilaaka", plain: "Landslide zone" },
            falling_rocks: { desi: "patthar girne wala ilaaka", plain: "Falling rocks" },
            animal_crossing: { desi: "jaanwar crossing", plain: "Animal crossing" },
            cattle: { desi: "sadak pe gaay-bhains", plain: "Cattle on road" },
            school_zone: { desi: "school zone", plain: "School zone" },
            flooding: { desi: "paani bharne wali jagah", plain: "Flood-prone stretch" },
            ice: { desi: "fislan", plain: "Icy stretch" },
            "*": { desi: "khatra", plain: "Road hazard" }
        },
        category: {
            hospital: { desi: "hospital", plain: "Hospital" },
            mechanic: { desi: "mechanic", plain: "Mechanic" },
            service: { desi: "service center", plain: "Service centre" },
            hotel: { desi: "hotel", plain: "Hotel" },
            food: { desi: "dhaba", plain: "Food stop" }
        },
        reason: {
            dark: { desi: "pahunchte pahunchte andhera ho jayega", plain: "you'll arrive after dark" },
            dusk: { desi: "shaam dhalte pahunchoge", plain: "you'll arrive at dusk" },
            blackspots: { desi: "wahan aas-paas accident blackspot hain", plain: "there are accident blackspots nearby" },
            "hospital-far": { desi: "hospital kaafi door hai", plain: "the nearest hospital is far" },
            "police-far": { desi: "police station paas mein nahi hai", plain: "there's no police station close by" },
            remote: { desi: "jagah kaafi sunsaan hai", plain: "it's a remote spot" },
            "long-ride": { desi: "lamba safar hai, thakaan hogi", plain: "it's a long ride, you'll be tired" },
            weather: { desi: "wahan mausam kharab rahega", plain: "the weather there looks bad" }
        },
        mood: {
            happy: { desi: "mast", plain: "happy" }, energetic: { desi: "josh wala", plain: "energetic" }, romantic: { desi: "romantic", plain: "romantic" },
            chill: { desi: "chill", plain: "chilled" }, sad: { desi: "thoda udaas", plain: "a bit low" }, devotional: { desi: "bhakti wala", plain: "devotional" },
            intense: { desi: "full power", plain: "intense" }
        },
        side: { left: { desi: "left", plain: "left" }, right: { desi: "right", plain: "right" } },
        ghat: { descent: { desi: "utraai", plain: "descent" }, climb: { desi: "chadhaai", plain: "climb" }, steep: { desi: "tez dhalaan", plain: "steep slope" } },
        bridgeWhy: { wet: { desi: "geela pul fislan wala hota hai", plain: "wet bridge decks are slippery" }, wind: { desi: "pul pe hawa side se dhakka degi", plain: "expect crosswinds on the bridge" } }
    });

    const desi = {
        // ---------------------------------------------------------------- link agent
        "network.degrading": {
            advice: [
                { say: "{{name}}, signal girta ja raha hai, thodi der mein ja sakta hai. Kisi ko update bhejna hai toh ruk ke abhi bhej de." },
                { say: "Network kamzor hota ja raha hai {{name}}. Route saved hai, bas zaroori message ho toh pehle ruk ke bhej de." }
            ]
        },
        "network.slow": {
            advice: [{ say: "{{name}}, net chal raha hai par bahut dheema. Live cheezein late aayengi, ghabrana mat." }]
        },

        // ---------------------------------------------------------------- weather agent (one kind per hazard)
        "weather.storm": {
            warning: [
                { say: "{{name}}, {{distanceM|km}} aage toofan aur bijli hai. Kisi pakki chhat ke neeche ruk jaa, ped ke neeche nahi." },
                { say: "{{name}}, {{now}} yahan bijli gir rahi hai. Safe jagah dekh ke ruk ja, khule mein mat khada ho." }
            ]
        },
        "weather.heavy-rain": {
            warning: [
                { say: "{{name}}, {{distanceM|km}} aage tez baarish hai. Speed kam kar, brake halke haath se, aur gap double rakh." },
                { say: "{{name}}, {{now}} tez baarish ho rahi hai. Dheere chala, white patti aur gaddhon se bach ke." }
            ]
        },
        "weather.rain": {
            advice: [
                { say: "{{name}}, {{distanceM|km}} aage baarish hai. Raincoat nikaal le, sadak fislan wali hogi." },
                { say: "{{name}}, {{now}} halki baarish hai. Thoda dheere, mod pe lean kam." }
            ]
        },
        "weather.drizzle": {
            advice: [
                { say: "{{name}}, {{distanceM|km}} aage boonda-baandi hai. Pehli baarish mein sadak sabse zyada fisalti hai, sambhal ke." },
                { say: "{{name}}, {{now}} boonda-baandi hai. Sadak pe tel ubhar aata hai, aaram se." }
            ]
        },
        "weather.freezing": {
            warning: [
                { say: "{{name}}, {{distanceM|km}} aage barf ya jamaav hai. Bahut dheere, koi achanak brake nahi." },
                { say: "{{name}}, {{now}} sadak pe jamaav ho sakta hai. Pul aur chhaanv wali jagah sabse khatarnak, dheere." }
            ]
        },
        "weather.fog": {
            warning: [
                { say: "{{name}}, {{distanceM|km}} aage ghana kohra hai. Low beam on, speed kam, aage wale ki tail light pakad ke chal." },
                { say: "{{name}}, {{now}} kohra bahut ghana hai. Hazard light on kar, aur zaroorat ho toh side mein ruk ja." }
            ],
            advice: [
                { say: "{{name}}, {{distanceM|km}} aage kohra hai. Light on rakh aur speed thodi kam." },
                { say: "{{name}}, {{now}} kohra hai. Light on rakh, dheere chala." }
            ]
        },
        "weather.wind": {
            warning: [
                { say: "{{name}}, {{distanceM|km}} aage bahut tez hawa hai. Tank ko ghutno se pakad, truck ke paas se nikalte waqt sambhal ke." },
                { say: "{{name}}, {{now}} tez hawa chal rahi hai. Speed kam kar, bike ko dhakka lagega." }
            ],
            advice: [
                { say: "{{name}}, {{distanceM|km}} aage hawa tez hai. Handle dheela pakad, ghutno se grip." },
                { say: "{{name}}, {{now}} hawa tez hai. Khule raste pe dhyan rakh." }
            ]
        },
        "weather.heat": {
            warning: [
                { say: "{{name}}, {{distanceM|km}} aage bahut garmi hai. Har aadhe ghante paani pi, chhaon mein break le, loo se bach." },
                { say: "{{name}}, {{now}} bahut garmi hai, loo lag sakti hai. Agle chhaon wale spot pe ruk ke paani pi." }
            ],
            advice: [
                { say: "{{name}}, {{distanceM|km}} aage garmi badh rahi hai. Paani ki bottle bhar ke rakh." },
                { say: "{{name}}, {{now}} garmi kaafi hai. Paani peete rehna." }
            ]
        },
        "weather.cold": {
            advice: [
                { say: "{{name}}, {{distanceM|km}} aage kadaake ki thand hai. Gloves pehan le, pul pe jamaav ho sakta hai." },
                { say: "{{name}}, {{now}} bahut thand hai. Haath sun ho jaate hain, brake late lagta hai, dhyan rakh." }
            ]
        },
        "weather.dust": {
            warning: [
                { say: "{{name}}, {{distanceM|km}} aage bahut dhool hai. Visor neeche, mask pehan, aur speed kam." },
                { say: "{{name}}, {{now}} hawa mein bahut dhool hai. Mask pehan le, aur dikhna band ho toh ruk ja." }
            ],
            advice: [
                { say: "{{name}}, {{distanceM|km}} aage dhool hai. Visor neeche kar le." },
                { say: "{{name}}, {{now}} dhool hai. Mask aur visor laga ke chal." }
            ]
        },
        "weather.dry": {
            advice: [
                { say: "{{name}}, {{distanceM|km}} aage hawa bahut sookhi aur garam hai. Pyaas na lage tab bhi paani pi." },
                { say: "{{name}}, {{now}} hawa bahut sookhi hai. Thoda thoda paani peete reh." }
            ]
        },
        "weather.rain-soon": {
            advice: [
                { say: "{{name}}, ghante bhar mein baarish ke poore chances hain. Raincoat upar rakh le." },
                { say: "{{name}}, baarish aane wali hai. Phone aur papers plastic mein daal de, ruk ke." }
            ]
        },
        "weather.ahead": {
            advice: [{ say: "{{name}}, aage mausam badal raha hai, {{condition}} ho sakti hai. Tayyaar reh." }]
        },

        // ---------------------------------------------------------------- traffic agent
        "traffic.jam-ahead": {
            warning: [
                { say: "{{name}}, {{distanceM|km}} aage jam hai, karib {{delayMin}} minute lagenge. Gaadiyon ke beech zigzag mat karna." },
                { say: "Heads up {{name}}, {{distanceM|km}} aage traffic ruka hua hai. Aaram se, line mein." }
            ],
            advice: [
                { say: "{{name}}, {{distanceM|km}} aage jam hai, {{delayMin}} minute extra lagenge. Chai break abhi le lein?" },
                { say: "{{name}}, aage {{distanceM|km}} pe traffic jam hai. Tension mat le, safe chal." }
            ]
        },
        "traffic.slow-ahead": {
            advice: [{ say: "{{name}}, {{distanceM|km}} aage traffic dheema hai. Pehle se speed kam kar le." }]
        },
        "traffic.closure-ahead": {
            warning: [
                { say: "{{name}}, {{distanceM|km}} aage sadak band hai. Ruk ke doosra raasta dekh lete hain." },
                { say: "Dhyan de {{name}}, {{distanceM|km}} aage road closed hai. Safe jagah ruk, route badalte hain." }
            ]
        },

        // ---------------------------------------------------------------- terrain agent
        "terrain.ghat-ahead": {
            warning: [
                { say: "{{name}}, {{distanceM|km}} aage ghat ki {{dir}} hai, {{gradePct}} percent. Neeche gear mein chal, brake ko pump kar, lagatar mat daba." },
                { say: "Ghat aa raha hai {{name}}, {{distanceM|km}} aage. Lower gear, engine brake, aur mod pe overtaking bilkul nahi." }
            ],
            advice: [
                { say: "{{name}}, {{distanceM|km}} aage {{dir}} shuru hoti hai, {{gradePct}} percent. Gear sahi rakh." },
                { say: "{{name}}, aage {{distanceM|km}} pe ghat wala raasta hai. Aaram se chadhaayi-utraai." }
            ]
        },
        "terrain.valley-edge": {
            advice: [
                { say: "{{name}}, {{distanceM|km}} aage {{side}} side gehri khai hai. Kinare se door, apni lane mein reh, mod pe overtaking nahi." },
                { say: "Dhyan de {{name}}, {{distanceM|km}} aage {{side}} taraf valley ka khula kinara hai. Speed control mein rakh." }
            ]
        },
        "terrain.hairpins": {
            warning: [
                { say: "{{name}}, {{distanceM|km}} aage {{count}} hairpin mod hain. Mod se pehle hi speed kam, apni lane mein reh, horn de ke." },
                { say: "Dhyan se {{name}}, aage lagatar tez mod hain. Blind mod pe bilkul beech mein mat aana." }
            ]
        },
        "road.breaker-ahead": {
            advice: [
                { say: "{{name}}, {{distanceM|round}} metre aage speed breaker hai." },
                { say: "Breaker aa raha hai {{name}}, {{distanceM|round}} metre pe. Dheere." }
            ]
        },
        "road.level-crossing": {
            warning: [
                { say: "{{name}}, {{distanceM|round}} metre aage railway crossing hai. Phaatak band ho toh ruk, patri pe tyre seedha rakh." },
                { say: "Railway crossing aa raha hai {{name}}. Dono taraf dekh ke, dheere se paar." }
            ]
        },
        "road.bad-surface": {
            advice: [
                { say: "{{name}}, {{distanceM|km}} aage karib {{lengthM|km}} kharab sadak hai. Speed kam, khade ho ke chala sakta hai." },
                { say: "Aage kachcha ya toota raasta hai {{name}}. Aaram se, gaddhe dekh ke." }
            ]
        },
        "road.bridge-ahead": {
            advice: [{ say: "{{name}}, {{distanceM|km}} aage lamba pul hai, {{why}}. Dheere aur seedha." }]
        },
        "road.osm-hazard": {
            warning: [
                { say: "{{name}}, {{distanceM|round}} metre aage {{hazard}} hai. Dheere kar." },
                { say: "Dhyan se {{name}}, aage {{hazard}} hai, {{distanceM|round}} metre pe." }
            ]
        },

        // ---------------------------------------------------------------- blackspot agent
        "blackspot.ahead": {
            warning: [
                { say: "{{name}}, {{distanceM|km}} aage accident blackspot hai, yahan {{fatalities}} log jaan gawa chuke hain. Speed kam, overtaking nahi." },
                { say: "{{name}}, aage {{distanceM|km}} pe accident wali jagah hai. Bahut dhyan se, speed kam rakh." },
                { say: "Blackspot aa raha hai {{name}}, {{distanceM|km}} aage. Dono haath handle pe, nazar door tak." }
            ]
        },

        // ---------------------------------------------------------------- the reasoning layer (cognition.js)
        "radar.compound": {
            warning: [
                { say: "{{name}}, aage {{first}} bhi hai aur {{second}} bhi. Dono saath mein khatarnak hain, speed bahut kam rakh." },
                { say: "Dhyan de {{name}}, {{distanceM|km}} aage {{first}}, upar se {{second}}. Aaram se, koi jaldi nahi." }
            ]
        },

        // ---------------------------------------------------------------- poi agent
        "rest.stop": {
            advice: [
                { say: "{{name}}, {{distanceM|km}} aage {{place}} hai, log achha bolte hain. Wahan chai ke liye rukte hain?" },
                { say: "Bhook lagi {{name}}? {{distanceM|km}} aage {{place}} hai, reviews badhiya hain." }
            ]
        },
        "poi.nearest": {
            advice: [
                { say: "{{name}}, sabse achha {{category}} {{place}} hai, {{distanceM|km}} door. Number aur raasta screen pe hai, ruk ke dekh le." },
                { say: "{{place}}, {{distanceM|km}} pe. {{name}}, number screen pe daal diya, ruk ke call kar lena." }
            ]
        },
        "poi.none": {
            advice: [{ say: "{{name}}, abhi aas-paas koi achha {{category}} nahi mila. Thoda aage chal ke dobara dekhta hoon." }]
        },
        "poi.emergency": {
            warning: [
                { say: "{{name}}, sabse paas hospital {{place}} hai, {{distanceM|km}} door. Haalat kharab hai toh pehle 112 pe call kar." },
                { say: "Ghabra mat {{name}}. {{place}} {{distanceM|km}} pe hai. Zaroorat ho toh 112 dial kar, raasta screen pe hai." }
            ]
        },

        // ---------------------------------------------------------------- destination agent
        "destination.good": {
            advice: [{ say: "{{name}}, {{destination}} ka scene theek hai. Aaram se chalo, main saath hoon." }]
        },
        "destination.care": {
            advice: [
                { say: "{{name}}, {{destination}} ke baare mein ek baat, {{reason}}. Thoda plan karke chalte hain." },
                { say: "{{name}}, {{destination}} pahunchne se pehle dhyan rakhna, {{reason}}." }
            ]
        },
        "destination.caution": {
            advice: [
                { say: "{{name}}, {{destination}} ko le ke thoda alert reh, {{reason}}. Jaldi nikal sake toh better, aur ghar pe location share kar de." },
                { say: "{{name}}, sach bolun toh {{destination}} pe {{reason}}. Ruk ke kisi ko live location bhej de, phir chalein." }
            ]
        },

        // ---------------------------------------------------------------- mood agent
        "music.suggest": {
            advice: [
                { say: "{{name}}, mood {{mood}} lag raha hai. Agla gaana {{song}} lagaun?" },
                { say: "{{name}}, is mood mein {{song}} mast chalega. Bolo toh agla wahi?" }
            ]
        },
        "music.energise": {
            advice: [
                { say: "{{name}}, gaane thode sust chal rahe hain aur safar lamba hai. Kuch josh wala lagaun, jaise {{song}}?" },
                { say: "Neend bhagani hai {{name}}? {{song}} jaisa kuch tez lagaate hain. Par neend aa rahi ho toh pehle break." }
            ]
        },
        "music.calm": {
            advice: [{ say: "{{name}}, thoda tension wala raasta hai. Kuch shaant sa lagaun, jaise {{song}}?" }]
        },
        "music.access-needed": {
            advice: [{ say: "{{name}}, gaane pehchaanne ke liye phone ki settings mein ek baar notification access dena hoga. Ruk ke screen pe dekh lena." }]
        },

        // ---------------------------------------------------------------- deep search
        "search.failed": {
            advice: [
                { say: "{{name}}, abhi iska pakka jawaab nahi mila. Network aate hi phir se dhoondhta hoon." },
                { say: "Sorry {{name}}, search nahi ho paaya. Thodi der mein dobara poochna." }
            ]
        }
    };

    const plain = {
        "network.degrading": { advice: [{ say: "The signal is fading and may drop soon. If you need to message anyone, stop and do it now.", title: "Signal fading", sub: "Send messages now, after stopping" }] },
        "network.slow": { advice: [{ say: "The connection is very slow. Live updates will lag.", title: "Slow connection", sub: "Live updates may lag" }] },
        "weather.storm": { warning: [
            { say: "Thunderstorm in {{distanceM|km}}. Shelter under a solid roof, not a tree.", title: "Thunderstorm ahead", sub: "In {{distanceM|km}}" },
            { say: "{{now}}: lightning here. Stop somewhere safe; don't stand in the open.", title: "Thunderstorm", sub: "Lightning here: shelter" }
        ] },
        "weather.heavy-rain": { warning: [
            { say: "Heavy rain in {{distanceM|km}}. Slow down, brake gently, double your gap.", title: "Heavy rain ahead", sub: "In {{distanceM|km}}" },
            { say: "{{now}}: heavy rain. Ride slowly; avoid road paint and potholes.", title: "Heavy rain", sub: "Slow down" }
        ] },
        "weather.rain": { advice: [
            { say: "Rain in {{distanceM|km}}. Put your rain gear on; the road will be slippery.", title: "Rain ahead", sub: "In {{distanceM|km}}" },
            { say: "{{now}}: light rain. Ease off and lean less in corners.", title: "Rain", sub: "Lean less in corners" }
        ] },
        "weather.drizzle": { advice: [
            { say: "Drizzle in {{distanceM|km}}. The first rain is the most slippery.", title: "Drizzle ahead", sub: "In {{distanceM|km}}" },
            { say: "{{now}}: drizzle. Oil lifts off the road; take it easy.", title: "Drizzle", sub: "Slippery road" }
        ] },
        "weather.freezing": { warning: [
            { say: "Ice or snow in {{distanceM|km}}. Very slow, no sudden braking.", title: "Ice ahead", sub: "In {{distanceM|km}}" },
            { say: "{{now}}: possible ice. Bridges and shade are the worst; go slow.", title: "Possible ice", sub: "Bridges and shade worst" }
        ] },
        "weather.fog": {
            warning: [
                { say: "Dense fog in {{distanceM|km}}. Low beam, slow down, follow tail lights.", title: "Dense fog ahead", sub: "In {{distanceM|km}}" },
                { say: "{{now}}: dense fog. Hazard lights on; pull over if needed.", title: "Dense fog", sub: "Hazard lights on" }
            ],
            advice: [
                { say: "Fog in {{distanceM|km}}. Lights on, a little slower.", title: "Fog ahead", sub: "In {{distanceM|km}}" },
                { say: "{{now}}: fog. Lights on, ride slower.", title: "Fog", sub: "Lights on" }
            ]
        },
        "weather.wind": {
            warning: [
                { say: "Very strong wind in {{distanceM|km}}. Grip the tank with your knees; careful passing trucks.", title: "Strong wind ahead", sub: "In {{distanceM|km}}" },
                { say: "{{now}}: very strong wind. Slow down; the bike will be pushed.", title: "Strong wind", sub: "Slow down" }
            ],
            advice: [
                { say: "Gusty wind in {{distanceM|km}}. Relax your grip, hold with your knees.", title: "Wind ahead", sub: "In {{distanceM|km}}" },
                { say: "{{now}}: gusty wind. Careful on open stretches.", title: "Gusty wind", sub: "Open stretches" }
            ]
        },
        "weather.heat": {
            warning: [
                { say: "Extreme heat in {{distanceM|km}}. Drink every half hour and rest in shade.", title: "Extreme heat ahead", sub: "In {{distanceM|km}}" },
                { say: "{{now}}: extreme heat; heatstroke risk. Stop in shade and drink water.", title: "Extreme heat", sub: "Rest in shade, drink" }
            ],
            advice: [
                { say: "It gets hot in {{distanceM|km}}. Fill your water bottle.", title: "Heat ahead", sub: "In {{distanceM|km}}" },
                { say: "{{now}}: it's hot. Keep drinking water.", title: "Hot", sub: "Keep drinking" }
            ]
        },
        "weather.cold": { advice: [
            { say: "Severe cold in {{distanceM|km}}. Gloves on; bridges may ice.", title: "Cold ahead", sub: "In {{distanceM|km}}" },
            { say: "{{now}}: very cold. Numb hands brake late; take care.", title: "Very cold", sub: "Numb hands brake late" }
        ] },
        "weather.dust": {
            warning: [
                { say: "Heavy dust in {{distanceM|km}}. Visor down, mask on, slow down.", title: "Dust ahead", sub: "In {{distanceM|km}}" },
                { say: "{{now}}: heavy dust. Mask on; stop if you can't see.", title: "Heavy dust", sub: "Stop if you can't see" }
            ],
            advice: [
                { say: "Dust in {{distanceM|km}}. Close your visor.", title: "Dust ahead", sub: "In {{distanceM|km}}" },
                { say: "{{now}}: dusty air. Mask and visor.", title: "Dusty", sub: "Mask and visor" }
            ]
        },
        "weather.dry": { advice: [
            { say: "Very dry, hot air in {{distanceM|km}}. Drink even if you're not thirsty.", title: "Dry air ahead", sub: "In {{distanceM|km}}" },
            { say: "{{now}}: very dry air. Sip water often.", title: "Very dry air", sub: "Sip water often" }
        ] },
        "weather.ahead": { advice: [{ say: "The weather is changing ahead: {{condition}} is possible.", title: "Weather changing", sub: "{{condition}} ahead" }] },
        "weather.rain-soon": { advice: [{ say: "Rain is likely within the hour. Keep your rain gear on top.", title: "Rain likely soon", sub: "Within the hour" }] },
        "traffic.jam-ahead": {
            warning: [{ say: "Traffic jam in {{distanceM|km}}, about {{delayMin}} minutes. Don't weave between vehicles.", title: "Jam ahead", sub: "In {{distanceM|km}} · +{{delayMin}} min" }],
            advice: [{ say: "Traffic jam in {{distanceM|km}}, about {{delayMin}} extra minutes.", title: "Jam ahead", sub: "In {{distanceM|km}} · +{{delayMin}} min" }]
        },
        "traffic.slow-ahead": { advice: [{ say: "Slow traffic in {{distanceM|km}}. Ease off early.", title: "Slow traffic ahead", sub: "In {{distanceM|km}}" }] },
        "traffic.closure-ahead": { warning: [{ say: "The road is closed in {{distanceM|km}}. Stop safely and we'll find another way.", title: "Road closed ahead", sub: "In {{distanceM|km}}" }] },
        "terrain.ghat-ahead": {
            warning: [{ say: "Steep {{dir}} in {{distanceM|km}}, {{gradePct}} percent. Low gear, engine braking, don't ride the brakes.", title: "Steep ghat ahead", sub: "{{gradePct}}% {{dir}} in {{distanceM|km}}" }],
            advice: [{ say: "A {{dir}} starts in {{distanceM|km}}, {{gradePct}} percent.", title: "Ghat road ahead", sub: "{{gradePct}}% {{dir}} in {{distanceM|km}}" }]
        },
        "terrain.valley-edge": { advice: [{ say: "Steep drop on your {{side}} in {{distanceM|km}}. Keep away from the edge and don't overtake on bends.", title: "Valley edge ahead", sub: "Drop on the {{side}} · in {{distanceM|km}}" }] },
        "terrain.hairpins": { warning: [{ say: "{{count}} hairpin bends in {{distanceM|km}}. Slow before each bend, stay in your lane, use the horn.", title: "Hairpin bends ahead", sub: "{{count}} bends in {{distanceM|km}}" }] },
        "road.breaker-ahead": { advice: [{ say: "Speed breaker in {{distanceM|round}} metres.", title: "Speed breaker", sub: "In {{distanceM|round}} m" }] },
        "road.level-crossing": { warning: [{ say: "Railway crossing in {{distanceM|round}} metres. Stop if the gate is down; cross the rails straight.", title: "Railway crossing", sub: "In {{distanceM|round}} m" }] },
        "road.bad-surface": { advice: [{ say: "About {{lengthM|km}} of bad road in {{distanceM|km}}. Slow down.", title: "Bad road ahead", sub: "{{lengthM|km}} from {{distanceM|km}}" }] },
        "road.bridge-ahead": { advice: [{ say: "Long bridge in {{distanceM|km}}: {{why}}. Slow and straight.", title: "Bridge ahead", sub: "{{why}}" }] },
        "road.osm-hazard": { warning: [{ say: "{{hazard}} in {{distanceM|round}} metres. Slow down.", title: "{{hazard}}", sub: "In {{distanceM|round}} m" }] },
        "blackspot.ahead": { warning: [
            { say: "Accident blackspot in {{distanceM|km}}: {{fatalities}} deaths recorded here. Slow down, no overtaking.", title: "Accident blackspot", sub: "In {{distanceM|km}} · {{fatalities}} deaths recorded" },
            { say: "Accident blackspot in {{distanceM|km}}. Slow down, no overtaking.", title: "Accident blackspot", sub: "In {{distanceM|km}}" }
        ] },
        "radar.compound": { warning: [{ say: "{{first}} and {{second}} ahead together. Slow right down.", title: "{{first}} + {{second}}", sub: "In {{distanceM|km}}" }] },
        "rest.stop": { advice: [{ say: "{{place}}, well reviewed, is {{distanceM|km}} ahead. Stop there?", title: "{{place}}", sub: "Well reviewed · {{distanceM|km}} ahead" }] },
        "poi.nearest": { advice: [{ say: "Best {{category}} nearby: {{place}}, {{distanceM|km}} away. Number and directions are on screen.", title: "{{place}}", sub: "{{category}} · {{distanceM|km}}" }] },
        "poi.none": { advice: [{ say: "No good {{category}} found nearby yet. I'll keep looking.", title: "Nothing nearby yet", sub: "{{category}}" }] },
        "poi.emergency": { warning: [{ say: "Nearest hospital: {{place}}, {{distanceM|km}} away. If it's serious, call 112 first.", title: "{{place}}", sub: "Hospital · {{distanceM|km}} · Emergency: 112" }] },
        "destination.good": { advice: [{ say: "{{destination}} looks fine for your arrival.", title: "Destination check", sub: "{{destination}}: looks fine" }] },
        "destination.care": { advice: [{ say: "One thing about {{destination}}: {{reason}}. Plan for it.", title: "Destination check", sub: "{{destination}}: {{reason}}" }] },
        "destination.caution": { advice: [{ say: "Take care with {{destination}}: {{reason}}. Leave earlier if you can and share your live location.", title: "Destination: take care", sub: "{{reason}}" }] },
        "music.suggest": { advice: [{ say: "Your music sounds {{mood}}. Play {{song}} next?", title: "Next song?", sub: "{{song}}" }] },
        "music.energise": { advice: [{ say: "The music's getting slow and the ride is long. Something upbeat, like {{song}}? If you're sleepy, take a break first.", title: "Something upbeat?", sub: "{{song}}" }] },
        "music.calm": { advice: [{ say: "Tense stretch. Something calmer, like {{song}}?", title: "Something calmer?", sub: "{{song}}" }] },
        "music.access-needed": { advice: [{ say: "To recognise your music, allow notification access once in the phone's settings. Check the screen when you stop.", title: "Allow notification access", sub: "Settings → Notification access" }] },
        "search.failed": { advice: [{ say: "I couldn't find a reliable answer right now. I'll try again when the network is back.", title: "No answer yet", sub: "Try again shortly" }] }
    };

    /** @param {{ addPhrases: (style: "desi"|"plain", pack: any) => void }} persona */
    function install(persona) {
        persona.addPhrases("desi", desi);
        persona.addPhrases("plain", plain);
        return persona;
    }

    return { desi, plain, install, WORDS };
});
