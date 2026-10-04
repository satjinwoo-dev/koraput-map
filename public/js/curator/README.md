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
   - **Picture (required to approve):** `image.url` (https only) plus the source that published it. It becomes `image_url` in the catalogue. Approved bikes never fall back to the class silhouette: without a picture, the checks show an error on `image.url` and **Approve** stays disabled. In the browser this rule is `MUCurator.draft.approvalErrors()`. The server enforces it independently on approve, and the catalogue build enforces it for every variant (see below), so no bike can get around it.
   - **Sources**, then every value with its source, a confidence (capped by `CONF_CAP` for the source's kind), and an optional note or tolerance.
   - **Fuel approvals:** manufacturer-certified only. This is a locked decision.
5. The right-hand rail updates as you type:
   - **Checks:** `validateBundle` errors and warnings, each linked to its field.
   - **Physics preview:** km/L (or Wh/km) at 40, 60 and 80 km/h against the class default, the eco band, top speed against the published figure, and range. A gap over 35 % from the class, or 15 % on top speed, usually means a typo or a wrong unit.
6. **Approve** is disabled while there are errors. **Save draft** (Ctrl+S) and **Download JSON** are always available. **Reject…** asks for a reason.
7. Drafts also autosave locally (`mu.curator.drafts.v1`). J and K move through the list.

## The admin API (`lib/bikedb/admin-api.js`)

Mounted by `server.js` under `/api/admin`. All endpoints take and return JSON and require `Authorization: Bearer <ADMIN_TOKEN>`, compared in constant time. A wrong or missing token gets 401, which the UI shows as "The server didn't accept this admin token." **Without `ADMIN_TOKEN` on the server (or one under 16 characters) the API doesn't exist: every route answers 404.** 120 requests a minute per IP; answers are `no-store`.

| Method & path | Body | Returns |
|---|---|---|
| `GET /api/admin/bike-requests?status=queued\|drafted\|approved\|rejected\|duplicate\|all` | — | `{ requests: [{ id, description, make, model, variant, market, classKey: null, createdAt, count, status, hints, draft?, resolution?, location? }] }`, most asked first. `hints` are the riders' year / powertrain / note. |
| `GET /api/admin/bikedb/reference` | — | `{ fuelGrades, emissionStandards }`: the two files in `data/bikes/reference/` |
| `PUT /api/admin/bike-requests/:id/draft` | `{ draft }` (≤ 400 KB) | `{ ok }`: stored on the server; the status becomes `drafted` |
| `POST /api/admin/bike-requests/:id/approve` | `{ bundle }` | **200** `{ ok, id, location: "variants", warnings, catalogVersion }`, or **422** `{ ok: false, location: "pending", errors, warnings }` |
| `POST /api/admin/bike-requests/:id/reject` | `{ reason }` (≤ 500 characters) | `{ ok }` |
| `POST /api/admin/bike-requests/:id/duplicate` | `{ bikeId }` (a bike in the catalogue) | `{ ok }` |

**Where requests come from:** the app's `POST /api/bikes/requests` (`{ make, model, variant?, year?, powertrain? }`) queue, `lib/bikedb/request-queue.js`. It keeps one row per bike and one vote per rider, so `count` is the number of riders asking. The curator's state (draft, decision, where the file went) is kept in a table beside it, `bike_request_curation`. The queue's own status follows: drafted → `researching`, approved or duplicate → `added`, rejected → `rejected`. So `npm run bikes:requests` keeps showing the truth.

### What approve does on the server

The browser's checks are only a convenience. The server decides:

1. **Basic checks:** `bundle.id` is a safe slug (it becomes a file name), the bundle is a `variant`, and no bike with that id exists yet (else **409**: use **Same bike**).
2. **The picture rule:** `image.url` must be there, https, with `image.src` naming one of the bundle's sources. This is checked by the server's own `pictureErrors()` and by `draft.approvalErrors()`. The older bikes' exemption (below) is never consulted on approve.
3. **The whole contract:** `BikeContract.validateCatalog` over the catalogue plus the new bike. This covers units, sources, confidence, fuel approvals (manufacturer-certified only), priors resolving through the class default, and the catalogue's own picture rule.
4. **All pass:** the file is written to `data/bikes/variants/<id>.json` in canonical form (`scripts/bikedb/format.mjs`), and the catalogue is rebuilt in a child process (`scripts/build-bike-catalog.mjs --json`: `public/bikedb/`, `BIKES_DB_PATH`). The running server picks up the new `bikes.sqlite` within 5 s. If the rebuild fails, the file is removed again and the request stays open (**500**). Otherwise the request is marked approved, with `resolution: <id>`.
5. **Anything blocked:** the bundle goes to `data/bikes/pending/<id>.json` (validated on every run, never shipped), the answer is **422** with every reason, and the request stays open as `drafted`. The UI shows "Not approved" with the first reason.

Once a request is approved it's closed: a later draft, reject, duplicate or approve on it gets **409** ("Already approved as …"), so the queue never disagrees with `data/bikes/`. Only one approve runs at a time; a second one while the catalogue is rebuilding gets **409** and can simply be retried.

Keep `data/bikes/` under version control (the server writes into it, `BIKES_DATA_DIR`), so a commit is the audit trail of what was approved.

### The picture rule in the catalogue build

`BikeContract.validateCatalog` fails the build (`picture_required`) for any variant without `image.url`. The only exception is `BikeContract.PICTURE_GRANDFATHERED`: a frozen list of the 25 variants that were in the catalogue before the rule. Their pictures haven't been sourced yet, and a URL is never invented to fill the gap.

- The list can only shrink. A grandfathered bike that gets its picture raises a `picture_grandfathered` warning until it's taken off.
- A new id can't be added to the list without a code change, which shows up in review.
- Class defaults are the silhouettes themselves and need no picture.
- `pending/` files are never shipped, so the rule doesn't block them there.

### Offline mode

`createLocalApi(localStorage)` offers the same calls without a server. Approve hands back the bundle as a download. Commit it to `data/bikes/variants/`, then run `node scripts/bikedb/format.mjs`, `node scripts/bikedb/validate.mjs` and `node scripts/build-bike-catalog.mjs`.

## Tests

- `node --test test/server/admin-api.test.mjs`: the token (404 without one, 401 when wrong, `no-store`), the queue in the curator's shape and the status filter, the reference tables, drafts, reject and duplicate, and approve. Approve is tested for the picture rule (none, blank, http, unsourced, and a grandfathered id: all end up in `pending/`, nothing is rebuilt), the contract on the server (bad units, slug, kind, an existing id), rollback when the rebuild fails, an approved request staying closed, one approve at a time, and a real rebuild that ships the new bike's `image_url`.
- The catalogue build's picture rule is tested in `test/bikedb/contract.test.mjs`.
- `node --test test/curator/`: the picture-required approval rule, form generation from the contract, identity guessing, ids, `setValue` with provenance, PS/hp conversion, `toRuntime` in SI, the physics preview against the class default, request merging, and the API client (token header, 401 message, local approve).
