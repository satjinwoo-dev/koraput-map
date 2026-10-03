import { loadCatalog, loadPending, Contract, ROOT } from "../../scripts/bikedb/load-catalog.mjs";
export { Contract, ROOT };
export const catalog = loadCatalog();
export const pending = loadPending();
export const ref = catalog.ref;
/** Catalog AND pending bundles by id (pending ones are not shipped, but tests use them). */
export const byId = Object.fromEntries([...catalog.entries, ...pending].map((e) => [e.bundle.id, e.bundle]));
/** Deep copy of a seed bundle, ready to mutate. */
export const clone = (id) => {
    if (!byId[id]) throw new Error(`no seed bundle ${id}`);
    return structuredClone(byId[id]);
};
export const codes = (r) => r.errors.map((e) => e.code);
export const has = (r, code, pathPart = "") => r.errors.some((e) => e.code === code && e.path.includes(pathPart));
export const hasWarn = (r, code, pathPart = "") => r.warnings.some((w) => w.code === code && w.path.includes(pathPart));
