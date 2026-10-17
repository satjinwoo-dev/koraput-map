// @ts-check
/* ============================================================================
   MapUnite RoadSense Live — the Settings section "Community road reports"
   ==============================================================================
   #roadsense-share-toggle   on/off for sharing AND receiving (off by default)
   #roadsense-status         what's waiting, sent, received and cached
   #roadsense-forget-btn     asks the server to delete everything this phone sent
   #voice-tone-toggle        the voice's tone: Family (off, default) or Rowdy (MUMaster.live.setTone)
   Loaded after master-app.js, which provides the "roadsense-sync" capability.
   ============================================================================ */
(function () {
    "use strict";
    const W = /** @type {any} */ (window);
    const live = W.MUMaster && W.MUMaster.live;
    // the voice tone switch (Family / Rowdy): independent of sharing, so it works even where sync isn't available
    const tone = /** @type {HTMLInputElement|null} */ (document.getElementById("voice-tone-toggle"));
    if (tone) {
        if (!live || typeof live.setTone !== "function") tone.disabled = true;
        else {
            tone.checked = live.persona && live.persona.tone === "rowdy";
            tone.addEventListener("change", () => { tone.checked = live.setTone(tone.checked ? "rowdy" : "family") === "rowdy"; });
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
