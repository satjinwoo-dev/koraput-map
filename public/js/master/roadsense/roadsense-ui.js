// @ts-check
/* ============================================================================
   MapUnite RoadSense Live — the Settings section "Community road reports"
   ==============================================================================
   #roadsense-share-toggle   on/off for sharing AND receiving (off by default)
   #roadsense-status         what's waiting, sent, received and cached
   #roadsense-forget-btn     asks the server to delete everything this phone sent
   #voice-tone-toggle        the voice's tone: Family (off, default) or Rowdy (MUMaster.live.setTone)
   #voice-18-toggle          18+ Rowdy (gaaliyan), off by default, on only after an "are you 18+?" confirm
   Loaded after master-app.js, which provides the "roadsense-sync" capability.
   ============================================================================ */
(function () {
    "use strict";
    const W = /** @type {any} */ (window);
    const live = W.MUMaster && W.MUMaster.live;
    // the voice tone switches (Family / Rowdy / 18+ Rowdy): independent of sharing, so they work even where sync isn't available.
    // 18+ is on top of Rowdy: turning it on turns Rowdy on, turning Rowdy off turns both off.
    const tone = /** @type {HTMLInputElement|null} */ (document.getElementById("voice-tone-toggle"));
    const adult = /** @type {HTMLInputElement|null} */ (document.getElementById("voice-18-toggle"));
    if (tone) {
        if (!live || typeof live.setTone !== "function") { tone.disabled = true; if (adult) adult.disabled = true; }
        else {
            const show = (/** @type {string} */ t) => { tone.checked = t !== "family"; if (adult) adult.checked = t === "rowdy18"; };
            show(live.persona ? live.persona.tone : "family");
            tone.addEventListener("change", () => show(live.setTone(tone.checked ? (adult && adult.checked ? "rowdy18" : "rowdy") : "family")));
            if (adult) adult.addEventListener("change", () => {
                if (adult.checked && !W.confirm("18+ Rowdy uses strong gaaliyan (profanity), spoken out loud. Turn it on only if you are 18 or older. Are you 18+?")) { adult.checked = false; return; }
                show(live.setTone(adult.checked ? "rowdy18" : tone.checked ? "rowdy" : "family"));
            });
        }
    }
    const sync = live && live.caps ? live.caps.get("roadsense-sync") : null;
    const toggle = /** @type {HTMLInputElement|null} */ (document.getElementById("roadsense-share-toggle"));
    const status = document.getElementById("roadsense-status");
    const forget = /** @type {HTMLButtonElement|null} */ (document.getElementById("roadsense-forget-btn"));
    if (!toggle || !status || !forget) return;
    if (!sync) { toggle.disabled = true; forget.disabled = true; status.textContent = "Not available in this version of the app."; return; }

    const ago = (/** @type {number|null} */ t) => {
        if (!t) return "";
        const m = Math.round((Date.now() - t) / 60000);
        return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
    };
    /** @param {any} s */
    function show(s) {
        toggle.checked = Boolean(s.consent);
        if (!s.consent) { status.textContent = "Off. Nothing is shared, and only what this phone felt itself is used."; return; }
        const parts = [`${s.queued} waiting to be shared`, `${s.uploaded} shared this session`];
        if (s.lastUpload) parts.push(`last ${ago(s.lastUpload)}`);
        parts.push(`${s.tilesCached} map areas of other riders' reports kept offline`);
        if (s.backoffUntil > Date.now()) parts.push(`server unreachable, retrying (${s.lastError || "no signal"})`);
        status.textContent = `On. ${parts.join(" · ")}.`;
    }
    show(sync.status());
    sync.onChange(show);
    toggle.addEventListener("change", () => show(sync.setConsent(toggle.checked)));
    forget.addEventListener("click", async () => {
        if (!W.confirm("Delete every road report this phone has shared from the server? Reports from other riders aren't affected.")) return;
        forget.disabled = true;
        const r = await sync.forgetAll();
        forget.disabled = false;
        status.textContent = r.ok ? `Deleted ${r.deleted} report${r.deleted === 1 ? "" : "s"} from the server.` : `Couldn't reach the server (${r.reason}). Try again with signal.`;
    });
})();
