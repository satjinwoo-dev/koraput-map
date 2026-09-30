"use strict";

/* ============================================================================
   MapUnite client — js/pwa.js
   ==============================================================================
   The install-app button (service worker registration lives in shell.js).

   Classic scripts sharing one global scope (no bundler, no build step),
   loaded by index.html in this order: core → voice → gps → navigation → smartdrive → groupnav → privacy → analytics → deadreckoning → presence → controls → chat → memories → calls → sos → pwa → skunkworks → radio → convoy → boot.
   ============================================================================ */

// ==========================================
// PWA INSTALL BUTTON  (registration itself lives in shell.js now)
// ==========================================
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const installBtn = $("install-app-btn");
    if (installBtn) installBtn.style.display = 'flex';
});

window.addEventListener('DOMContentLoaded', () => {
    const installBtn = $("install-app-btn");
    if (installBtn) {
        installBtn.onclick = async () => {
            if (deferredPrompt) {
                deferredPrompt.prompt();
                const { outcome } = await deferredPrompt.userChoice;
                if (outcome === 'accepted') installBtn.style.display = 'none';
                deferredPrompt = null;
            }
        };
    }
    if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true) {
        if (installBtn) installBtn.style.display = 'none';
    }
});

window.addEventListener('appinstalled', () => { const installBtn = $("install-app-btn"); if (installBtn) installBtn.style.display = 'none'; });
