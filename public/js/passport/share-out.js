// @ts-check
/* ============================================================================
   MapUnite — sending things out through the phone's own share menu
   ==============================================================================
   MUShareOut.text({ title, text })                         a place, a message
   MUShareOut.image({ blob, fileName, title, text })        a ride recap (image or motion clip), a Passport card
   → { how: "native"|"web"|"copied"|"saved"|"cancelled"|"failed" }

   In the Android app: the MapUniteNative plugin's share() (Android's share
   sheet: WhatsApp, Telegram, Instagram, … whatever is installed; no
   app-specific API or key). In a browser: the Web Share API where it exists;
   otherwise the text is copied, or the image saved. Nothing is uploaded by
   MapUnite: the rider picks the app and the person.
   ============================================================================ */
"use strict";

const MUShareOut = (() => {
    const W = /** @type {any} */ (typeof window !== "undefined" ? window : {});

    /** The native plugin inside the Capacitor app, or null in a browser. */
    function native() {
        const core = W.capacitorExports;
        const Cap = core && core.Capacitor;
        if (!Cap || typeof Cap.isNativePlatform !== "function" || !Cap.isNativePlatform() || typeof core.registerPlugin !== "function") return null;
        try { return core.registerPlugin("MapUniteNative"); } catch (e) { return null; }
    }
    const nav = () => (typeof navigator !== "undefined" ? /** @type {any} */ (navigator) : null);
    const aborted = (/** @type {any} */ e) => e && (e.name === "AbortError" || /cancel/i.test(String(e.message || "")));

    /** Can the phone's share menu be opened here (for text)? */
    function available() { const n = nav(); return Boolean(native() || (n && typeof n.share === "function")); }

    /** @param {{ title?: string, text: string }} o */
    async function text(o) {
        const N = native();
        if (N) {
            try { await N.share({ title: o.title || "Share", text: o.text }); return { how: "native" }; } catch (e) { if (aborted(e)) return { how: "cancelled" }; }
        }
        const n = nav();
        if (n && typeof n.share === "function") {
            try { await n.share({ title: o.title, text: o.text }); return { how: "web" }; } catch (e) { if (aborted(e)) return { how: "cancelled" }; }
        }
        if (n && n.clipboard && typeof n.clipboard.writeText === "function") {
            try { await n.clipboard.writeText(o.text); return { how: "copied" }; } catch (e) { /* blocked */ }
        }
        return { how: "failed" };
    }

    /** @param {Blob} blob @returns {Promise<string>} base64 without the data: prefix */
    function base64(blob) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
            r.onerror = () => reject(r.error);
            r.readAsDataURL(blob);
        });
    }

    /** An image or a short video (a ride recap's motion clip). @param {{ blob: Blob, fileName: string, title?: string, text?: string }} o */
    async function image(o) {
        const N = native();
        const type = (o.blob.type || "image/png").split(";")[0];
        if (N) {
            try { await N.share({ title: o.title || "Share", text: o.text || "", imageBase64: await base64(o.blob), fileName: o.fileName, mimeType: type }); return { how: "native" }; } catch (e) { if (aborted(e)) return { how: "cancelled" }; }
        }
        const n = nav();
        if (n && typeof n.share === "function" && typeof File === "function") {
            const file = new File([o.blob], o.fileName, { type });
            let ok = false;
            try { ok = typeof n.canShare === "function" ? n.canShare({ files: [file] }) : false; } catch (e) { ok = false; }
            if (ok) {
                try { await n.share({ files: [file], title: o.title, text: o.text }); return { how: "web" }; } catch (e) { if (aborted(e)) return { how: "cancelled" }; }
            }
        }
        try {
            const url = URL.createObjectURL(o.blob);
            const a = document.createElement("a");
            a.href = url; a.download = o.fileName;
            document.body.append(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
            return { how: "saved" };
        } catch (e) { return { how: "failed" }; }
    }

    /** What happened, in words for a status line. @param {{ how: string }} r */
    function said(r) {
        return ({ native: "Shared.", web: "Shared.", copied: "Copied. Paste it into WhatsApp or any app.", saved: "Saved to your downloads.", cancelled: "", failed: "Sharing isn't available here." })[r.how] || "";
    }

    return { available, text, image, said, native };
})();

if (typeof window !== "undefined") /** @type {any} */ (window).MUShareOut = MUShareOut;
