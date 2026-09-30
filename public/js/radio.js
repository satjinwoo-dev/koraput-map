"use strict";

/* ============================================================================
   MapUnite client — js/radio.js
   ==============================================================================
   Offline radio (Phase 4): the radio radar, the Meshtastic Bluetooth link and
   the encrypted convoy relay.

   Classic scripts sharing one global scope (no bundler, no build step),
   loaded by index.html in this order: core → voice → gps → navigation → smartdrive → groupnav → privacy → analytics → deadreckoning → presence → controls → chat → memories → calls → sos → pwa → skunkworks → radio → convoy → boot.
   ============================================================================ */

// ============================================================================
// 2. RADIO RADAR (Phase 4) — the old "P2P Radar", now real
// ============================================================================
// Phase 2 left this honestly labelled: Web Bluetooth could find "a Bluetooth
// device", not other riders. Phase 4 makes it real (see sections 7–8): pair
// a Meshtastic LoRa radio and this panel shows riders heard OVER THE RADIO —
// real distance and bearing from their own encrypted position frames — next
// to riders known via the network, each labelled with how we know. The
// canvas is a north-up radar of both; the list below it carries the same
// information as text (the canvas is aria-hidden).
const P2PRadar = {
    isOpen: false,

    init() {
        const radarBtn = document.getElementById("p2p-radar-btn");
        const panel = document.getElementById("radar-panel");
        const closeRadar = document.getElementById("close-radar");
        if (!radarBtn || !panel) return;
        this.panel = panel;
        radarBtn.addEventListener("click", () => (this.isOpen ? this.hide() : this.show()));
        if (closeRadar) closeRadar.addEventListener("click", () => this.hide());
        const connect = document.getElementById("relay-connect-btn");
        if (connect) connect.addEventListener("click", () => this.onConnectClick());
        const chip = document.getElementById("relay-chip");
        if (chip) chip.addEventListener("click", () => this.show());
        ConvoyRelay.onChange(() => { this.renderChip(); if (this.isOpen) this.render(); });
        setInterval(() => { this.renderChip(); if (this.isOpen) this.render(); }, 5000);
        this.renderChip();
    },

    show() { this.panel.style.display = "block"; this.isOpen = true; this.render(); },
    hide() { this.panel.style.display = "none"; this.isOpen = false; },

    async onConnectClick() {
        const st = MeshtasticLink.state;
        if (!MeshtasticLink.supported()) { this.render(); return; }
        if (st === "idle" || st === "error") {
            try { await MeshtasticLink.pair(); }
            catch (e) {
                if (e && e.name === "NotFoundError") MeshtasticLink.setState("idle", "No radio selected.");
                else MeshtasticLink.setState("error", (e && e.message) || "Couldn't connect to the radio.");
            }
        } else {
            await MeshtasticLink.disconnect();
        }
        this.render();
    },

    bearingCompass(lat1, lng1, lat2, lng2) {
        const toRad = (d) => (d * Math.PI) / 180;
        const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
        const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
        const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
        const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
        return dirs[Math.round(deg / 45) % 8];
    },

    // Riders with a live socket, from the server — labelled "network".
    nearbyViaNetwork(maxKm = 20) {
        const me = (typeof myCoords !== "undefined" && myCoords) || null;
        if (!me) return [];
        return Object.values(typeof friendData !== "undefined" ? friendData : {})
            .filter((f) => f.online !== false && typeof validCoord === "function" && validCoord(f.lat, f.lng))
            .map((f) => ({ id: f.id, name: f.name, lat: f.lat, lng: f.lng, km: Number(distanceKm(me.lat, me.lng, f.lat, f.lng)), bearing: this.bearingCompass(me.lat, me.lng, f.lat, f.lng), src: "network", est: f.est }))
            .filter((f) => Number.isFinite(f.km) && f.km <= maxKm)
            .sort((a, b) => a.km - b.km);
    },

    viaRadio() {
        const me = (typeof myCoords !== "undefined" && myCoords) || null;
        return ConvoyRelay.heardRecently().map((h) => ({
            id: (ConvoyRelay.friendFor(h) || {}).id || null, name: h.name, lat: h.lat, lng: h.lng, src: "radio", est: h.est, sos: h.type === RelayFrame.SOS && Date.now() - h.ts < 15 * 60000,
            km: me ? Number(distanceKm(me.lat, me.lng, h.lat, h.lng)) : null, bearing: me ? this.bearingCompass(me.lat, me.lng, h.lat, h.lng) : "",
            ts: h.ts, snr: h.snr, hops: h.hops, offline: h.offline
        }));
    },

    statusText() {
        const L = MeshtasticLink, R = ConvoyRelay;
        if (!L.supported()) return "Web Bluetooth isn't available in this browser. On Android use Chrome; on iPhone, the Bluefy browser.";
        switch (L.state) {
            case "idle": return L.lastError || "Pair a Meshtastic LoRa radio to keep the squad connected with no mobile data.";
            case "connecting": case "configuring": return `Connecting to ${L.deviceName()}…`;
            case "reconnecting": return `Radio disconnected — reconnecting…${L.lastError ? ` (${L.lastError})` : ""}`;
            case "error": return `Radio problem: ${L.lastError}`;
            default: break;
        }
        if (!R.creds) {
            if (!R.inTrip()) return `${L.deviceName()} connected. The relay switches on inside a group trip.`;
            return R.online() ? `${L.deviceName()} connected — fetching this trip's keys…` : `${L.deviceName()} connected, but it needs data once to fetch this trip's keys.`;
        }
        const s = R.stats;
        return `Relay on · ${R.online() ? "you have data" : "no data — radio only"} · sent ${s.tx} · heard ${s.rx}${s.uploaded ? ` · put ${s.uploaded} online` : ""}`;
    },

    render() {
        const status = document.getElementById("radar-status");
        if (status) status.textContent = this.statusText();
        const btn = document.getElementById("relay-connect-btn");
        if (btn) {
            const st = MeshtasticLink.state;
            btn.hidden = !MeshtasticLink.supported();
            btn.disabled = st === "connecting" || st === "configuring";
            btn.textContent = st === "idle" || st === "error" ? "Connect radio" : st === "reconnecting" ? "Stop reconnecting" : st === "ready" ? "Disconnect radio" : "Connecting…";
        }
        const warn = document.getElementById("relay-warn");
        if (warn) {
            const w = MeshtasticLink.warnings();
            warn.hidden = !w.length;
            warn.textContent = w.join(" ");
        }
        const list = document.getElementById("peer-list");
        const radio = this.viaRadio();
        const net = this.nearbyViaNetwork().filter((n) => !radio.some((r) => r.name === n.name));
        // Android app only: trip-mates whose phones are within Bluetooth range
        // (js/native/bridge.js NativeProximity — phones advertise a per-trip id).
        const ble = window.NativeProximity ? window.NativeProximity.list() : [];
        if (list) {
            list.textContent = "";
            const add = (cls, text) => { const li = document.createElement("li"); li.className = cls; li.textContent = text; list.appendChild(li); };
            radio.forEach((r) => {
                const where = Number.isFinite(r.km) ? `${r.km.toFixed(1)} km ${r.bearing}` : "position received";
                const extra = [agoText(r.ts), Number.isFinite(r.snr) ? `SNR ${r.snr} dB` : "", Number.isFinite(r.hops) ? `${r.hops} hop${r.hops === 1 ? "" : "s"}` : "", r.offline ? "no data" : ""].filter(Boolean).join(" · ");
                const mo = Phase5UI.motionFor(r.id);
                add(`peer radio${r.sos ? " sos" : ""}`, `${r.sos ? "🆘 " : "📻 "}${r.name}${r.est ? " (estimated)" : ""} — ${where} · ${extra}${mo ? ` · ${mo.text}` : ""}`);
            });
            net.forEach((n) => {
                const mo = Phase5UI.motionFor(n.id);
                add("peer network", `📶 ${n.name}${n.est ? " (estimated)" : ""} — ${n.km.toFixed(1)} km ${n.bearing} · via network${mo ? ` · ${mo.text}` : ""}`);
            });
            ble.forEach((p) => add("peer ble", `📡 ${p.name} — ${p.label} · Bluetooth, ${agoText(p.at)}`));
            if (!radio.length && !net.length && !ble.length) add("peer empty", MeshtasticLink.state === "ready" ? "No riders heard on the radio yet." : "No riders nearby.");
        }
        this.drawCanvas(radio.concat(net));
    },

    renderChip() {
        const chip = document.getElementById("relay-chip");
        if (!chip) return;
        const ready = MeshtasticLink.state === "ready";
        chip.hidden = !(ready || MeshtasticLink.state === "reconnecting");
        const n = ConvoyRelay.heardRecently().length;
        const t = document.getElementById("relay-chip-text");
        if (t) t.textContent = !ready ? "Radio…" : ConvoyRelay.creds ? `Radio · ${n}` : "Radio";
        chip.dataset.state = ready ? (ConvoyRelay.creds ? "on" : "idle") : "reconnecting";
        chip.setAttribute("aria-label", ready ? `Radio relay on, ${n} rider${n === 1 ? "" : "s"} heard. Open radar.` : "Radio reconnecting. Open radar.");
    },

    drawCanvas(points) {
        const cvs = document.getElementById("radar-canvas");
        if (!cvs || !cvs.getContext) return;
        const css = cvs.clientWidth || 280;
        const dpr = Math.min(3, window.devicePixelRatio || 1);
        if (cvs.width !== Math.round(css * dpr)) { cvs.width = Math.round(css * dpr); cvs.height = Math.round(css * dpr); }
        const ctx = cvs.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, css, css);
        const c = css / 2, R = c - 18;
        const me = (typeof myCoords !== "undefined" && myCoords) || null;
        const pts = me ? points.filter((p) => Number.isFinite(p.km)) : [];
        const far = Math.max(0.5, ...pts.map((p) => p.km));
        const nice = [0.5, 1, 2, 5, 10, 20, 50].find((v) => v >= far) || 50;
        ctx.lineWidth = 1;
        ctx.font = "10.5px Inter, system-ui, sans-serif";
        for (let i = 1; i <= 3; i++) {
            const r = (R * i) / 3;
            ctx.strokeStyle = "rgba(255,255,255,0.10)";
            ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); ctx.stroke();
            ctx.fillStyle = "rgba(139,155,171,0.95)";
            const km = (nice * i) / 3;
            ctx.fillText(km < 1 ? `${Math.round(km * 1000)} m` : `${Math.round(km * 10) / 10} km`, c + 4, c - r + 12);
        }
        ctx.fillStyle = "rgba(198,210,219,0.9)";
        ctx.textAlign = "center";
        ctx.fillText("N", c, 11);
        ctx.textAlign = "left";
        // me
        ctx.fillStyle = "#34e0b4";
        ctx.beginPath(); ctx.arc(c, c, 5, 0, Math.PI * 2); ctx.fill();
        if (!me) {
            ctx.fillStyle = "rgba(139,155,171,0.95)"; ctx.textAlign = "center";
            ctx.fillText("Waiting for your position", c, c + 22); ctx.textAlign = "left";
            return;
        }
        pts.forEach((p) => {
            const brg = (DRMath.bearing(me.lat, me.lng, p.lat, p.lng) * Math.PI) / 180;
            const r = Math.min(R, (p.km / nice) * R);
            const x = c + r * Math.sin(brg), y = c - r * Math.cos(brg);
            const col = p.src === "radio" ? (p.sos ? "#ff2d55" : "#ff9f0a") : "#5ac8fa";
            ctx.fillStyle = col;
            ctx.strokeStyle = "#0e1724";
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(x, y, p.sos ? 7 : 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            // Phase 5: relative-motion arrow = where this rider drifts, relative
            // to you, over the next minute (same scale as the rings).
            const mo = p.id ? Phase5UI.motionFor(p.id) : null;
            if (mo && mo.rel.relVelMs && mo.rel.relSpeedMs > 1) {
                const k = (60 / 1000 / nice) * R;                       // px per (m/s) over 60 s
                const len = Math.min(R * 0.6, Math.max(10, mo.rel.relSpeedMs * k));
                const ang = Math.atan2(mo.rel.relVelMs[0], mo.rel.relVelMs[1]);
                const x2 = x + len * Math.sin(ang), y2 = y - len * Math.cos(ang);
                ctx.strokeStyle = col; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(x2, y2);
                ctx.lineTo(x2 - 7 * Math.sin(ang - 0.45), y2 + 7 * Math.cos(ang - 0.45));
                ctx.lineTo(x2 - 7 * Math.sin(ang + 0.45), y2 + 7 * Math.cos(ang + 0.45));
                ctx.closePath(); ctx.fillStyle = col; ctx.fill();
                ctx.strokeStyle = "#0e1724";
            }
            ctx.fillStyle = "#f2f6f8";
            const label = `${p.src === "radio" ? "📻 " : ""}${p.name}`;
            const w = ctx.measureText(label).width;
            ctx.fillText(label, Math.max(2, Math.min(css - w - 2, x + 9)), Math.max(12, Math.min(css - 4, y + 4)));
        });
    }
};

// ============================================================================
// 7. MESHTASTIC LINK (Phase 4) — Web Bluetooth to a LoRa radio
// ============================================================================
// A browser tab can only be a Bluetooth CENTRAL: it connects TO a device, it
// can't advertise itself for another phone to find (roadmap Section 5). So
// phone-to-phone relay goes through a radio each rider carries: Meshtastic
// firmware on an ESP32/nRF52 LoRa board (Heltec V3, T-Beam, RAK WisBlock,
// T-Echo …). Phone -> BLE -> its radio -> LoRa (km, multi-hop) -> other
// radios -> BLE -> their phones.
//
// Wire protocol = Meshtastic's documented phone API, verified against the
// official protobufs (meshtastic/protobufs mesh.proto / config.proto /
// channel.proto) and the official web client's BLE transport:
//   - GATT service 6ba1b218-…, write ToRadio, read FromRadio until empty,
//     FromNum notifies "there's more to read";
//   - handshake ToRadio.want_config_id = nonce; the radio streams its config
//     and only delivers mesh packets after FromRadio.config_complete_id;
//   - our data rides in MeshPacket.decoded {portnum: PRIVATE_APP (256)} —
//     not rate-limited by the firmware and not shown as chat on other
//     Meshtastic apps — broadcast, hop_limit 3.
// Only the handful of protobuf fields this needs are encoded/decoded, by
// hand (no dependency); unknown fields are skipped per the wire format.
const MeshProto = {
    PORT_ROUTING: 5,
    PORT_PRIVATE: 256,
    BROADCAST: 0xffffffff,
    PRIORITY_DEFAULT: 64,
    PRIORITY_ALERT: 110,

    // ---- writer ----
    pushVarint(out, v) {
        let n = Math.floor(Number(v));
        if (!(n >= 0)) n = 0;
        while (n > 0x7f) { out.push((n % 128) | 0x80); n = Math.floor(n / 128); }
        out.push(n);
    },
    pushTag(out, field, wire) { this.pushVarint(out, field * 8 + wire); },
    pushFixed32(out, field, v) {
        const n = Number(v) >>> 0;
        this.pushTag(out, field, 5);
        out.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
    },
    pushBytes(out, field, bytes) {
        this.pushTag(out, field, 2);
        this.pushVarint(out, bytes.length);
        for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
    },
    pushUint(out, field, v) { this.pushTag(out, field, 0); this.pushVarint(out, v); },

    encodeData({ portnum, payload, wantResponse = false }) {
        const out = [];
        this.pushUint(out, 1, portnum);                         // Data.portnum
        this.pushBytes(out, 2, payload);                        // Data.payload
        if (wantResponse) this.pushUint(out, 3, 1);             // Data.want_response
        return out;
    },
    encodeMeshPacket({ to = this.BROADCAST, channel = 0, data, id, hopLimit = 0, wantAck = false, priority = 0 }) {
        const out = [];
        this.pushFixed32(out, 2, to);                           // MeshPacket.to (fixed32)
        if (channel) this.pushUint(out, 3, channel);            // MeshPacket.channel
        this.pushBytes(out, 4, this.encodeData(data));          // MeshPacket.decoded (oneof)
        if (id) this.pushFixed32(out, 6, id);                   // MeshPacket.id (fixed32)
        if (hopLimit) this.pushUint(out, 9, hopLimit);          // MeshPacket.hop_limit
        if (wantAck) this.pushUint(out, 10, 1);                 // MeshPacket.want_ack
        if (priority) this.pushUint(out, 11, priority);         // MeshPacket.priority
        return out;
    },
    encodeToRadioPacket(pkt) { const out = []; this.pushBytes(out, 1, this.encodeMeshPacket(pkt)); return new Uint8Array(out); },   // ToRadio.packet
    encodeWantConfig(nonce) { const out = []; this.pushUint(out, 3, nonce); return new Uint8Array(out); },                         // ToRadio.want_config_id
    encodeDisconnect() { return new Uint8Array([4 << 3, 1]); },                                                                     // ToRadio.disconnect = true
    encodeHeartbeat() { return new Uint8Array([(7 << 3) | 2, 0]); },                                                                // ToRadio.heartbeat = {}

    // ---- reader ----
    readVarint(buf, pos) {
        let lo = 0, hi = 0, shift = 0;
        for (let i = 0; i < 10; i++) {
            if (pos >= buf.length) throw new Error("truncated varint");
            const b = buf[pos++];
            if (shift < 28) lo |= (b & 0x7f) << shift;
            else if (shift === 28) { lo |= (b & 0x0f) << 28; hi |= (b & 0x7f) >>> 4; }
            else hi |= (b & 0x7f) << (shift - 32);
            shift += 7;
            if (!(b & 0x80)) return { lo: lo >>> 0, hi: hi >>> 0, pos };
        }
        throw new Error("varint too long");
    },
    // [{field, wire, lo, hi, bytes}] — wire 0 varint (lo/hi), 1 fixed64, 2 bytes, 5 fixed32 (lo + bytes)
    fields(buf) {
        const out = [];
        let pos = 0;
        while (pos < buf.length) {
            const t = this.readVarint(buf, pos); pos = t.pos;
            const field = Math.floor((t.hi * 4294967296 + t.lo) / 8), wire = t.lo & 7;
            if (wire === 0) { const v = this.readVarint(buf, pos); pos = v.pos; out.push({ field, wire, lo: v.lo, hi: v.hi }); }
            else if (wire === 1) { if (pos + 8 > buf.length) throw new Error("truncated fixed64"); out.push({ field, wire, bytes: buf.subarray(pos, pos + 8) }); pos += 8; }
            else if (wire === 2) {
                const l = this.readVarint(buf, pos); pos = l.pos;
                const len = l.hi * 4294967296 + l.lo;
                if (pos + len > buf.length) throw new Error("truncated bytes");
                out.push({ field, wire, bytes: buf.subarray(pos, pos + len) }); pos += len;
            } else if (wire === 5) {
                if (pos + 4 > buf.length) throw new Error("truncated fixed32");
                const b = buf.subarray(pos, pos + 4);
                out.push({ field, wire, lo: (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0, bytes: b }); pos += 4;
            } else throw new Error(`unsupported wire type ${wire}`);
        }
        return out;
    },
    u(f) { return f.hi * 4294967296 + f.lo; },                   // unsigned varint / fixed32
    i32(f) { return f.lo | 0; },                                  // int32 (negatives are 10-byte varints)
    f32(f) { return new DataView(f.bytes.buffer, f.bytes.byteOffset, 4).getFloat32(0, true); },

    decodeData(buf) {
        const d = { portnum: 0, payload: new Uint8Array(0), requestId: null };
        for (const f of this.fields(buf)) {
            if (f.field === 1 && f.wire === 0) d.portnum = this.u(f);
            else if (f.field === 2 && f.wire === 2) d.payload = f.bytes;
            else if (f.field === 6 && f.wire === 5) d.requestId = f.lo;       // Data.request_id (fixed32)
        }
        return d;
    },
    decodeMeshPacket(buf) {
        const p = { from: 0, to: 0, channel: 0, id: 0, decoded: null, encrypted: false, rxSnr: null, rxRssi: null, hopLimit: null, hopStart: null, rxTime: null };
        for (const f of this.fields(buf)) {
            switch (f.field) {
                case 1: if (f.wire === 5) p.from = f.lo; break;
                case 2: if (f.wire === 5) p.to = f.lo; break;
                case 3: if (f.wire === 0) p.channel = this.u(f); break;
                case 4: if (f.wire === 2) p.decoded = this.decodeData(f.bytes); break;
                case 5: if (f.wire === 2) p.encrypted = true; break;
                case 6: if (f.wire === 5) p.id = f.lo; break;
                case 7: if (f.wire === 5) p.rxTime = f.lo; break;
                case 8: if (f.wire === 5) p.rxSnr = Math.round(this.f32(f) * 10) / 10; break;
                case 9: if (f.wire === 0) p.hopLimit = this.u(f); break;
                case 12: if (f.wire === 0) p.rxRssi = this.i32(f); break;
                case 15: if (f.wire === 0) p.hopStart = this.u(f); break;
                default: break;
            }
        }
        return p;
    },
    decodeRouting(buf) {
        for (const f of this.fields(buf)) if (f.field === 3 && f.wire === 0) return { errorReason: this.u(f) };
        return { errorReason: null };
    },
    decodeLoRa(buf) {
        const l = { region: 0, txEnabled: false, hopLimit: null };
        for (const f of this.fields(buf)) {
            if (f.wire !== 0) continue;
            if (f.field === 7) l.region = this.u(f);                 // LoRaConfig.region
            else if (f.field === 8) l.hopLimit = this.u(f);          // LoRaConfig.hop_limit
            else if (f.field === 9) l.txEnabled = this.u(f) !== 0;   // LoRaConfig.tx_enabled
        }
        return l;
    },
    decodeChannel(buf) {
        const c = { index: 0, role: 0, psk: null, name: "" };
        for (const f of this.fields(buf)) {
            if (f.field === 1 && f.wire === 0) c.index = this.i32(f);
            else if (f.field === 3 && f.wire === 0) c.role = this.u(f);
            else if (f.field === 2 && f.wire === 2) {
                for (const g of this.fields(f.bytes)) {
                    if (g.field === 2 && g.wire === 2) c.psk = g.bytes.slice();
                    else if (g.field === 3 && g.wire === 2) c.name = new TextDecoder().decode(g.bytes);
                }
            }
        }
        return c;
    },
    decodeFromRadio(buf) {
        const m = { id: null };
        for (const f of this.fields(buf)) {
            switch (f.field) {
                case 1: if (f.wire === 0) m.id = this.u(f); break;
                case 2: if (f.wire === 2) m.packet = this.decodeMeshPacket(f.bytes); break;
                case 3: if (f.wire === 2) { m.myInfo = { myNodeNum: null }; for (const g of this.fields(f.bytes)) if (g.field === 1 && g.wire === 0) m.myInfo.myNodeNum = this.u(g); } break;
                case 5: if (f.wire === 2) { for (const g of this.fields(f.bytes)) if (g.field === 6 && g.wire === 2) m.lora = this.decodeLoRa(g.bytes); } break;
                case 7: if (f.wire === 0) m.configCompleteId = this.u(f); break;
                case 8: if (f.wire === 0) m.rebooted = this.u(f) !== 0; break;
                case 10: if (f.wire === 2) m.channel = this.decodeChannel(f.bytes); break;
                case 11: if (f.wire === 2) {
                    m.queueStatus = { res: 0, free: null, maxlen: null, meshPacketId: null };
                    for (const g of this.fields(f.bytes)) {
                        if (g.wire !== 0) continue;
                        if (g.field === 1) m.queueStatus.res = this.i32(g);
                        else if (g.field === 2) m.queueStatus.free = this.u(g);
                        else if (g.field === 3) m.queueStatus.maxlen = this.u(g);
                        else if (g.field === 4) m.queueStatus.meshPacketId = this.u(g);
                    }
                } break;
                default: break;
            }
        }
        return m;
    }
};

const MeshtasticLink = {
    SERVICE: "6ba1b218-15a8-461f-9fa8-5dcae273eafd",
    TO_RADIO: "f75c76d2-129e-4dad-a1dd-7866124401e7",
    FROM_RADIO: "2c55e69e-4993-11ed-b878-0242ac120002",
    FROM_NUM: "ed9da18c-a800-4f66-a670-aa7547e34453",
    KEY_DEVICE: "mu_radio_device",
    REGION_NAMES: { 1: "US", 2: "EU 433", 3: "EU 868", 4: "CN", 5: "JP", 6: "ANZ", 7: "KR", 8: "TW", 9: "RU", 10: "IN" },

    state: "idle",                 // idle | connecting | configuring | ready | reconnecting | error
    lastError: "",
    device: null,
    chars: null,
    myNodeNum: null,
    configNonce: 0,
    info: { region: null, txEnabled: null, channelPublic: null, channelName: "", hopLimit: null },
    reading: false,
    readAgain: false,
    writeChain: Promise.resolve(),
    userClosed: false,
    reconnectDelay: 2000,
    reconnectTimer: null,
    heartbeatTimer: null,
    configTimer: null,
    handlers: { status: [], packet: [], queue: [] },

    supported() { return Boolean(navigator.bluetooth && typeof navigator.bluetooth.requestDevice === "function"); },
    on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
    emit(ev, data) { (this.handlers[ev] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(`[radio] ${ev} handler failed:`, e); } }); },
    setState(s, err = "") { this.state = s; this.lastError = err; this.emit("status", { state: s, error: err }); },
    deviceName() { return (this.device && this.device.name) || "radio"; },

    // Chooser (must run from a tap). Only Meshtastic radios are listed.
    async pair() {
        if (!this.supported()) throw new Error("Web Bluetooth isn't available in this browser.");
        const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [this.SERVICE] }] });
        try { localStorage.setItem(this.KEY_DEVICE, device.id); } catch (e) { /* ignore */ }
        this.adopt(device);
        await this.connect();
    },

    // Reconnect to the radio paired last time without a chooser, where the
    // browser supports persistent permissions (getDevices).
    async restore() {
        if (!this.supported() || typeof navigator.bluetooth.getDevices !== "function") return false;
        let saved = null;
        try { saved = localStorage.getItem(this.KEY_DEVICE); } catch (e) { /* ignore */ }
        if (!saved) return false;
        try {
            const list = await navigator.bluetooth.getDevices();
            const d = list.find((x) => x.id === saved);
            if (!d) return false;
            this.adopt(d);
            await this.connect();
            return true;
        } catch (e) {
            this.scheduleReconnect(e && e.message);
            return false;
        }
    },

    adopt(device) {
        if (this.device === device) return;
        if (this.device) this.device.removeEventListener("gattserverdisconnected", this.onGattDisconnected);
        this.device = device;
        this.onGattDisconnected = this.onGattDisconnected || (() => this.handleDisconnect());
        device.addEventListener("gattserverdisconnected", this.onGattDisconnected);
    },

    async connect() {
        if (!this.device) return;
        this.userClosed = false;
        clearTimeout(this.reconnectTimer);
        this.setState("connecting");
        let server;
        try { server = await this.device.gatt.connect(); }
        catch (e) {
            // A radio that just woke up often fails the first GATT connect.
            await new Promise((r) => setTimeout(r, 750));
            server = await this.device.gatt.connect();
        }
        const svc = await server.getPrimaryService(this.SERVICE);
        this.chars = {
            toRadio: await svc.getCharacteristic(this.TO_RADIO),
            fromRadio: await svc.getCharacteristic(this.FROM_RADIO),
            fromNum: await svc.getCharacteristic(this.FROM_NUM)
        };
        this.onFromNum = this.onFromNum || (() => this.drain());
        await this.chars.fromNum.startNotifications();
        this.chars.fromNum.addEventListener("characteristicvaluechanged", this.onFromNum);
        await this.configure();
        this.reconnectDelay = 2000;
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => { this.write(MeshProto.encodeHeartbeat()).catch(() => { /* next one */ }); }, 4 * 60 * 1000);
    },

    // The radio only starts forwarding mesh packets after this handshake.
    async configure() {
        this.setState("configuring");
        this.info = { region: null, txEnabled: null, channelPublic: null, channelName: "", hopLimit: null };
        const buf = new Uint32Array(1);
        crypto.getRandomValues(buf);
        this.configNonce = (buf[0] || 1) >>> 0;
        const done = new Promise((resolve, reject) => {
            this.configResolve = resolve;
            clearTimeout(this.configTimer);
            this.configTimer = setTimeout(() => reject(new Error("The radio didn't finish its handshake — is it running Meshtastic 2.x?")), 30000);
        });
        await this.write(MeshProto.encodeWantConfig(this.configNonce));
        await done;
        clearTimeout(this.configTimer);
        this.setState("ready");
    },

    async drain() {
        if (!this.chars) return;
        if (this.reading) { this.readAgain = true; return; }
        this.reading = true;
        try {
            do {
                this.readAgain = false;
                for (let i = 0; i < 1000; i++) {                  // config dump on a big mesh = hundreds of records
                    const v = await this.chars.fromRadio.readValue();
                    if (!v || v.byteLength === 0) break;
                    this.handleFromRadio(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
                }
            } while (this.readAgain && this.chars);
        } catch (e) {
            if (this.chars) console.warn("[radio] read failed:", e && e.message);
        } finally {
            this.reading = false;
        }
    },

    handleFromRadio(bytes) {
        let m;
        try { m = MeshProto.decodeFromRadio(bytes); } catch (e) { console.warn("[radio] undecodable FromRadio:", e.message); return; }
        if (m.myInfo && m.myInfo.myNodeNum) this.myNodeNum = m.myInfo.myNodeNum;
        if (m.lora) { this.info.region = m.lora.region; this.info.txEnabled = m.lora.txEnabled; this.info.hopLimit = m.lora.hopLimit; }
        // Primary channel: a PSK of 0 or 1 byte is no key or one of the
        // publicly known default keys — anyone can hear that channel.
        if (m.channel && m.channel.role === 1) {
            this.info.channelPublic = !m.channel.psk || m.channel.psk.length <= 1;
            this.info.channelName = m.channel.name || "";
        }
        if (m.configCompleteId != null && m.configCompleteId === this.configNonce && this.configResolve) {
            const r = this.configResolve; this.configResolve = null; r();
        }
        if (m.rebooted && this.state === "ready") this.configure().catch((e) => this.fail(e));
        if (m.queueStatus) this.emit("queue", m.queueStatus);
        if (m.packet) this.emit("packet", m.packet);
    },

    write(bytes) {
        const run = async () => {
            if (!this.chars) throw new Error("radio not connected");
            const ch = this.chars.toRadio;
            if (typeof ch.writeValueWithResponse === "function") await ch.writeValueWithResponse(bytes);
            else await ch.writeValue(bytes);
        };
        const p = this.writeChain.then(run, run);
        this.writeChain = p.catch(() => { /* keep the chain alive */ });
        return p.then(() => { this.drain(); });
    },

    // Broadcast one PRIVATE_APP payload. Returns the MeshPacket id (for acks).
    async sendPrivate(payload, { wantAck = false, hopLimit = 3, priority = 0 } = {}) {
        if (this.state !== "ready") throw new Error("radio not ready");
        const idBuf = new Uint32Array(1);
        crypto.getRandomValues(idBuf);
        const id = (idBuf[0] || 1) >>> 0;
        await this.write(MeshProto.encodeToRadioPacket({
            to: MeshProto.BROADCAST, channel: 0, id, hopLimit, wantAck, priority,
            data: { portnum: MeshProto.PORT_PRIVATE, payload }
        }));
        return id;
    },

    handleDisconnect() {
        this.chars = null;
        clearInterval(this.heartbeatTimer);
        if (this.configResolve) { this.configResolve = null; }
        if (this.userClosed) { this.setState("idle"); return; }
        this.scheduleReconnect("Radio out of range or switched off");
    },

    scheduleReconnect(reason) {
        if (this.userClosed || !this.device) return;
        this.setState("reconnecting", reason || "");
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
            this.connect().catch((e) => this.scheduleReconnect(e && e.message));
        }, this.reconnectDelay);
        this.reconnectDelay = Math.min(60000, this.reconnectDelay * 2);
    },

    fail(e) {
        const msg = (e && e.message) || String(e);
        console.warn("[radio]", msg);
        if (this.device && !this.userClosed) this.scheduleReconnect(msg);
        else this.setState("error", msg);
    },

    async disconnect() {
        this.userClosed = true;
        clearTimeout(this.reconnectTimer);
        clearInterval(this.heartbeatTimer);
        try { if (this.chars) await this.write(MeshProto.encodeDisconnect()); } catch (e) { /* going away anyway */ }
        try { if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); } catch (e) { /* ignore */ }
        try { localStorage.removeItem(this.KEY_DEVICE); } catch (e) { /* ignore */ }
        this.chars = null;
        this.setState("idle");
    },

    // Plain-language problems with the radio's own setup, if any.
    warnings() {
        const w = [];
        if (this.state !== "ready") return w;
        if (this.info.region === 0) w.push("Your radio's LoRa region isn't set, so it can't transmit. Set it in the Meshtastic app (India: IN).");
        if (this.info.txEnabled === false) w.push("Transmit is switched off on your radio (LoRa › Transmit enabled).");
        if (this.info.channelPublic) w.push("Your radio is on a public channel. MapUnite encrypts its own data, but other Meshtastic users can see that you're transmitting — a private channel shared by the squad is better.");
        return w;
    }
};

// ============================================================================
// 8. CONVOY RELAY (Phase 4) — encrypted position + SOS over the radio
// ============================================================================
// Frame (byte layout mirrored exactly by server.js openRelayFrame()):
//   [0]      version<<4 | type    1 = position ping, 2 = SOS, 4 = radio ack
//   [1..4]   trip tag             filters other convoys sharing the channel
//   [5..16]  nonce                rid(4) | unix seconds(4) | seq(2) | random(2)
//   [17..]   AES-128-GCM(groupKey, AAD = bytes 0..16) of
//              body | HMAC-SHA256(deviceKey, bytes 0..16 | body)[0..8]
//            + 16-byte GCM tag. A position frame is 57 bytes on air.
// groupKey: every trip member can read the convoy's frames (and nobody else
// on the channel can). deviceKey: only this rider and the server have it, so
// a rider who UPLOADS a friend's frame can't alter or forge it.
// Keys come from the server (getRelayCredentials) while online and are cached
// on the phone for the trip, so the relay keeps working with no data at all.
const RelayFrame = {
    VERSION: 1, PING: 1, SOS: 2, ACK: 4,
    HEADER: 17, MAC: 8, GCM_TAG: 16, POS_BODY: 16, ACK_BODY: 11,
    FLAG_EST: 0x01, FLAG_OFFLINE: 0x02, FLAG_COURSE: 0x04,

    hexToBytes(h) { const out = new Uint8Array(h.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16); return out; },
    bytesToHex(b) { return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""); },
    b64ToBytes(s) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; },
    bytesToB64(b) { let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); },

    async importKeys(creds) {
        const subtle = crypto.subtle;
        return {
            group: await subtle.importKey("raw", this.b64ToBytes(creds.groupKey), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
            device: await subtle.importKey("raw", this.b64ToBytes(creds.deviceKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
            tag: this.hexToBytes(creds.tag),
            rid: this.hexToBytes(creds.rid)
        };
    },

    encodePosition(p) {
        const b = new Uint8Array(this.POS_BODY), v = new DataView(b.buffer);
        v.setInt32(0, Math.round(p.lat * 1e7));
        v.setInt32(4, Math.round(p.lng * 1e7));
        v.setUint8(8, Number.isFinite(p.speedKmh) ? Math.max(0, Math.min(254, Math.round(p.speedKmh))) : 255);
        const hasCourse = Number.isFinite(p.course);
        v.setUint8(9, hasCourse ? Math.round((((p.course % 360) + 360) % 360) * 256 / 360) % 256 : 0);
        v.setUint16(10, Number.isFinite(p.accuracy) ? Math.max(0, Math.min(65535, Math.round(p.accuracy))) : 65535);
        v.setUint8(12, (p.est ? this.FLAG_EST : 0) | (p.offline ? this.FLAG_OFFLINE : 0) | (hasCourse ? this.FLAG_COURSE : 0));
        v.setUint8(13, Number.isFinite(p.battery) ? Math.max(0, Math.min(100, Math.round(p.battery))) : 255);
        v.setInt16(14, Number.isFinite(p.alt) ? Math.max(-32767, Math.min(32767, Math.round(p.alt))) : -32768);
        return b;
    },
    decodePosition(b) {
        const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
        const speed = v.getUint8(8), flags = v.getUint8(12), batt = v.getUint8(13), alt = v.getInt16(14);
        return {
            lat: v.getInt32(0) / 1e7, lng: v.getInt32(4) / 1e7,
            speedKmh: speed === 255 ? null : speed,
            course: flags & this.FLAG_COURSE ? Math.round((v.getUint8(9) * 360) / 256) % 360 : null,
            accuracy: v.getUint16(10), est: Boolean(flags & this.FLAG_EST), offline: Boolean(flags & this.FLAG_OFFLINE),
            battery: batt === 255 ? null : batt, alt: alt === -32768 ? null : alt
        };
    },
    encodeAck(a) {
        const b = new Uint8Array(this.ACK_BODY), v = new DataView(b.buffer);
        b.set(this.hexToBytes(a.rid), 0);
        v.setUint32(4, a.ts >>> 0);
        v.setUint16(8, a.seq & 0xffff);
        v.setUint8(10, a.status);
        return b;
    },
    decodeAck(b) {
        const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
        return { rid: this.bytesToHex(b.subarray(0, 4)), ts: v.getUint32(4), seq: v.getUint16(8), status: v.getUint8(10) };
    },

    async build(keys, type, body, seq, tsSec = Math.floor(Date.now() / 1000)) {
        const header = new Uint8Array(this.HEADER);
        header[0] = (this.VERSION << 4) | type;
        header.set(keys.tag, 1);
        header.set(keys.rid, 5);
        const hv = new DataView(header.buffer);
        hv.setUint32(9, tsSec >>> 0);
        hv.setUint16(13, seq & 0xffff);
        crypto.getRandomValues(header.subarray(15, 17));
        const macInput = new Uint8Array(this.HEADER + body.length);
        macInput.set(header, 0); macInput.set(body, this.HEADER);
        const mac = new Uint8Array(await crypto.subtle.sign("HMAC", keys.device, macInput)).subarray(0, this.MAC);
        const plain = new Uint8Array(body.length + this.MAC);
        plain.set(body, 0); plain.set(mac, body.length);
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: header.subarray(5, 17), additionalData: header, tagLength: 128 }, keys.group, plain));
        const out = new Uint8Array(this.HEADER + ct.length);
        out.set(header, 0); out.set(ct, this.HEADER);
        return out;
    },
    // -> null (not ours / not authentic) or {type, rid, ts, seq, nonceHex, body}
    async open(keys, bytes) {
        if (!bytes || bytes.length < this.HEADER + this.MAC + this.GCM_TAG + 1 || bytes.length > 140) return null;
        if (bytes[0] >> 4 !== this.VERSION) return null;
        for (let i = 0; i < 4; i++) if (bytes[1 + i] !== keys.tag[i]) return null;
        const header = bytes.slice(0, this.HEADER);
        const nonce = header.subarray(5, 17);
        let plain;
        try {
            plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: header, tagLength: 128 }, keys.group, bytes.slice(this.HEADER)));
        } catch (e) { return null; }
        const nv = new DataView(header.buffer, 5, 12);
        return {
            type: header[0] & 0x0f, rid: this.bytesToHex(nonce.subarray(0, 4)), ts: nv.getUint32(4), seq: nv.getUint16(8),
            nonceHex: this.bytesToHex(nonce), body: plain.subarray(0, plain.length - this.MAC)
        };
    }
};

const ConvoyRelay = {
    KEY_CREDS: "mu_relay_creds",
    KEY_SEQ: "mu_relay_seq",
    CREDS_MAX_AGE_MS: 24 * 3600 * 1000,
    HEARD_FRESH_MS: 10 * 60 * 1000,
    creds: null,
    keys: null,
    heard: new Map(),              // rid -> latest decoded position (last-writer-wins by origin timestamp)
    seen: new Set(),
    seenOrder: [],
    uploadQueue: [],
    uploading: false,
    lastPingAt: 0,
    lastCredsAskAt: 0,
    mySos: null,                   // {startedAt, packetIds:Set, attempts, nextAt, acks: Map(rid -> status), meshHeard}
    ackSent: new Map(),            // `${rid}:${ts}:${status}` -> ts
    stats: { tx: 0, rx: 0, uploaded: 0, rejected: 0, foreign: 0 },
    battery: null,
    listeners: [],

    init() {
        this.loadCreds();
        MeshtasticLink.on("status", (s) => this.onRadioStatus(s));
        MeshtasticLink.on("packet", (p) => this.onPacket(p));
        socket.on("tripData", () => this.refreshCreds("trip"));
        socket.on("profileAccepted", () => setTimeout(() => this.refreshCreds("profile"), 300));
        socket.on("connect", () => setTimeout(() => this.flush(), 1500));
        socket.on("disconnect", () => { setTimeout(() => this.tick(true), 5000); this.updateOfflineIsland(); });
        window.addEventListener("offline", () => setTimeout(() => this.updateOfflineIsland(), 0));
        setInterval(() => this.tick(false), 5000);
        setInterval(() => this.flush(), 3000);
        if (navigator.getBattery) navigator.getBattery().then((b) => {
            const upd = () => { this.battery = Math.round(b.level * 100); };
            upd(); b.addEventListener("levelchange", upd);
        }).catch(() => { /* not available */ });
        MeshtasticLink.restore().catch(() => { /* chooser needed next time */ });
    },

    onChange(fn) { this.listeners.push(fn); },
    changed() { this.listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); },

    ready() { return MeshtasticLink.state === "ready" && Boolean(this.creds && this.keys); },
    online() { return Boolean(socket.connected) && navigator.onLine !== false; },
    inTrip() { return Boolean(currentTrip && Array.isArray(currentTrip.members) && currentTrip.members.some((m) => m.id === socket.id)); },

    // ---- credentials ----------------------------------------------------------
    loadCreds() {
        try {
            const c = JSON.parse(localStorage.getItem(this.KEY_CREDS) || "null");
            if (c && c.tripId && c.groupKey && Date.now() - (c.fetchedAt || 0) < this.CREDS_MAX_AGE_MS) this.setCreds(c, false);
            else localStorage.removeItem(this.KEY_CREDS);
        } catch (e) { /* corrupt cache: fetch again */ }
    },
    async setCreds(c, persist = true) {
        if (!c) {
            this.creds = null; this.keys = null; this.heard.clear();
            try { localStorage.removeItem(this.KEY_CREDS); } catch (e) { /* ignore */ }
            this.changed();
            return;
        }
        try {
            const keys = await RelayFrame.importKeys(c);
            if (this.creds && this.creds.tripId !== c.tripId) this.heard.clear();
            this.creds = c; this.keys = keys;
            if (persist) { try { localStorage.setItem(this.KEY_CREDS, JSON.stringify(c)); } catch (e) { /* quota */ } }
        } catch (e) {
            console.warn("[relay] couldn't import relay keys:", e && e.message);
        }
        this.changed();
    },
    refreshCreds(reason) {
        if (!socket.connected) return;
        if (currentTrip === null && reason === "trip") { this.setCreds(null); return; }
        if (!this.inTrip()) { if (reason === "trip" && this.creds) this.setCreds(null); return; }
        // Everyone in the trip with a radio paired (or remembered) needs the
        // keys BEFORE the dead zone — ask now while there's data.
        const hasRadio = MeshtasticLink.state !== "idle" || (() => { try { return Boolean(localStorage.getItem(MeshtasticLink.KEY_DEVICE)); } catch (e) { return false; } })();
        if (!hasRadio) return;
        if (Date.now() - this.lastCredsAskAt < 2500) { clearTimeout(this.credsRetry); this.credsRetry = setTimeout(() => this.refreshCreds(reason), 2600); return; }
        this.lastCredsAskAt = Date.now();
        socket.emit("getRelayCredentials", { radio: true }, (res) => {
            if (res && res.ok) this.setCreds({ ...res, fetchedAt: Date.now() });
            else if (res && res.reason === "not-in-trip") this.setCreds(null);
            else if (res && res.reason === "too-frequent") { clearTimeout(this.credsRetry); this.credsRetry = setTimeout(() => this.refreshCreds(reason), 2600); }
        });
    },

    nextSeq() {
        let n = 0;
        try { n = (Number(localStorage.getItem(this.KEY_SEQ)) || 0) + 1; localStorage.setItem(this.KEY_SEQ, String(n % 65536)); } catch (e) { n = Math.floor(Math.random() * 65536); }
        return n % 65536;
    },

    onRadioStatus(s) {
        if (s.state === "ready") {
            this.refreshCreds("radio");
            islandShow({ id: "radio", kind: "safe", icon: "📻", title: "Radio connected", sub: MeshtasticLink.deviceName(), ttl: 3500, haptic: false });
            const warn = MeshtasticLink.warnings();
            if (warn.length) setTimeout(() => islandShow({ id: "radio-warn", kind: "sensor", icon: "📻", title: "Radio needs a setting", sub: warn[0], ttl: 9000 }), 3600);
            setTimeout(() => this.tick(true), 1000);
        } else if (s.state === "reconnecting") {
            islandShow({ id: "radio", kind: "sensor", icon: "📻", title: "Radio disconnected", sub: "Reconnecting…", ttl: 5000, haptic: false });
        }
        this.updateOfflineIsland();
        this.changed();
    },

    updateOfflineIsland() {
        // shell.js shows "You're offline"; with the radio up that's only half the story.
        if (!window.StatusIsland) return;
        if (!this.online() && this.ready() && this.inTripOrCached()) {
            window.StatusIsland.show({ id: "net", kind: "sensor", icon: "📻", title: "No data — radio relay on", sub: "Nearby riders still get your position", priority: 45, ttl: 0, sticky: true, haptic: false });
        }
    },
    inTripOrCached() { return this.inTrip() || Boolean(this.creds); },

    // ---- sending ------------------------------------------------------------------
    positionBody(extraFlags = {}) {
        const c = myCoords;
        if (!c || !validCoord(c.lat, c.lng)) return null;
        return RelayFrame.encodePosition({
            lat: c.lat, lng: c.lng, speedKmh: Number.isFinite(c.speedKmh) ? c.speedKmh : null,
            course: Number.isFinite(c.heading) ? c.heading : null,
            accuracy: Number.isFinite(c.accuracy) ? c.accuracy : null,
            est: Boolean(c.est), offline: !this.online(), battery: this.battery, alt: c.alt, ...extraFlags
        });
    },

    // Every 5 s: is a ping due? Airtime is shared by everyone on the channel,
    // so: every 2 min while we have data (keeps riders WITHOUT data seeing
    // us), every 30 s without data while moving, 90 s when stopped.
    async tick(force) {
        if (!this.ready() || !myCoords) return;
        if (typeof PrivacyControls !== "undefined" && PrivacyControls.mode === "off") return;
        const now = Date.now();
        if (this.mySos && now >= this.mySos.nextAt) this.sendSosFrame();
        const moving = (Number(myCoords.speedKmh) || 0) > 5;
        const every = this.online() ? 120000 : moving ? 30000 : 90000;
        if (!force && now - this.lastPingAt < every) return;
        if (now - this.lastPingAt < 10000) {                    // never more than one ping per 10 s…
            // …but a forced ping (we just lost data) is postponed, not dropped:
            // the last one said "has data", so nobody would upload it.
            if (force) { clearTimeout(this.forceTimer); this.forceTimer = setTimeout(() => this.tick(true), this.lastPingAt + 10050 - now); }
            return;
        }
        const body = this.positionBody();
        if (!body) return;
        this.lastPingAt = now;
        try {
            const frame = await RelayFrame.build(this.keys, RelayFrame.PING, body, this.nextSeq());
            await MeshtasticLink.sendPrivate(frame, { hopLimit: 3 });
            this.stats.tx++;
            this.changed();
        } catch (e) { console.warn("[relay] ping failed:", e && e.message); }
    },

    // SOS over the radio. Retries (fresh position each time) at +15 s, +45 s,
    // +90 s, then every 3 min for 15 min, until a rider's phone confirms it
    // put the SOS online.
    sendSos() {
        if (!this.ready() || !myCoords) return false;
        this.mySos = { startedAt: Date.now(), packetIds: new Set(), attempts: 0, nextAt: 0, acks: new Map(), meshHeard: false, delivered: false };
        this.sendSosFrame();
        return true;
    },
    async sendSosFrame() {
        const s = this.mySos;
        if (!s || !this.ready()) return;
        const age = Date.now() - s.startedAt;
        // Delivered, expired, or we have data again (the direct SOS already
        // went out through the server): stop using airtime on retries.
        if (s.delivered || age > 15 * 60000 || (s.attempts >= 1 && this.online())) { this.mySos = null; this.changed(); return; }
        const gaps = [15000, 30000, 45000];
        s.nextAt = Date.now() + (s.attempts < gaps.length ? gaps[s.attempts] : 180000);
        s.attempts++;
        const body = this.positionBody();
        if (!body) return;
        try {
            const frame = await RelayFrame.build(this.keys, RelayFrame.SOS, body, this.nextSeq());
            const id = await MeshtasticLink.sendPrivate(frame, { hopLimit: 3, wantAck: true, priority: MeshProto.PRIORITY_ALERT });
            s.packetIds.add(id);
            this.stats.tx++;
        } catch (e) { console.warn("[relay] SOS send failed:", e && e.message); }
        this.changed();
    },
    async sendAck(target, status) {
        if (!this.ready()) return;
        const key = `${target.rid}:${target.ts}:${status}`;
        const last = this.ackSent.get(key);
        if (last && Date.now() - last < 20000) return;
        this.ackSent.set(key, Date.now());
        if (this.ackSent.size > 200) this.ackSent.delete(this.ackSent.keys().next().value);
        try {
            const frame = await RelayFrame.build(this.keys, RelayFrame.ACK, RelayFrame.encodeAck({ ...target, status }), this.nextSeq());
            await MeshtasticLink.sendPrivate(frame, { hopLimit: 3, priority: MeshProto.PRIORITY_ALERT });
            this.stats.tx++;
        } catch (e) { console.warn("[relay] ack failed:", e && e.message); }
    },

    // ---- receiving ----------------------------------------------------------------
    onPacket(p) {
        const d = p && p.decoded;
        if (!d) return;
        if (d.portnum === MeshProto.PORT_ROUTING && d.requestId && this.mySos && this.mySos.packetIds.has(d.requestId)) {
            // Firmware "implicit ack": another radio re-broadcast our SOS.
            const r = MeshProto.decodeRouting(d.payload);
            if (r.errorReason === 0 && !this.mySos.meshHeard) {
                this.mySos.meshHeard = true;
                islandShow({ id: "sos", kind: "sos", title: "SOS is on the mesh", sub: "Another radio repeated it — waiting for a rider to confirm", ttl: 8000 });
                this.changed();
            }
            return;
        }
        if (d.portnum !== MeshProto.PORT_PRIVATE) return;
        this.onFrame(d.payload, { snr: p.rxSnr, rssi: p.rxRssi, hops: Number.isFinite(p.hopStart) && Number.isFinite(p.hopLimit) ? Math.max(0, p.hopStart - p.hopLimit) : null }).catch((e) => console.warn("[relay] frame error:", e && e.message));
    },

    rememberNonce(hex) {
        if (this.seen.has(hex)) return false;
        this.seen.add(hex); this.seenOrder.push(hex);
        if (this.seenOrder.length > 512) this.seen.delete(this.seenOrder.shift());
        return true;
    },

    async onFrame(bytes, meta = {}) {
        if (!this.keys || !this.creds) return;
        const fr = await RelayFrame.open(this.keys, bytes);
        if (!fr) { this.stats.foreign++; return; }            // other convoy / other app / tampered
        if (fr.rid === this.creds.rid) return;                 // our own frame echoed back
        if (!this.rememberNonce(fr.nonceHex)) return;          // heard it already (mesh repeats)
        this.stats.rx++;
        const tsMs = fr.ts * 1000, now = Date.now();
        if (fr.type === RelayFrame.ACK) {
            if (fr.body.length === RelayFrame.ACK_BODY) this.onAck(fr, RelayFrame.decodeAck(fr.body));
            return;
        }
        if ((fr.type !== RelayFrame.PING && fr.type !== RelayFrame.SOS) || fr.body.length !== RelayFrame.POS_BODY) return;
        if (tsMs > now + 5 * 60000 || now - tsMs > 30 * 60000) return;
        const pos = RelayFrame.decodePosition(fr.body);
        if (!validCoord(pos.lat, pos.lng)) return;
        const who = (this.creds.roster || []).find((r) => r.rid === fr.rid) || null;
        const entry = { rid: fr.rid, name: who ? who.name : "Convoy rider", ownerKey: who ? who.ownerKey : null, ...pos, ts: tsMs, rxAt: now, snr: meta.snr, rssi: meta.rssi, hops: meta.hops, type: fr.type };
        const prev = this.heard.get(fr.rid);
        const newer = !prev || tsMs > prev.ts;
        if (newer) { this.heard.set(fr.rid, entry); this.applyLocal(entry); }

        // Carry it to the server if its sender has no data (or it's an SOS).
        if (fr.type === RelayFrame.SOS || pos.offline) this.enqueue(bytes, fr);

        if (fr.type === RelayFrame.SOS) {
            const f = this.friendFor(entry);
            if (typeof showIncomingSos === "function") showIncomingSos({ id: f ? f.id : `radio:${fr.rid}`, name: entry.name, lat: pos.lat, lng: pos.lng, alt: pos.alt, ownerKey: entry.ownerKey, via: "radio", at: tsMs });
            this.sendAck(fr, 1);                                // "my radio got it"
        }
        this.changed();
    },

    onAck(fr, ack) {
        if (!this.creds || ack.rid !== this.creds.rid || !this.mySos) return;
        const who = (this.creds.roster || []).find((r) => r.rid === fr.rid);
        const name = who ? who.name : "A rider";
        const prev = this.mySos.acks.get(fr.rid) || 0;
        if (ack.status <= prev) return;
        this.mySos.acks.set(fr.rid, ack.status);
        if (ack.status >= 2) {
            this.mySos.delivered = true;
            islandShow({ id: "sos", kind: "sos", title: "SOS delivered", sub: `${name} put it online for the squad`, ttl: 12000 });
            voiceAnnounce(`Your S O S was delivered. ${name} relayed it online.`, { priority: 100, force: true, key: "sos-delivered", cooldownMs: 60000, category: "sos" });
        } else {
            islandShow({ id: "sos", kind: "sos", title: "SOS received", sub: `${name}'s radio got it`, ttl: 9000 });
            voiceAnnounce(`${name} received your S O S over the radio.`, { priority: 100, force: true, key: `sos-ack-${fr.rid}`, cooldownMs: 60000, category: "sos" });
        }
        this.changed();
    },

    friendFor(entry) {
        if (!entry.ownerKey) return null;
        return Object.values(friendData).find((f) => f.ownerKey === entry.ownerKey) || null;
    },

    // Put a radio-heard rider on OUR map, even with no data at all.
    applyLocal(entry) {
        const f = this.friendFor(entry);
        // While WE have data and the server still has their socket (and their
        // frame doesn't say they've lost data), the server feed is the truth —
        // a parked rider sends no updates, which doesn't make the feed stale.
        if (f && f.online !== false && this.online() && !entry.offline) return;
        const u = {
            id: f ? f.id : `radio:${entry.rid}`, name: f ? f.name : entry.name, avatar: f ? f.avatar : DEFAULT_AVATAR,
            lat: entry.lat, lng: entry.lng, alt: entry.alt, speedKmh: entry.speedKmh, weather: "",
            online: false, approx: false, ownerKey: entry.ownerKey, accuracy: entry.accuracy, est: entry.est,
            via: "radio", fixAt: entry.ts, relayedBy: null
        };
        createOrUpdateFriendMarker(u);
        updateOnlineUI();
        if (typeof RelativeMotion !== "undefined") RelativeMotion.onPosition(u);     // Phase 5: radio positions feed the tracks too
        if (typeof ConvoyIntelligence !== "undefined") ConvoyIntelligence.onFriendMoved(u);
        if (currentTrip && typeof updateTripPanel === "function") updateTripPanel();
    },

    // ---- upload (store-and-forward) ------------------------------------------------
    enqueue(bytes, fr) {
        const b64 = RelayFrame.bytesToB64(bytes);
        if (this.uploadQueue.some((q) => q.b64 === b64)) return;
        this.uploadQueue.push({ b64, rid: fr.rid, ts: fr.ts, seq: fr.seq, sos: fr.type === RelayFrame.SOS, addedAt: Date.now() });
        // Positions are last-writer-wins: keep only each rider's newest ping, all SOS frames.
        const newest = new Map();
        this.uploadQueue.forEach((q) => { if (!q.sos && (!newest.has(q.rid) || newest.get(q.rid).ts < q.ts)) newest.set(q.rid, q); });
        this.uploadQueue = this.uploadQueue.filter((q) => q.sos || newest.get(q.rid) === q).slice(-64);
        if (fr.type === RelayFrame.SOS) setTimeout(() => this.flush(), 0);
    },

    flush() {
        if (this.uploading || !this.uploadQueue.length || !socket.connected || !this.creds) return;
        const cutoff = Date.now() - 15 * 60000;
        this.uploadQueue = this.uploadQueue.filter((q) => q.ts * 1000 >= cutoff);
        const batch = this.uploadQueue.slice().sort((a, b) => Number(b.sos) - Number(a.sos)).slice(0, 16);
        if (!batch.length) return;
        this.uploading = true;
        let settled = false;
        const timer = setTimeout(() => { if (!settled) { settled = true; this.uploading = false; } }, 8000);
        socket.emit("relayUpload", { frames: batch.map((q) => q.b64) }, (res) => {
            if (settled) return;
            settled = true; clearTimeout(timer); this.uploading = false;
            if (!res || !res.ok) {
                if (res && res.reason === "not-in-trip") { this.uploadQueue = []; this.setCreds(null); }
                return;                                           // too-frequent / rate-limited: next flush retries
            }
            const done = new Set();
            (res.results || []).forEach((r) => {
                const q = batch[r.i];
                if (!q) return;
                const retry = r.status === "rate-limited";
                if (!retry) done.add(q);
                if (["applied", "sos-broadcast", "sos-duplicate"].includes(r.status)) this.stats.uploaded++;
                else if (!["duplicate", "older", "live-direct"].includes(r.status)) this.stats.rejected++;
                if (q.sos && ["sos-broadcast", "sos-duplicate", "duplicate"].includes(r.status)) this.sendAck({ rid: q.rid, ts: q.ts, seq: q.seq }, 2);   // "it's online"
                if (r.status === "unknown-rider" || r.status === "wrong-trip") this.refreshCreds("stale");
            });
            this.uploadQueue = this.uploadQueue.filter((q) => !done.has(q));
            this.changed();
        });
    },

    // ---- read-outs ------------------------------------------------------------------
    heardRecently() {
        const now = Date.now();
        return Array.from(this.heard.values()).filter((h) => now - h.rxAt < this.HEARD_FRESH_MS).sort((a, b) => b.rxAt - a.rxAt);
    },
    summary() {
        if (MeshtasticLink.state === "idle") return "No radio connected. Open the radar and tap connect radio.";
        if (MeshtasticLink.state !== "ready") return "The radio is reconnecting.";
        if (!this.creds) return "The radio is connected, but the relay only works inside a group trip.";
        const list = this.heardRecently();
        if (!list.length) return "Radio connected. I haven't heard any riders on it in the last ten minutes.";
        const parts = list.slice(0, 3).map((h) => {
            let s = h.name;
            if (myCoords) s += `, ${spokenDistance(map.distance([myCoords.lat, myCoords.lng], [h.lat, h.lng]))} ${compassWord(myCoords.lat, myCoords.lng, h.lat, h.lng)}`;
            const m = Math.round((Date.now() - h.ts) / 60000);
            return `${s}, ${m < 1 ? "just now" : `${m} minute${m === 1 ? "" : "s"} ago`}`;
        });
        return `Radio connected. Heard ${list.length} rider${list.length === 1 ? "" : "s"}: ${parts.join("; ")}.`;
    }
};
