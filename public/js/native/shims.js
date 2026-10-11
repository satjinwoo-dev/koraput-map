"use strict";

/* ============================================================================
   MapUnite client — js/native/shims.js  (Android app only)
   ==============================================================================
   Loaded ONLY in the Capacitor build (scripts/build-native.mjs adds it before
   js/core.js). The Android WebView has none of these browser APIs the app
   relies on, so each is rebuilt on a native Capacitor plugin with the SAME
   shape — the app's own code (VoiceAssistant, MeshtasticLink) runs unchanged:

     window.speechSynthesis / SpeechSynthesisUtterance
         -> @capacitor-community/text-to-speech   (spoken speed alerts, turns)
     window.SpeechRecognition
         -> @capacitor-community/speech-recognition (voice commands)
     navigator.bluetooth (requestDevice, getDevices, GATT read/write/notify)
         -> @capacitor-community/bluetooth-le     (Meshtastic radio link)
     navigator.wakeLock, navigator.share
         -> MapUniteNative (native/android/MapUniteNativePlugin.java)

   The plugins' own browser bundles (dist/plugin.js) are copied to www/vendor/
   and expose capacitorTextToSpeech, capacitorSpeechRecognition and
   capacitorCommunityBluetoothLe; @capacitor/core's bundle exposes
   capacitorExports. Every shim is skipped when its plugin is missing.
   ============================================================================ */

(function () {
    const core = window.capacitorExports;
    const Cap = core && core.Capacitor;
    if (!Cap || typeof Cap.isNativePlatform !== "function" || !Cap.isNativePlatform()) return;
    window.MU_NATIVE = { platform: Cap.getPlatform ? Cap.getPlatform() : "android" };

    // ------------------------------------------------------------------
    // 1. Text to speech -> speechSynthesis
    // ------------------------------------------------------------------
    const TTS = window.capacitorTextToSpeech && window.capacitorTextToSpeech.TextToSpeech;
    if (TTS) {
        const QUEUE_ADD = window.capacitorTextToSpeech.QueueStrategy ? window.capacitorTextToSpeech.QueueStrategy.Add : 1;
        class NativeUtterance {
            constructor(text) { this.text = String(text == null ? "" : text); this.lang = "en-IN"; this.rate = 1; this.pitch = 1; this.volume = 1; this.voice = null; this.onend = null; this.onerror = null; this.onstart = null; }
        }
        const synth = {
            speaking: false, pending: false, paused: false, onvoiceschanged: null,
            _voices: [], _queue: 0, _gen: 0, _listeners: {},
            getVoices() { return this._voices.slice(); },
            speak(u) {
                if (!u || !u.text || !u.text.trim()) { setTimeout(() => u && u.onend && u.onend({}), 0); return; }
                const gen = this._gen;
                this._queue++;
                this.speaking = true;
                this.pending = this._queue > 1;
                const lang = (u.voice && u.voice.lang) || u.lang || "en-IN";
                TTS.speak({ text: u.text, lang, rate: u.rate || 1, pitch: u.pitch || 1, volume: u.volume == null ? 1 : u.volume, queueStrategy: QUEUE_ADD })
                    .then(() => { this._finish(); if (gen === this._gen && u.onend) u.onend({ utterance: u }); })
                    .catch((e) => { this._finish(); if (gen === this._gen && u.onerror) u.onerror({ utterance: u, error: (e && e.message) || "synthesis-failed" }); });
                if (u.onstart) setTimeout(() => u.onstart({ utterance: u }), 0);
            },
            _finish() { this._queue = Math.max(0, this._queue - 1); this.speaking = this._queue > 0; this.pending = this._queue > 1; },
            cancel() {
                // Callbacks of cancelled utterances must not fire (same as the
                // browser's "interrupted" utterances being ignored by the app).
                this._gen++;
                this._queue = 0; this.speaking = false; this.pending = false;
                TTS.stop().catch(() => { /* nothing playing */ });
            },
            pause() { }, resume() { },
            addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
            removeEventListener(ev, fn) { this._listeners[ev] = (this._listeners[ev] || []).filter((f) => f !== fn); },
            _fireVoicesChanged() {
                if (typeof this.onvoiceschanged === "function") { try { this.onvoiceschanged({}); } catch (e) { /* ignore */ } }
                (this._listeners.voiceschanged || []).forEach((fn) => { try { fn({}); } catch (e) { /* ignore */ } });
            }
        };
        // Voices = the installed Android TTS languages. The app prefers en-IN,
        // then hi-IN; each "voice" just carries its language.
        TTS.getSupportedLanguages().then((r) => {
            const langs = (r && Array.isArray(r.languages) ? r.languages : []).map((l) => String(l).replace("_", "-"));
            synth._voices = langs.map((lang) => ({ name: `Android ${lang}`, lang, localService: true, default: lang === "en-IN", voiceURI: `android:${lang}` }));
            synth._fireVoicesChanged();
        }).catch(() => { /* engine missing: speak() falls back to its default language */ });
        Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true, writable: true });
        window.SpeechSynthesisUtterance = NativeUtterance;
    }

    // ------------------------------------------------------------------
    // 2. Speech recognition -> SpeechRecognition (one utterance per start())
    // ------------------------------------------------------------------
    const SR = window.capacitorSpeechRecognition && window.capacitorSpeechRecognition.SpeechRecognition;
    if (SR) {
        let permission = null;              // cached promise
        const ensurePermission = () => {
            if (!permission) {
                permission = SR.checkPermissions()
                    .then((s) => (s && s.speechRecognition === "granted" ? s : SR.requestPermissions()))
                    .then((s) => Boolean(s && s.speechRecognition === "granted"))
                    .catch(() => false);
            }
            return permission;
        };
        class NativeRecognition {
            constructor() { this.lang = "en-IN"; this.continuous = false; this.interimResults = false; this.maxAlternatives = 1; this.onresult = null; this.onerror = null; this.onend = null; this.onstart = null; this._active = false; this._aborted = false; }
            start() {
                if (this._active) throw new Error("InvalidStateError: already started");
                this._active = true; this._aborted = false;
                const end = () => { if (!this._active) return; this._active = false; if (this.onend) this.onend({}); };
                const fail = (error) => { if (!this._aborted && this.onerror) this.onerror({ error }); end(); };
                ensurePermission().then((ok) => {
                    if (!ok) { permission = null; return fail("not-allowed"); }
                    if (this._aborted) return end();
                    if (this.onstart) this.onstart({});
                    return SR.start({ language: this.lang, maxResults: Math.max(1, Math.min(5, this.maxAlternatives || 1)), partialResults: false, popup: false })
                        .then((res) => {
                            if (this._aborted) return end();
                            const matches = (res && Array.isArray(res.matches) ? res.matches : []).filter(Boolean);
                            if (!matches.length) return fail("no-speech");
                            // Same shape as the Web Speech API event the app reads.
                            const alt = matches.map((t, i) => ({ transcript: String(t), confidence: i === 0 ? 0.9 : 0.5 }));
                            const result = Object.assign(alt, { isFinal: true });
                            if (this.onresult) this.onresult({ resultIndex: 0, results: [result] });
                            end();
                        })
                        .catch((e) => {
                            const msg = String((e && e.message) || e || "");
                            // Android's recognizer reports "no match" / speech timeouts as errors: those are normal silence.
                            fail(/no.?match|no.?speech|speech.?timeout|didn.?t understand/i.test(msg) ? "no-speech" : /permission|denied|insufficient/i.test(msg) ? "not-allowed" : /network/i.test(msg) ? "network" : "aborted");
                        });
                });
            }
            stop() { this.abort(); }
            abort() {
                if (!this._active) return;
                this._aborted = true;
                SR.stop().catch(() => { /* not listening */ });
                setTimeout(() => { if (this._active) { this._active = false; if (this.onend) this.onend({}); } }, 0);
            }
        }
        window.SpeechRecognition = NativeRecognition;
        window.webkitSpeechRecognition = NativeRecognition;
    }

    // ------------------------------------------------------------------
    // 3. Bluetooth LE -> navigator.bluetooth (the subset MeshtasticLink uses)
    // ------------------------------------------------------------------
    const BLE = window.capacitorCommunityBluetoothLe && window.capacitorCommunityBluetoothLe.BleClient;
    if (BLE) {
        const KNOWN = "mu_ble_known_devices";
        let initialized = null;
        const init = () => (initialized = initialized || BLE.initialize({ androidNeverForLocation: false }).catch((e) => { initialized = null; throw e; }));
        const toDataView = (v) => {
            if (v instanceof DataView) return v;
            if (ArrayBuffer.isView(v)) return new DataView(v.buffer, v.byteOffset, v.byteLength);
            if (v instanceof ArrayBuffer) return new DataView(v);
            return new DataView(new Uint8Array(v || []).buffer);
        };
        const lower = (u) => String(u).toLowerCase();
        const remember = (id) => {
            try { const l = JSON.parse(localStorage.getItem(KNOWN) || "[]"); if (!l.includes(id)) { l.push(id); localStorage.setItem(KNOWN, JSON.stringify(l.slice(-10))); } } catch (e) { /* ignore */ }
        };
        const devices = new Map();       // deviceId -> ShimDevice

        class Emitter {
            constructor() { this._l = {}; }
            addEventListener(ev, fn) { (this._l[ev] = this._l[ev] || []).push(fn); }
            removeEventListener(ev, fn) { this._l[ev] = (this._l[ev] || []).filter((f) => f !== fn); }
            dispatchEvent(e) { (this._l[e.type] || []).slice().forEach((fn) => { try { fn(e); } catch (x) { console.error(x); } }); return true; }
        }
        class ShimCharacteristic extends Emitter {
            constructor(device, serviceUuid, uuid) { super(); this.device = device; this.serviceUuid = serviceUuid; this.uuid = uuid; this.value = null; this._notifying = false; }
            get service() { return { uuid: this.serviceUuid, device: this.device }; }
            async readValue() { this.value = await BLE.read(this.device.id, this.serviceUuid, this.uuid); return this.value; }
            async writeValue(v) { await BLE.write(this.device.id, this.serviceUuid, this.uuid, toDataView(v)); }
            async writeValueWithResponse(v) { await BLE.write(this.device.id, this.serviceUuid, this.uuid, toDataView(v)); }
            async writeValueWithoutResponse(v) { await BLE.writeWithoutResponse(this.device.id, this.serviceUuid, this.uuid, toDataView(v)); }
            async startNotifications() {
                if (this._notifying) return this;
                await BLE.startNotifications(this.device.id, this.serviceUuid, this.uuid, (dv) => {
                    this.value = dv;
                    this.dispatchEvent({ type: "characteristicvaluechanged", target: this });
                });
                this._notifying = true;
                return this;
            }
            async stopNotifications() { if (this._notifying) { this._notifying = false; await BLE.stopNotifications(this.device.id, this.serviceUuid, this.uuid).catch(() => { }); } return this; }
        }
        class ShimService {
            constructor(device, uuid, charUuids) { this.device = device; this.uuid = uuid; this._chars = charUuids; this._cache = new Map(); }
            async getCharacteristic(uuid) {
                const u = lower(uuid);
                if (!this._chars.includes(u)) { const e = new Error(`No characteristic ${u}`); e.name = "NotFoundError"; throw e; }
                if (!this._cache.has(u)) this._cache.set(u, new ShimCharacteristic(this.device, this.uuid, u));
                return this._cache.get(u);
            }
        }
        class ShimDevice extends Emitter {
            constructor(id, name) {
                super();
                this.id = id; this.name = name || "";
                const dev = this;
                this.gatt = {
                    device: dev, connected: false,
                    async connect() {
                        await init();
                        // Meshtastic radios with a PIN need an Android bond before
                        // their encrypted characteristics can be read (Chrome does
                        // this for Web Bluetooth; bluetooth-le leaves it to us).
                        // Android shows its pairing dialog — the PIN is on the
                        // radio's screen (default 123456). Already bonded: no-op.
                        if (typeof BLE.isBonded === "function" && typeof BLE.createBond === "function") {
                            try { if (!(await BLE.isBonded(dev.id))) await BLE.createBond(dev.id, { timeout: 60000 }); }
                            catch (e) { console.warn("[native] radio pairing:", e && e.message); }   // "No PIN" radios connect anyway
                        }
                        await BLE.connect(dev.id, () => {
                            dev.gatt.connected = false;
                            dev.dispatchEvent({ type: "gattserverdisconnected", target: dev });
                        });
                        dev.gatt.connected = true;
                        return dev.gatt;
                    },
                    disconnect() { dev.gatt.connected = false; BLE.disconnect(dev.id).catch(() => { }); },
                    async getPrimaryService(uuid) {
                        const u = lower(uuid);
                        const services = await BLE.getServices(dev.id);
                        const s = (services || []).find((x) => lower(x.uuid) === u);
                        if (!s) { const e = new Error(`No service ${u}`); e.name = "NotFoundError"; throw e; }
                        return new ShimService(dev, u, (s.characteristics || []).map((c) => lower(c.uuid)));
                    }
                };
            }
        }
        const deviceFor = (d) => {
            if (!devices.has(d.deviceId)) devices.set(d.deviceId, new ShimDevice(d.deviceId, d.name));
            const dev = devices.get(d.deviceId);
            if (d.name) dev.name = d.name;
            return dev;
        };
        const bluetooth = {
            async getAvailability() { try { await init(); return await BLE.isEnabled(); } catch (e) { return false; } },
            // Native chooser (the plugin's device list), filtered like the web API.
            async requestDevice(options = {}) {
                await init();
                const services = [], namePrefixes = [];
                (options.filters || []).forEach((f) => { (f.services || []).forEach((s) => services.push(lower(s))); if (f.namePrefix) namePrefixes.push(f.namePrefix); });
                const req = { optionalServices: (options.optionalServices || []).map(lower) };
                if (services.length) req.services = services;
                if (namePrefixes.length === 1) req.namePrefix = namePrefixes[0];
                let d;
                try { d = await BLE.requestDevice(req); }
                catch (e) { const err = new Error((e && e.message) || "No device selected."); err.name = "NotFoundError"; throw err; }
                remember(d.deviceId);
                return deviceFor(d);
            },
            // Devices picked before (for reconnecting without a chooser).
            async getDevices() {
                await init();
                let ids = [];
                try { ids = JSON.parse(localStorage.getItem(KNOWN) || "[]"); } catch (e) { ids = []; }
                if (!ids.length) return [];
                const list = await BLE.getDevices(ids).catch(() => []);
                return (list || []).map(deviceFor);
            }
        };
        Object.defineProperty(navigator, "bluetooth", { value: bluetooth, configurable: true });
    }

    // ------------------------------------------------------------------
    // 4. Screen Wake Lock + Web Share -> MapUniteNative (our own plugin)
    // ------------------------------------------------------------------
    // The WebView has neither a working navigator.wakeLock (the ride screen
    // would dim and lock) nor navigator.share (invites fall back to copying).
    const Native = typeof core.registerPlugin === "function" ? core.registerPlugin("MapUniteNative") : null;
    if (Native) {
        const holders = new Set();
        const apply = () => Native.keepAwake({ on: holders.size > 0 }).catch(() => { /* older native build */ });
        class NativeWakeLockSentinel {
            constructor() { this.type = "screen"; this.released = false; this.onrelease = null; this._l = []; }
            async release() {
                if (this.released) return;
                this.released = true;
                holders.delete(this);
                await apply();
                const ev = { type: "release", target: this };
                if (typeof this.onrelease === "function") { try { this.onrelease(ev); } catch (e) { /* ignore */ } }
                this._l.forEach((fn) => { try { fn(ev); } catch (e) { /* ignore */ } });
            }
            addEventListener(type, fn) { if (type === "release") this._l.push(fn); }
            removeEventListener(type, fn) { this._l = this._l.filter((f) => f !== fn); }
        }
        const wakeLock = {
            async request(type) {
                if (type && type !== "screen") { const e = new Error("Only 'screen' is supported"); e.name = "NotSupportedError"; throw e; }
                const s = new NativeWakeLockSentinel();
                holders.add(s);
                await apply();
                return s;
            }
        };
        Object.defineProperty(navigator, "wakeLock", { value: wakeLock, configurable: true });
        Object.defineProperty(navigator, "share", {
            configurable: true, writable: true,
            value: (data) => Native.share({ title: (data && data.title) || "", text: (data && data.text) || "", url: (data && data.url) || "" })
                .catch((e) => { const err = new Error((e && e.message) || "Share failed"); err.name = "AbortError"; throw err; })
        });
    }
})();
