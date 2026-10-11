// @ts-check
/* ============================================================================
   MapUnite Master AI — the brain (the Master itself)
   ==============================================================================
   Sub-agents observe and report; the brain decides what reaches the rider.

     agent ──report──▶ normalize ──▶ policies ──▶ queue ──▶ persona ──▶ output
                        (contracts)   (pluggable)  (priority)  (words)   (gate + voice + island)

   1. Every "report.**" envelope is normalized into a Report (contracts.js).
   2. POLICIES run in order; each may pass, change or drop the report. The
      defaults: expired → drop; ridingOnly while not riding → drop; low
      confidence → drop (never a critical one); the same kind on the same key
      said recently → drop (unless it got more serious). New behaviour = brain.use(name, fn), no
      edits here.
   3. A newer report with the same key replaces a queued one ("network.lost"
      followed by "network.restored" before it was said → only "restored").
   4. Critical reports skip the queue. Others leave the queue highest priority
      first, one at a time, at least gapMs apart, never while the voice is busy;
      stale ones expire in the queue.
   5. The persona turns the report into words; output speaks through the
      app's safety gate and shows the status island.
   6. Every decision is published on "master.decision" (debug / tests) and
      every line on "master.said" (a chat feed can show the transcript).
   7. ASK FIRST: when output asks the rider first ("Bhai, ek baat bolun?"),
      the decision is "asking"; nothing else leaves the queue until the answer
      is in. Then: "spoken" (yes), "declined" (nahi), "unanswered" (silence),
      or "interrupted" (a turn or warning cut in: offered once more if fresh).

   DELEGATION: brain.delegate("deep-search", { query }) asks whichever agent
   handles "task.deep-search" and returns { ok, result } or { ok: false, error }.
   The brain doesn't know or care which agent that is.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const W = /** @type {any} */ (root); (W.MUMaster || (W.MUMaster = {})).brain = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    /**
     * @param {{
     *   bus: any, contracts: any, persona: any, output: { say: Function, busy: () => boolean },
     *   now?: () => number, timers?: { setTimeout: Function, clearTimeout: Function },
     *   config?: { gapMs?: number, minConfidence?: number, busyRetryMs?: number, maxPending?: number, transcriptSize?: number }
     * }} opts
     */
    function createBrain(opts) {
        const { bus, contracts: C, persona, output } = opts;
        const now = opts.now || (() => Date.now());
        const timers = opts.timers || globalThis;
        const cfg = { gapMs: 2500, minConfidence: 0.35, busyRetryMs: 400, maxPending: 40, transcriptSize: 60, ...(opts.config || {}) };
        /** @type {any[]} */ const pending = [];
        /** @type {Map<string, { at: number, rank: number, kind: string }>} */ const lastSaid = new Map();
        /** @type {Array<{ name: string, fn: Function, order: number }>} */ const policies = [];
        /** @type {any[]} */ const transcript = [];
        /** @type {Record<string, any>} world state: state.<name> → value */ const world = {};
        let lastDeliveredAt = -Infinity, disposed = false, asking = false;
        /** @type {any} */ let pumpTimer = null;
        /** @type {Function[]} */ const unsubs = [];

        function decision(/** @type {any} */ r, /** @type {string} */ action, /** @type {string} */ reason) {
            bus.publish(C.TOPIC.decision, { id: r && r.id, kind: r && r.kind, source: r && r.source, severity: r && r.severity, action, reason: reason || "" }, { source: "master" });
        }

        const api = Object.freeze({
            now, world, config: cfg,
            /** @param {string} key */ lastSaid: (key) => lastSaid.get(key) || null,
            pending: () => pending.slice()
        });

        /**
         * Add a policy. fn(report, api) → report (pass / changed) | null | { drop: reason }.
         * Lower order runs first; the defaults use 10–40.
         * @param {string} name @param {(report: any, api: any) => any} fn @param {{ order?: number }} [o]
         * @returns {() => void} remove
         */
        function use(name, fn, o = {}) {
            const p = { name, fn, order: Number.isFinite(o.order) ? /** @type {number} */ (o.order) : 50 };
            policies.push(p);
            policies.sort((a, b) => a.order - b.order);
            return () => { const i = policies.indexOf(p); if (i >= 0) policies.splice(i, 1); };
        }

        // ---- default policies
        use("expired", (r) => (r.expiresAt > now() ? r : { drop: "expired" }), { order: 10 });
        use("riding-only", (r) => (!r.ridingOnly || (world.ride && world.ride.active) ? r : { drop: "not riding" }), { order: 20 });
        use("confidence", (r) => (r.severity === "critical" || r.confidence >= cfg.minConfidence ? r : { drop: `low confidence (${r.confidence})` }), { order: 30 });
        use("cooldown", (r) => {
            const l = lastSaid.get(r.key);
            // first time, a different kind on the same key (a change of state), or more serious now
            if (!l || l.kind !== r.kind || C.RANK[r.severity] > l.rank) return r;
            return now() - l.at < r.cooldownMs ? { drop: "said recently" } : r;
        }, { order: 40 });

        /** @param {any} raw @param {string} source */
        function ingest(raw, source) {
            if (disposed) return;
            const n = C.normalizeReport(raw, { source, now: now() });
            if (!n.ok) { decision({ kind: raw && raw.kind, source }, "rejected", n.errors.join("; ")); return; }
            let r = n.report;
            for (const p of policies) {
                /** @type {any} */ let out;
                try { out = p.fn(r, api); } catch (e) { out = r; }              // a broken policy never swallows a report
                if (out == null || out === false) { decision(r, "dropped", p.name); return; }
                if (out.drop) { decision(r, "dropped", `${p.name}: ${out.drop}`); return; }
                if (out !== r && typeof out.kind === "string") {
                    const re = C.normalizeReport({ ...out }, { source: r.source, now: r.at });
                    if (re.ok) r = re.report;
                }
            }
            const i = pending.findIndex((p) => p.key === r.key);
            if (i >= 0) { decision(pending[i], "superseded", `by ${r.id}`); pending.splice(i, 1); }
            if (r.severity === "critical" || r.severity === "info") { deliver(r); return; }
            pending.push(r);
            pending.sort((a, b) => b.priority - a.priority || a.at - b.at);
            if (pending.length > cfg.maxPending) for (const x of pending.splice(cfg.maxPending)) decision(x, "dropped", "queue full");
            pump();
        }

        function schedule(/** @type {number} */ ms) {
            if (pumpTimer || disposed) return;
            pumpTimer = timers.setTimeout(() => { pumpTimer = null; pump(); }, ms);
        }

        function pump() {
            if (disposed || pumpTimer) return;
            const t = now();
            for (let i = pending.length - 1; i >= 0; i--) if (pending[i].expiresAt <= t) { decision(pending[i], "dropped", "expired in queue"); pending.splice(i, 1); }
            if (!pending.length) return;
            const wait = lastDeliveredAt + cfg.gapMs - t;
            if (wait > 0) { schedule(wait); return; }
            let isBusy = asking;
            try { isBusy = isBusy || output.busy(); } catch (e) { /* treat as idle */ }
            if (isBusy) { schedule(cfg.busyRetryMs); return; }
            deliver(pending.shift());
            if (pending.length) schedule(cfg.gapMs);
        }

        /** What the rider got, in one word, from output's result. */
        function actionOf(/** @type {any} */ res) {
            const why = String((res && res.reason) || "");
            if (res && res.spoken) return "spoken";
            if (why === "asked:no") return "declined";
            if (why === "asked:silence" || why === "asked:unclear" || why === "asked:timeout") return "unanswered";
            if (why === "asked:interrupted") return "interrupted";
            return res && res.shown ? "shown" : "held";
        }

        function deliver(/** @type {any} */ r) {
            const words = persona.phrase(r, world);
            /** @type {{ spoken: boolean, shown: boolean, reason: string, pending?: Promise<any> }} */ let res;
            try {
                res = output.say({ text: words.text, display: words.display, severity: r.severity, priority: r.priority, category: r.category, key: r.key, kind: r.kind, speak: r.speak });
            } catch (e) { res = { spoken: false, shown: false, reason: `output error: ${String((e && /** @type {any} */ (e).message) || e)}` }; }
            const t = now();
            if (r.severity !== "info") lastDeliveredAt = t;
            lastSaid.set(r.key, { at: t, rank: C.RANK[r.severity], kind: r.kind });
            const record = (/** @type {any} */ final) => {
                const entry = Object.freeze({ at: now(), id: r.id, kind: r.kind, source: r.source, severity: r.severity, text: words.text, title: words.display.title, spoken: Boolean(final.spoken), shown: Boolean(final.shown), asked: String(final.reason || "").startsWith("asked:") });
                transcript.push(entry);
                if (transcript.length > cfg.transcriptSize) transcript.splice(0, transcript.length - cfg.transcriptSize);
                bus.publish(C.TOPIC.said, entry, { source: "master" });
                decision(r, actionOf(final), final.reason);
            };
            if (res.pending && typeof res.pending.then === "function") {
                // "Bhai, ek baat bolun?" is running: nothing else from the Master until the answer is in.
                asking = true;
                decision(r, "asking", "ask first");
                const after = (/** @type {any} */ final) => {
                    asking = false;
                    lastDeliveredAt = now();
                    record(final);
                    // cut off by something more urgent (a turn, a warning): offer it once more if it's still fresh
                    if (final.reason === "asked:interrupted" && !r.retried && r.expiresAt > now()) {
                        pending.push(Object.freeze({ ...r, retried: true }));
                        pending.sort((a, b) => b.priority - a.priority || a.at - b.at);
                    }
                    pump();
                };
                res.pending.then(after, () => after({ spoken: false, shown: false, reason: "asked:error" }));
                return;
            }
            record(res);
        }

        /**
         * Hand a job to whichever agent handles task.<name>.
         * @param {string} task @param {any} [payload] @param {{ timeoutMs?: number }} [o]
         * @returns {Promise<{ ok: true, result: any } | { ok: false, error: string, message: string }>}
         */
        async function delegate(task, payload, o = {}) {
            bus.publish("master.delegated", { task, at: now() }, { source: "master" });
            try {
                const result = await bus.request(C.TOPIC.task(task), payload, { timeoutMs: o.timeoutMs ?? 15000, source: "master" });
                return { ok: true, result };
            } catch (err) {
                const e = /** @type {any} */ (err);
                return { ok: false, error: (e && e.code) || "ERROR", message: String((e && e.message) || e) };
            }
        }

        unsubs.push(bus.subscribe("state.**", (/** @type {any} */ data, /** @type {any} */ env) => { world[env.topic.slice(6)] = data; }, { owner: "master", replay: true }));
        unsubs.push(bus.subscribe("report.**", (/** @type {any} */ data, /** @type {any} */ env) => ingest(data, env.source), { owner: "master" }));

        return {
            use, delegate,
            /** Say something on the app's behalf (goes through the same pipeline). @param {any} report */
            tell(report) { ingest(report, "app"); },
            world,
            transcript: () => transcript.slice(),
            pending: () => pending.slice(),
            policies: () => policies.map((p) => p.name),
            dispose() {
                disposed = true;
                if (pumpTimer) { timers.clearTimeout(pumpTimer); pumpTimer = null; }
                for (const fn of unsubs.splice(0)) fn();
                pending.length = 0;
            }
        };
    }

    return { createBrain };
});
