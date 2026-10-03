// @ts-check
/* ============================================================================
   MapUnite garage — rider settings
   ==============================================================================
   Weight, usual pillion and luggage, sprockets (manual bikes), rear tyre and
   the fuel in the tank. Values are checked as the rider types; only valid
   settings are passed on (and saved on the phone by the caller).

   Fuel safety: a fuel is only described as approved when the bundle's
   fuelAdvice (decided by the data contract from manufacturer certification)
   lists it. Choosing any other fuel shows a warning to check the owner's
   manual. Flex-fuel blends (E85/E100) aren't offered unless the engine is
   certified flex-fuel.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUGarage || (/** @type {any} */ (root).MUGarage = {}); ns.settings = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    /**
     * @template {keyof HTMLElementTagNameMap} K
     * @param {K} tag @param {Record<string, any>} [attrs] @param {Array<Node|string|null|false>} [kids]
     * @returns {HTMLElementTagNameMap[K]}
     */
    function h(tag, attrs = {}, kids = []) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (v === undefined || v === null || v === false) continue;
            if (k === "class") el.className = v;
            else if (k === "text") el.textContent = v;
            else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v === true ? "" : String(v));
        }
        for (const c of kids) if (c !== null && c !== false) el.append(c);
        return el;
    }

    /**
     * Which fuels to offer, and whether each is approved for this bike.
     * @param {any} bundle  runtime bundle
     * @returns {Array<{ code: string, approved: boolean }>}
     */
    function fuelChoices(bundle) {
        const grades = (bundle.reference && bundle.reference.fuelGrades && bundle.reference.fuelGrades.grades) || [];
        const advisable = new Set((bundle.fuelAdvice && bundle.fuelAdvice.advisable) || []);
        const flex = !!(bundle.engine && bundle.engine.flexFuel && bundle.engine.flexFuel.v === true);
        return grades.filter((g) => !g.flexFuelBlend || flex).map((g) => ({ code: g.code, approved: advisable.has(g.code) }));
    }

    /**
     * Validate raw form values. Returns { settings, errors } (errors keyed by field).
     * @param {Record<string, string>} raw @param {{ manual: boolean, ev: boolean, parseTyre: (s: string) => any, fuels: string[] }} ctx
     */
    function validate(raw, ctx) {
        /** @type {Record<string, any>} */ const settings = {};
        /** @type {Record<string, string>} */ const errors = {};
        const numField = (key, lo, hi, label) => {
            const t = String(raw[key] ?? "").trim();
            if (!t) return;
            const n = Number(t.replace(",", "."));
            if (!Number.isFinite(n) || n < lo || n > hi) errors[key] = `${label} must be between ${lo} and ${hi} kg.`;
            else if (n > 0) settings[key] = n;
        };
        numField("riderMass", 30, 200, "Your weight");
        numField("pillionMass", 0, 200, "Pillion weight");
        numField("luggageMass", 0, 100, "Luggage");
        if (ctx.manual) {
            const f = String(raw.frontSprocket ?? "").trim(), r = String(raw.rearSprocket ?? "").trim();
            if (f || r) {
                const fi = Number(f), ri = Number(r);
                if (!Number.isInteger(fi) || !Number.isInteger(ri) || fi < 9 || fi > 25 || ri < 25 || ri > 70) errors.sprockets = "Enter both sprockets as tooth counts: front 9–25, rear 25–70.";
                else { settings.frontSprocket = fi; settings.rearSprocket = ri; }
            }
        }
        const tyre = String(raw.rearTyre ?? "").trim();
        if (tyre) { try { ctx.parseTyre(tyre); settings.rearTyre = tyre; } catch { errors.rearTyre = "Use the size printed on the tyre, e.g. 140/70-17 or 2.75-18."; } }
        if (!ctx.ev && raw.fuelCode && ctx.fuels.includes(raw.fuelCode)) settings.fuelCode = raw.fuelCode;
        return { settings, errors };
    }

    /**
     * @param {HTMLElement} root
     * @param {{ bundle: any, settings: any, physics: any, onChange: (s: any) => void }} o
     */
    function createSettings(root, o) {
        const b = o.bundle;
        const ev = b.powertrain === "ev";
        const manual = b.powertrain === "ice_manual";
        const uid = `st${Math.random().toString(36).slice(2, 8)}`;
        const fuels = ev ? [] : fuelChoices(b);
        const s0 = o.settings || {};
        const priorRider = b.priors && b.priors.riderMass ? Math.round(b.priors.riderMass.mean) : 72;
        const stockTyre = b.chassis && b.chassis.rearTyre ? b.chassis.rearTyre.v : "";
        root.classList.add("mu-settings");
        root.replaceChildren();

        /** @type {Record<string, HTMLInputElement|HTMLSelectElement>} */ const inputs = {};
        /** @type {Record<string, HTMLElement>} */ const errs = {};
        const field = (key, label, input, hint) => {
            input.id = `${uid}-${key}`;
            inputs[key] = input;
            const err = h("p", { class: "mu-field-error", id: `${uid}-${key}-err`, role: "alert", hidden: true });
            errs[key] = err;
            input.setAttribute("aria-describedby", `${uid}-${key}-err${hint ? ` ${uid}-${key}-hint` : ""}`);
            return h("div", { class: "mu-field" }, [
                h("label", { for: input.id, text: label }),
                input,
                hint ? h("p", { class: "mu-field-hint", id: `${uid}-${key}-hint`, text: hint }) : null,
                err
            ]);
        };
        const kg = (key, value, placeholder) => h("input", { type: "text", inputmode: "decimal", class: "mu-text-input mu-num", value: value ?? "", placeholder, autocomplete: "off" });

        const form = h("form", { class: "mu-settings-form", novalidate: true, onsubmit: (e) => e.preventDefault() });
        form.append(
            h("h3", { text: "You and your load" }),
            h("div", { class: "mu-field-row" }, [
                field("riderMass", "Rider with gear (kg)", kg("riderMass", s0.riderMass, `${priorRider} (typical)`)),
                field("pillionMass", "Usual pillion (kg)", kg("pillionMass", s0.pillionMass, "none"))
            ]),
            field("luggageMass", "Luggage (kg)", kg("luggageMass", s0.luggageMass, "none"))
        );

        if (manual) {
            const fr = b.transmission && b.transmission.finalRatio ? Number(b.transmission.finalRatio.v) : null;
            const stock = fr ? `Leave empty for stock (final drive ${fr.toFixed(2)}:1).` : "Leave empty for the stock sprockets.";
            const front = h("input", { type: "text", inputmode: "numeric", class: "mu-text-input mu-num", value: s0.frontSprocket ?? "", placeholder: "front", "aria-label": "Front sprocket teeth" });
            const rear = h("input", { type: "text", inputmode: "numeric", class: "mu-text-input mu-num", value: s0.rearSprocket ?? "", placeholder: "rear", "aria-label": "Rear sprocket teeth" });
            inputs.frontSprocket = front; inputs.rearSprocket = rear;
            const err = h("p", { class: "mu-field-error", id: `${uid}-spr-err`, role: "alert", hidden: true });
            errs.sprockets = err;
            front.setAttribute("aria-describedby", `${uid}-spr-err ${uid}-spr-hint`);
            rear.setAttribute("aria-describedby", `${uid}-spr-err ${uid}-spr-hint`);
            form.append(h("h3", { text: "Your bike" }), h("div", { class: "mu-field" }, [
                h("span", { class: "mu-label-text", id: `${uid}-spr-label`, text: "Sprockets (teeth), if you changed them" }),
                h("div", { class: "mu-sprockets", role: "group", "aria-labelledby": `${uid}-spr-label` }, [front, h("span", { class: "mu-sprocket-x", "aria-hidden": "true", text: "/" }), rear]),
                h("p", { class: "mu-field-hint", id: `${uid}-spr-hint`, text: stock }),
                err
            ]));
        } else form.append(h("h3", { text: "Your bike" }));
        form.append(field("rearTyre", "Rear tyre size", h("input", { type: "text", class: "mu-text-input", value: s0.rearTyre ?? "", placeholder: stockTyre || "e.g. 140/70-17", autocomplete: "off" }), stockTyre ? `Stock: ${stockTyre}` : ""));

        let fuelNote = null;
        if (!ev && fuels.length) {
            const sel = h("select", { class: "mu-select" });
            const def = s0.fuelCode || (fuels.find((f) => f.code === "E20") ? "E20" : fuels[0].code);
            for (const f of fuels) sel.append(h("option", { value: f.code, selected: f.code === def, text: `${f.code}${f.approved ? " (approved for this bike)" : ""}` }));
            fuelNote = h("p", { class: "mu-fuel-note", role: "status" });
            form.append(field("fuelCode", "Fuel in your tank", sel), fuelNote);
        }

        root.append(form);

        let lastJson = JSON.stringify(s0);
        function collect() {
            /** @type {Record<string, string>} */ const raw = {};
            for (const [k, el] of Object.entries(inputs)) raw[k] = el.value;
            const { settings, errors } = validate(raw, { manual, ev, parseTyre: o.physics.tyre.parseTyre, fuels: fuels.map((f) => f.code) });
            for (const [k, el] of Object.entries(errs)) {
                const msg = errors[k];
                el.hidden = !msg;
                el.textContent = msg || "";
                const targets = k === "sprockets" ? [inputs.frontSprocket, inputs.rearSprocket] : [inputs[k]];
                for (const t of targets) if (t) t.setAttribute("aria-invalid", String(!!msg));
            }
            if (fuelNote && inputs.fuelCode) {
                const f = fuels.find((x) => x.code === inputs.fuelCode.value);
                const approved = fuels.filter((x) => x.approved).map((x) => x.code);
                fuelNote.classList.toggle("is-warn", !!f && !f.approved);
                fuelNote.textContent = f && f.approved
                    ? `${f.code} is approved by the manufacturer for this bike.`
                    : approved.length
                        ? `${f ? f.code : "This fuel"} isn't confirmed by the manufacturer for this bike. Approved: ${approved.join(", ")}. Check your owner's manual.`
                        : "No fuel is confirmed by the manufacturer for this bike in our data. Check your owner's manual.";
            }
            if (Object.keys(errors).length) return;
            const json = JSON.stringify(settings);
            if (json !== lastJson) { lastJson = json; o.onChange(settings); }
        }
        form.addEventListener("input", collect);
        form.addEventListener("change", collect);
        collect();

        return { collect, get inputs() { return inputs; } };
    }

    return { fuelChoices, validate, createSettings };
});
