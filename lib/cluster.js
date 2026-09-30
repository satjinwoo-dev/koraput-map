"use strict";

/* ============================================================================
   MapUnite cluster bus — lib/cluster.js
   ==============================================================================
   Lets several server processes share ONE live state (who is online, where,
   which trips exist, who is in the voice squad, recent chat, …).

   Why not "just add the Socket.IO Redis adapter"? The adapter makes
   io.emit()/io.to() reach sockets on other processes — but MapUnite's state
   lives in each process's memory. With the adapter alone, a rider connected
   to process A is invisible to process B's onlineUsers list, B can't check
   A's trip roster, and a join on B can't see a trip started on A. So:

     - Every change to shared state is an OPERATION ("op"). A process that
       wants to change state publishes the op to one Redis channel.
     - Redis delivers messages on one channel to every subscriber in the SAME
       order, so every process applies the SAME ops in the SAME order and
       ends with the same state (a replicated state machine). Apply code is
       deterministic: the op carries its own timestamp and ids.
     - Each process only emits to ITS OWN sockets when it applies an op, so
       every client gets exactly one copy of each event.
     - A process that starts (or reconnects to Redis) asks for a snapshot;
       every up-to-date process answers with its state at that point in the
       stream, and the newcomer replays everything after it.
     - Point-to-point messages for a socket on another process (WebRTC call
       signalling, relay acks) go through the official @socket.io/redis-adapter
       when it's installed, otherwise over this bus's per-node channel.

   With no REDIS_URL, LocalBus applies each op synchronously in-process —
   exactly the old single-process behaviour, no Redis needed.

   The Redis client here is a small dependency-free RESP2 implementation
   (PUBLISH / SUBSCRIBE / AUTH / SELECT / PING), with TLS for rediss:// and
   automatic reconnect. Everything is plain JSON on the wire.
   ============================================================================ */

const net = require("net");
const tls = require("tls");
const os = require("os");
const crypto = require("crypto");
const { EventEmitter } = require("events");

// ---------------------------------------------------------------------------
// RESP2 parser: incremental, handles replies split across TCP chunks.
// ---------------------------------------------------------------------------
class RespParser {
    constructor() { this.buf = Buffer.alloc(0); }
    push(chunk) { this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk; }
    // Returns {value} for one complete reply, or null if more bytes are needed.
    next() {
        const r = this._parse(0);
        if (!r) return null;
        this.buf = this.buf.subarray(r.end);
        return { value: r.value };
    }
    _line(at) {
        const i = this.buf.indexOf("\r\n", at);
        return i < 0 ? null : { text: this.buf.toString("utf8", at + 1, i), end: i + 2 };
    }
    _parse(at) {
        if (at >= this.buf.length) return null;
        const type = String.fromCharCode(this.buf[at]);
        const line = this._line(at);
        if (!line) return null;
        switch (type) {
            case "+": return { value: line.text, end: line.end };
            case "-": { const e = new Error(line.text); e.redis = true; return { value: e, end: line.end }; }
            case ":": return { value: Number(line.text), end: line.end };
            case "$": {
                const len = Number(line.text);
                if (len < 0) return { value: null, end: line.end };
                if (this.buf.length < line.end + len + 2) return null;
                return { value: this.buf.toString("utf8", line.end, line.end + len), end: line.end + len + 2 };
            }
            case "*": {
                const n = Number(line.text);
                if (n < 0) return { value: null, end: line.end };
                const out = [];
                let pos = line.end;
                for (let k = 0; k < n; k++) {
                    const item = this._parse(pos);
                    if (!item) return null;
                    out.push(item.value);
                    pos = item.end;
                }
                return { value: out, end: pos };
            }
            default: {
                // Protocol desync: drop the buffer, the connection will be reset.
                const e = new Error(`RESP protocol error (type byte ${this.buf[at]})`);
                e.fatal = true;
                return { value: e, end: this.buf.length };
            }
        }
    }
}

function encodeCommand(args) {
    const parts = [`*${args.length}\r\n`];
    for (const a of args) {
        const s = Buffer.isBuffer(a) ? a : Buffer.from(String(a), "utf8");
        parts.push(`$${s.length}\r\n`, s, "\r\n");
    }
    return Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, "utf8"))));
}

function parseRedisUrl(url) {
    const u = new URL(url);
    if (!/^rediss?:$/.test(u.protocol)) throw new Error(`REDIS_URL must start with redis:// or rediss:// (got ${u.protocol})`);
    return {
        tls: u.protocol === "rediss:",
        host: u.hostname || "127.0.0.1",
        port: Number(u.port) || 6379,
        username: u.username ? decodeURIComponent(u.username) : null,
        password: u.password ? decodeURIComponent(u.password) : null,
        db: u.pathname && u.pathname.length > 1 ? Number(u.pathname.slice(1)) || 0 : 0
    };
}

// ---------------------------------------------------------------------------
// One Redis connection. Commands are answered in order (FIFO). In subscriber
// mode, pushed "message" frames are emitted as events. Reconnects with
// backoff; emits "ready" after (re)connect + auth, "down" when lost.
// ---------------------------------------------------------------------------
class RespConnection extends EventEmitter {
    constructor(url, { name = "redis", subscriber = false, log = console } = {}) {
        super();
        this.cfg = parseRedisUrl(url);
        this.name = name;
        this.subscriber = subscriber;
        this.log = log;
        this.sock = null;
        this.parser = new RespParser();
        this.pending = [];          // [{resolve, reject}] awaiting a reply, in order
        this.ready = false;
        this.closed = false;
        this.backoffMs = 200;
        this.channels = new Set();  // re-subscribed after reconnect
    }

    connect() {
        if (this.closed) return;
        const { host, port } = this.cfg;
        const sock = this.cfg.tls ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
        this.sock = sock;
        this.parser = new RespParser();
        sock.setNoDelay(true);
        sock.setKeepAlive(true, 15000);
        sock.once(this.cfg.tls ? "secureConnect" : "connect", () => this._handshake().catch((e) => {
            this.log.error(`[cluster] ${this.name}: handshake failed: ${e.message}`);
            sock.destroy();
        }));
        sock.on("data", (chunk) => this._onData(chunk));
        sock.on("error", (e) => { if (!this.closed) this.log.warn(`[cluster] ${this.name}: ${e.message}`); });
        sock.on("close", () => this._onClose());
    }

    async _handshake() {
        this.backoffMs = 200;
        if (this.cfg.password) {
            const args = this.cfg.username ? ["AUTH", this.cfg.username, this.cfg.password] : ["AUTH", this.cfg.password];
            await this._raw(args);
        }
        if (!this.subscriber && this.cfg.db) await this._raw(["SELECT", this.cfg.db]);
        if (this.subscriber && this.channels.size) await this._raw(["SUBSCRIBE", ...this.channels]);
        this.ready = true;
        this.emit("ready");
    }

    _onData(chunk) {
        this.parser.push(chunk);
        for (;;) {
            const r = this.parser.next();
            if (!r) break;
            const v = r.value;
            if (v instanceof Error && v.fatal) { this.sock.destroy(); return; }
            if (this.subscriber && Array.isArray(v) && v[0] === "message") { this.emit("message", v[1], v[2]); continue; }
            if (this.subscriber && Array.isArray(v) && (v[0] === "subscribe" || v[0] === "unsubscribe")) {
                // One confirmation per channel; resolve the command after the last one.
                const p = this.pending[0];
                if (p) { p.remaining = (p.remaining ?? p.expect) - 1; if (p.remaining <= 0) { this.pending.shift(); p.resolve(v); } }
                continue;
            }
            const p = this.pending.shift();
            if (!p) continue;
            if (v instanceof Error) p.reject(v); else p.resolve(v);
        }
    }

    _onClose() {
        const wasReady = this.ready;
        this.ready = false;
        const err = new Error(`${this.name}: connection closed`);
        this.pending.splice(0).forEach((p) => p.reject(err));
        if (wasReady) this.emit("down");
        if (this.closed) return;
        const wait = this.backoffMs;
        this.backoffMs = Math.min(5000, this.backoffMs * 2);
        setTimeout(() => this.connect(), wait).unref?.();
    }

    _raw(args) {
        return new Promise((resolve, reject) => {
            if (!this.sock || this.sock.destroyed) return reject(new Error(`${this.name}: not connected`));
            const entry = { resolve, reject };
            if (args[0] === "SUBSCRIBE" || args[0] === "UNSUBSCRIBE") entry.expect = args.length - 1;
            this.pending.push(entry);
            this.sock.write(encodeCommand(args));
        });
    }

    command(args) {
        if (!this.ready) return Promise.reject(new Error(`${this.name}: not ready`));
        return this._raw(args);
    }

    async subscribe(...channels) {
        channels.forEach((c) => this.channels.add(c));
        if (this.ready) await this._raw(["SUBSCRIBE", ...channels]);
    }

    waitReady(timeoutMs = 10000) {
        if (this.ready) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => { this.off("ready", ok); reject(new Error(`${this.name}: could not reach Redis at ${this.cfg.host}:${this.cfg.port}`)); }, timeoutMs);
            const ok = () => { clearTimeout(t); resolve(); };
            this.once("ready", ok);
        });
    }

    close() {
        this.closed = true;
        this.ready = false;
        try { this.sock && this.sock.end(); } catch { /* ignore */ }
        try { this.sock && this.sock.destroy(); } catch { /* ignore */ }
    }
}

// ---------------------------------------------------------------------------
// Bus interface (both implementations):
//   nodeId, mode ("local" | "redis")
//   start({apply, snapshot, restore, hydrate, onDirect}) -> Promise (ready)
//   commit(op)            -> Promise<apply result on THIS node>
//   sendToNode(id, msg)   -> Promise (redis) / no-op (local)
//   isReady(), stop()
// apply(op) is called with op.id / op.node / op.now filled in; it must be
// deterministic given the op and the current state.
// ---------------------------------------------------------------------------
const makeNodeId = () => process.env.NODE_ID || `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

class LocalBus {
    constructor({ nodeId = makeNodeId() } = {}) {
        this.nodeId = nodeId;
        this.mode = "local";
        this.apply = null;
        this.ready = false;
    }
    async start({ apply, hydrate }) {
        this.apply = apply;
        if (hydrate) hydrate();
        this.ready = true;
    }
    isReady() { return this.ready; }
    commit(op) {
        op.id = op.id || crypto.randomUUID();
        op.node = this.nodeId;
        if (!Number.isFinite(op.now)) op.now = Date.now();
        try { return Promise.resolve(this.apply(op)); } catch (e) { return Promise.reject(e); }
    }
    // Synchronous variant for single-process code paths that must not yield.
    commitSync(op) {
        op.id = op.id || crypto.randomUUID();
        op.node = this.nodeId;
        if (!Number.isFinite(op.now)) op.now = Date.now();
        return this.apply(op);
    }
    sendToNode() { return Promise.resolve(); }
    stop() { this.ready = false; }
}

class RedisBus {
    constructor({ url, prefix = "mapunite", nodeId = makeNodeId(), log = console, snapshotWaitMs = 1500, commitTimeoutMs = 10000 }) {
        this.url = url;
        this.prefix = prefix;
        this.nodeId = nodeId;
        this.mode = "redis";
        this.log = log;
        this.snapshotWaitMs = snapshotWaitMs;
        this.commitTimeoutMs = commitTimeoutMs;
        this.opsChannel = `${prefix}:ops`;
        this.nodeChannel = (id) => `${prefix}:node:${id}`;
        this.state = "starting";     // starting | syncing | ready | stopped
        this.pendingCommits = new Map();   // op.id -> {resolve, reject, timer}
        this.buffer = [];
        this.syncReqId = null;
        this.syncStarted = false;          // saw our own snap.req in the stream
        this.syncTimer = null;
        this.readyWaiters = [];
        this.stats = { applied: 0, published: 0, snapshotsServed: 0, resyncs: 0 };
    }

    isReady() { return this.state === "ready"; }

    async start({ apply, snapshot, restore, hydrate, onDirect }) {
        this.apply = apply;
        this.snapshot = snapshot;
        this.restore = restore;
        this.hydrate = hydrate;
        this.onDirect = onDirect || (() => {});
        this.pub = new RespConnection(this.url, { name: "redis-pub", log: this.log });
        this.sub = new RespConnection(this.url, { name: "redis-sub", subscriber: true, log: this.log });
        this.sub.on("message", (ch, payload) => this._onMessage(ch, payload));
        this.sub.on("down", () => {
            // Messages may be lost while disconnected: this node's copy of the
            // state can no longer be trusted. Resync once Redis is back.
            if (this.state === "ready" || this.state === "syncing") {
                this.state = "syncing";
                this.resyncNeeded = true;
                clearTimeout(this.syncTimer);
                this.log.warn("[cluster] lost Redis subscription — will resync from a peer");
            }
        });
        this.sub.on("ready", () => {
            if (this.state === "syncing" && this.resyncNeeded) { this.resyncNeeded = false; this._beginSync(true); }
        });
        await this.sub.subscribe(this.opsChannel, this.nodeChannel(this.nodeId));
        this.sub.connect();
        this.pub.connect();
        await Promise.all([this.sub.waitReady(), this.pub.waitReady()]);
        this.state = "syncing";
        await this._beginSync(false);
        await new Promise((resolve) => { if (this.state === "ready") resolve(); else this.readyWaiters.push(resolve); });
    }

    async _beginSync(isResync) {
        if (isResync) this.stats.resyncs++;
        this.syncReqId = crypto.randomUUID();
        this.syncStarted = false;
        this.buffer = [];
        clearTimeout(this.syncTimer);
        const req = { t: "snap.req", reqId: this.syncReqId, id: crypto.randomUUID(), node: this.nodeId, now: Date.now() };
        try {
            await this.pub.command(["PUBLISH", this.opsChannel, JSON.stringify(req)]);
        } catch (e) {
            this.log.warn(`[cluster] snapshot request failed (${e.message}); retrying`);
            setTimeout(() => this._beginSync(isResync), 1000).unref?.();
        }
    }

    _finishSync(snap) {
        clearTimeout(this.syncTimer);
        this.syncTimer = null;
        if (snap) this.restore(snap);
        else if (this.hydrate) this.hydrate();
        const replay = this.buffer.splice(0);
        this.state = "ready";
        this.syncReqId = null;
        for (const op of replay) this._applyOne(op);
        this.log.log(`[cluster] node ${this.nodeId} in sync (${snap ? "snapshot from a peer" : "no peers: loaded from the database"}, ${replay.length} op(s) replayed)`);
        this.readyWaiters.splice(0).forEach((fn) => fn());
    }

    _onMessage(channel, payload) {
        let msg;
        try { msg = JSON.parse(payload); } catch { return; }
        if (channel === this.opsChannel) return this._onOp(msg);
        if (channel === this.nodeChannel(this.nodeId)) {
            if (msg.kind === "snap") {
                if (this.state === "syncing" && this.syncStarted && msg.reqId === this.syncReqId) this._finishSync(msg.state);
                return;
            }
            try { this.onDirect(msg); } catch (e) { this.log.error("[cluster] direct message handler failed:", e); }
        }
    }

    _onOp(op) {
        if (op.t === "snap.req") {
            if (op.node === this.nodeId) {
                if (this.state === "syncing" && op.reqId === this.syncReqId) {
                    // Our cut point: everything after this is replayed on top
                    // of whichever snapshot arrives first.
                    this.syncStarted = true;
                    this.syncTimer = setTimeout(() => this._finishSync(null), this.snapshotWaitMs);
                }
                return;
            }
            if (this.state === "ready") {
                // Every up-to-date node answers with its state at exactly
                // this point of the stream; the newcomer takes the first.
                let state;
                try { state = this.snapshot(); } catch (e) { this.log.error("[cluster] snapshot failed:", e); return; }
                this.stats.snapshotsServed++;
                this.pub.command(["PUBLISH", this.nodeChannel(op.node), JSON.stringify({ kind: "snap", reqId: op.reqId, from: this.nodeId, state })])
                    .catch((e) => this.log.warn(`[cluster] could not send snapshot: ${e.message}`));
            }
            return;
        }
        if (this.state === "syncing") { if (this.syncStarted) this.buffer.push(op); return; }
        if (this.state !== "ready") return;
        this._applyOne(op);
    }

    _applyOne(op) {
        let result, error = null;
        try { result = this.apply(op); } catch (e) { error = e; this.log.error(`[cluster] apply ${op.t} failed:`, e); }
        this.stats.applied++;
        const p = this.pendingCommits.get(op.id);
        if (p) {
            this.pendingCommits.delete(op.id);
            clearTimeout(p.timer);
            if (error) p.reject(error); else p.resolve(result);
        }
    }

    commit(op) {
        op.id = op.id || crypto.randomUUID();
        op.node = this.nodeId;
        if (!Number.isFinite(op.now)) op.now = Date.now();
        return new Promise((resolve, reject) => {
            if (this.state === "stopped") return reject(new Error("cluster-stopped"));
            const timer = setTimeout(() => {
                if (this.pendingCommits.delete(op.id)) reject(new Error("cluster-timeout"));
            }, this.commitTimeoutMs);
            timer.unref?.();
            this.pendingCommits.set(op.id, { resolve, reject, timer });
            this.pub.command(["PUBLISH", this.opsChannel, JSON.stringify(op)])
                .then(() => { this.stats.published++; })
                .catch((e) => {
                    if (this.pendingCommits.delete(op.id)) { clearTimeout(timer); reject(new Error(`cluster-unavailable: ${e.message}`)); }
                });
        });
    }

    sendToNode(nodeId, msg) {
        if (nodeId === this.nodeId) { try { this.onDirect(msg); } catch (e) { this.log.error(e); } return Promise.resolve(); }
        return this.pub.command(["PUBLISH", this.nodeChannel(nodeId), JSON.stringify(msg)]).then(() => undefined);
    }

    stop() {
        this.state = "stopped";
        clearTimeout(this.syncTimer);
        this.pendingCommits.forEach((p) => { clearTimeout(p.timer); p.reject(new Error("cluster-stopped")); });
        this.pendingCommits.clear();
        this.pub && this.pub.close();
        this.sub && this.sub.close();
    }
}

function createBus({ redisUrl, prefix, nodeId, log } = {}) {
    if (!redisUrl) return new LocalBus({ nodeId });
    return new RedisBus({ url: redisUrl, prefix, nodeId, log });
}

// ---------------------------------------------------------------------------
// Official Socket.IO Redis adapter (optional). When installed
// (npm install @socket.io/redis-adapter redis) it carries point-to-point
// socket messages between processes; without it the bus's node channel
// does the same job. Returns true when attached.
// ---------------------------------------------------------------------------
async function attachSocketIoAdapter(io, redisUrl, { prefix = "mapunite", log = console } = {}) {
    if (!redisUrl) return false;
    let createAdapter, createClient;
    try {
        ({ createAdapter } = require("@socket.io/redis-adapter"));
        ({ createClient } = require("redis"));
    } catch {
        log.log("[cluster] @socket.io/redis-adapter not installed — cross-process socket messages use the MapUnite bus instead");
        return false;
    }
    const pubClient = createClient({ url: redisUrl });
    const subClient = pubClient.duplicate();
    pubClient.on("error", (e) => log.warn(`[cluster] adapter pub: ${e.message}`));
    subClient.on("error", (e) => log.warn(`[cluster] adapter sub: ${e.message}`));
    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient, { key: `${prefix}#io` }));
    log.log("[cluster] Socket.IO Redis adapter attached");
    return true;
}

module.exports = { createBus, LocalBus, RedisBus, RespConnection, RespParser, encodeCommand, parseRedisUrl, attachSocketIoAdapter, makeNodeId };
