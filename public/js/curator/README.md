# Bike curator (`public/admin/curator.html`, `public/js/curator/`)

An internal tool for admins. When riders can't find their bike they send "My bike isn't listed" requests. The curator turns those into reviewed bundles: the admin enters the specs and the picture (`image_url`), records where each value came from, watches the contract checks and a physics preview update live, and approves.

It isn't linked from the app, it is `noindex`, and the service worker doesn't precache it. All data goes through the admin API, behind an admin token.

| File | What it does |
|---|---|
| `admin/curator.html` | The page. Scripts are loaded from absolute `/js/...` paths, with no inline script, so it works under the app's CSP. |
| `curator-page.js` | Boot: reads `/bikedb/catalog.json` and bundles. The API base is `window.MU_CURATOR_API` if set, otherwise the page's origin. |
| `curator.js` | `MUCurator.app.mount(root, deps)`: the UI. |
| `draft.js` | `MUCurator.draft`: pure. Form sections generated from `BikeContract.FIELDS`, identity guessing from the request text, ids, `setValue` with provenance, PS/hp → kW, `toRuntime` (SI via `toSI`), and the physics `preview`. |
| `api.js` | `MUCurator.api`: `createCuratorApi()` (server) and `createLocalApi()` (offline, the same surface). |
| `curator.css` | Styles, scoped under `.cu`. |

## Using it

1. Paste the admin token and press **Connect**. The token is kept in `sessionStorage` (`mu.curator.token`) and is gone when the tab closes. Without a server the tool runs in **offline mode**: **Import requests…** reads a JSON file (the app's outbox, or the server's export).
2. **Queued** lists requests, most asked first. Identical descriptions are merged, with a count.
3. Pick one. Close catalogue matches are shown at the top; **Same bike** marks the request as a duplicate of that catalogue bike.
4. Fill in the form, which is generated from the contract:
   - **Identity:** the class select resets the powertrain blocks when the powertrain changes.
   - **Picture (required to approve):** `image.url` (https only) plus the source that published it. It becomes `image_url` in the catalogue. Approved bikes never fall back to the class silhouette: without a picture, the checks show an error on `image.url` and **Approve** stays disabled. This rule is `MUCurator.draft.approvalErrors()`, added on top of the contract. The contract itself still allows no picture, so class defaults and `pending/` files keep validating.
   - **Sources**, then every value with its source, a confidence (capped by `CONF_CAP` for the source's kind), and an optional note or tolerance.
   - **Fuel approvals:** manufacturer-certified only. This is a locked decision.
5. The right-hand rail updates as you type:
   - **Checks:** `validateBundle` errors and warnings, each linked to its field.
   - **Physics preview:** km/L (or Wh/km) at 40, 60 and 80 km/h against the class default, the eco band, top speed against the published figure, and range. A gap over 35 % from the class, or 15 % on top speed, usually means a typo or a wrong unit.
6. **Approve** is disabled while there are errors. **Save draft** (Ctrl+S) and **Download JSON** are always available. **Reject…** asks for a reason.
7. Drafts also autosave locally (`mu.curator.drafts.v1`). J and K move through the list.

## Admin API the server needs to provide

All endpoints take and return JSON and require `Authorization: Bearer <ADMIN_TOKEN>`. Any other caller gets 401/403, which the UI shows as "The server didn't accept this admin token."

| Method & path | Body | Returns |
|---|---|---|
| `GET /api/admin/bike-requests?status=queued\|drafted\|approved\|rejected\|duplicate\|all` | — | `{ requests: [{ id, description, classKey, createdAt, count, status, draft?, resolution? }] }` |
| `GET /api/admin/bikedb/reference` | — | `{ fuelGrades, emissionStandards }`: the two files in `data/bikes/reference/` |
| `PUT /api/admin/bike-requests/:id/draft` | `{ draft }` | `{ ok }`: store it and set the status to `drafted` |
| `POST /api/admin/bike-requests/:id/approve` | `{ bundle }` | `{ ok, id, location: "variants" \| "pending", errors?, warnings? }` |
| `POST /api/admin/bike-requests/:id/reject` | `{ reason }` | `{ ok }` |
| `POST /api/admin/bike-requests/:id/duplicate` | `{ bikeId }` | `{ ok }` |

The requests come from the app's existing `POST /api/bikes/request` (`{ description, classKey }`, see `garage/store.js`). The server should merge identical descriptions and count them.

### What approve must do on the server

The browser's checks are only a convenience. The server decides:

1. **Validate again** with the same contract: `BikeContract.validateBundle(bundle, ref)`, i.e. what `scripts/bikedb/validate.mjs` runs. **Also apply the approval rules**: `require("public/js/curator/draft.js").approvalErrors(bundle)` must be empty, which means a bundle with no `image.url` is never written to `variants/`. Check that `bundle.id` is a safe slug (`/^[a-z0-9-]+$/`) before using it in a path.
2. **Write** `data/bikes/variants/<id>.json` if both checks pass. If it doesn't, write `data/bikes/pending/<id>.json` and return `location: "pending"` with the blocking errors; the UI shows the first one. Then run `node scripts/bikedb/format.mjs`, so the file is in canonical one-value-per-line form and diffs stay reviewable.
3. **Rebuild** the catalogue: `node scripts/build-bike-catalog.mjs`. It writes nothing unless every file validates. It converts to strict SI, keeps the published figures as metadata, and emits `image_url` for every row. The 25 bikes already in `variants/` predate this rule and still have `image_url: null`; add an `image: { url, src }` block to each of those files and rebuild, so the whole catalogue matches. The catalogue's `version` changes with the content, so phones refetch it.
4. Mark the request as `approved` with `resolution: <id>`.

Keep `data/bikes/` under version control, so a commit is the audit trail of who approved what.

### Offline mode

`createLocalApi(localStorage)` offers the same calls without a server. Approve hands back the bundle as a download. Commit it to `data/bikes/variants/`, then run `node scripts/bikedb/format.mjs`, `node scripts/bikedb/validate.mjs` and `node scripts/build-bike-catalog.mjs`.

## Tests

`node --test test/curator/` (9 tests): the picture-required approval rule, form generation from the contract, identity guessing, ids, `setValue` with provenance, PS/hp conversion, `toRuntime` in SI, the physics preview against the class default, request merging, and the API client (token header, 401 message, local approve).
