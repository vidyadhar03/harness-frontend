# Harness API contract (Phase 1: implemented)

Set `NEXT_PUBLIC_HARNESS_API_URL` to the running `harness-api` base URL (default
`http://127.0.0.1:8000`) and rebuild. This document describes what is actually
implemented today in `video-harness` (`harness/api/*`) - not a forward-looking sketch.

Server-side startup, config, and auth-boundary details live in `video-harness/README.md`
("Running the API server"). Summary: **no user auth exists yet**. The only real access
boundary is network-level: binds to `127.0.0.1` by default, `TrustedHostMiddleware`
rejects an unrecognized `Host`, and every mutation actively rejects a request whose
`Origin` header is present but not the configured frontend origin (403 - see below;
CORS headers alone do not stop a request from executing server-side, only from being
read back by a well-behaved browser). Do not expose this publicly without adding real
authentication first - see that README section before deploying anywhere but localhost.

All responses are JSON with camelCase keys. Every POST route requires
`Content-Type: application/json` (415 otherwise) **except**
`POST /projects/{projectId}/sources`, whose body is the raw file being uploaded - see
below. Every route is scoped under `/projects/{projectId}`; an unknown `projectId` is a
404, and a nested id that exists but belongs to a different project is also a 404
(never a leak of its existence).

## Creating a project and ingesting a screenplay/notes file (fresh projects)

Legacy-project compatibility and any project allowlist are explicitly **paused** - this
flow only ever creates a brand-new project and never touches an existing one. The
sequence: create → upload one or more files → start ingestion → poll → then read via
`GET /projects/{id}/locations` (above) once it succeeds.

### `POST /projects`
```json
{ "name": "Dehleez" }
```
Response `201`: `{ "id": "prj_...", "name": "Dehleez" }` - identical to the CLI's
`project create`. Use this `id` for every following call, and later as the value you'd
otherwise get from the project picker.

### `POST /projects/{projectId}/sources?filename=Episode_1_Draft.pdf`
**Raw request body = the file's own bytes** (`fetch(url, { method: "POST", body: file
})` from a browser `File`/`Blob` is exactly this - no `FormData`/multipart needed).
`filename` is a required query parameter. **One file per request** - loop client-side
for more than one; each upload succeeds/fails independently rather than one request
being an all-or-nothing batch. Enforces a configurable size limit
(`HARNESS_API_MAX_UPLOAD_BYTES`, default 50MB) **while receiving** the body, not after
buffering it - a huge upload is rejected (`413`) promptly, before all of it has even
been read.

Response `201`:
```json
{ "id": "<sha256>", "filename": "Episode_1_Draft.pdf", "mimeType": "application/pdf",
  "sizeBytes": 812433, "status": "uploaded", "created": true, "error": null }
```
- `created: false` + the same `id` means this exact content was already uploaded
  (content-addressed dedup, not by filename) - re-uploading the same file is always a
  safe no-op.
- `status: "unsupported"` + `error` for a file type the harness doesn't have a handler
  for - it's still stored (never rejected), just not ingestible; ingestion will report
  it the same way rather than this endpoint pre-guessing.
- Does **not** trigger ingestion - a separate, explicit step (below), so you can upload
  several files before starting one run.
- `413` if the body exceeds the size limit (nothing is stored). `400` for an empty body.
- No JSON/`Content-Type` requirement on this route (the body isn't JSON) - only the
  `Origin` check applies, same as every other mutation.

### `GET /projects/{projectId}/sources`
Authoritative uploaded-source listing for the Sources screen - use this after a reload
instead of trusting client-held upload responses, which don't survive a refresh.

Response `200`:
```json
[
  { "id": "<sha256a>", "filename": "Episode_1_Draft.pdf", "mimeType": "application/pdf",
    "sizeBytes": 812433, "status": "digested", "error": null },
  { "id": "<sha256b>", "filename": "director_notes.md", "mimeType": "text/markdown",
    "sizeBytes": 4021, "status": "failed", "error": "OutputTruncated: roster pass truncated" }
]
```
Fields (all always present; `error` may be `null`, nothing else is nullable):
- `id` - sha256 of the file's bytes; stable, matches what `POST .../sources` returned
  and what `POST .../ingest`'s `sourceId` expects.
- `filename`, `mimeType`, `sizeBytes` - as recorded at upload time; unchanged by
  ingestion.
- `status` - one of `uploaded | digesting | digested | failed | unsupported`, the
  harness's actual persisted `Source.status` at read time, not recomputed or inferred.
  `digesting` is a real, if narrow, possibility - only if you `GET` while a job's
  `_run_ingest` is mid-source, since that's set before the LLM call and cleared after.
- `error` - the *source's own* last-recorded failure (`"no v0 handler for <mime>"` for
  `unsupported`, or an ingestion exception's message for `failed`), taken verbatim from
  the persisted record, never invented or reconstructed. **This is a different field
  from an ingest job's `error`/`sources[].error`** (`GET .../jobs/{jobId}`, documented
  above) - a source can show `error: null` here even while the most recent job that
  touched this project failed for an unrelated reason (a different source, or a
  lock/scheduling problem that never reached this one). Don't treat one as a summary of
  the other; if you need "what happened in the last run," that's the job endpoint.

Scope and ordering:
- **Uploaded ingestion inputs only** - excludes images the *references* pipeline
  fetched and stored as `Source` rows for its own purposes (visual inspiration, not
  something anyone uploaded). A source's `docType` being `"reference"` is **not** the
  signal used for this (a genuinely uploaded lookbook can be classified that way too);
  the exclusion is internal to the harness and requires no client-side filtering -
  every row returned here is something that was actually uploaded through
  `POST .../sources`.
- Ordered by upload time, oldest first (ties broken deterministically); stable across
  repeated calls as long as the underlying data hasn't changed.
- `404` for an unknown project. Empty project → `200 []`, not `404`.

**Known limitation**: no `docType` (script/notes/lookbook/etc.) or timestamp is
included in this first slice, even though the harness has both once a file is
ingested - only the fields listed above. If the Sources screen wants to show a
human-readable document type or "uploaded 3 days ago," that needs a small follow-up
field addition, not something to infer from what's here.

### `POST /projects/{projectId}/ingest`
```json
{ "sourceId": null, "force": false }
```
`sourceId: null` (or omitted) means "every eligible source in the project," resolved
and **fixed at the moment you call this** - a file uploaded after triggering never
retroactively joins an already-running or finished job's workload. Pass a specific
`sourceId` to ingest just that one file (must belong to this project - `404`
otherwise). `force` defaults `false`; there's no UI yet for forcing a re-ingest of an
already-digested, unchanged file, so leave it `false`.

- `201 { "id": "job_..." }` - a new run started.
- `200 { "id": "job_..." }` - **the exact same request** (same `sourceId`, same `force`)
  is already queued/running for this project; same job id, idempotent trigger.
- `409` - either a **different** request is already active for this project (e.g. you
  asked to ingest everything while a specific-source run is in flight) - wait for it or
  match its parameters, or ingestion is already running **outside this API**, almost
  always `harness-memory drop`/`ingest` from the CLI on the same project - wait for it
  to finish.
- `404` - unknown project, or a given `sourceId` that doesn't belong to it.

Ingestion shares the harness's existing one-ingest-at-a-time-per-project lock with the
CLI (not a second, API-only lock) - so a CLI run and an API-triggered run can never
overlap and corrupt the same project's data, at the cost of the 409 case above when
they collide.

### `GET /projects/{projectId}/jobs/{jobId}` (ingest jobs)
Same endpoint as references jobs (above), with ingest-specific fields:
```json
{ "status": "succeeded", "outcome": "partial", "warnings": [],
  "sources": [
    { "sourceId": "<sha256>", "filename": "Episode_1_Draft.pdf", "status": "digested",
      "docType": "script", "entitiesCreated": 17, "notesWritten": 42,
      "notesReplaced": 3, "notesReused": 39, "warnings": [], "error": null },
    { "sourceId": "<sha256b>", "filename": "notes.txt", "status": "failed",
      "docType": null, "entitiesCreated": 0, "notesWritten": 0, "notesReplaced": 0,
      "notesReused": 0, "warnings": [], "error": "TimeoutError: ..." }
  ] }
```
- `outcome` is one of `"complete"` (every attempted source digested/skipped),
  `"partial"` (some failed, some didn't), `"failed"`, or `"no_op"` (nothing was eligible
  to attempt - e.g. no files uploaded yet). Check this even when `status` is
  `"succeeded"`, since `"succeeded"` covers `complete`/`partial`/`no_op` alike.
- **If every attempted source failed, `status` is `"failed"`** (top-level `error`
  summarizes it), not `"succeeded"` with an empty-looking result - do not present this
  as successful ingestion or auto-advance to `GET .../locations` on the strength of it.
  `sources` is still populated on a `"failed"` ingest job (unlike references jobs) so
  the UI can show exactly what went wrong per file.
- A per-source `"failed"` entry inside an otherwise `"succeeded"` (`outcome: "partial"`)
  job is expected and not itself cause for alarm - show it, don't block on it.

## Reading data

### `GET /projects`
`[{ id, name }]` - for a project picker. Real `prj_*` ids; nothing here is ever the
`"temple"/"village"/"well"/"house"` sample ids from `lib/model.ts`. **Do not seed
Firestore from the frontend's local sample workspace** - those ids are illustrative
only and must never be POSTed anywhere.

### `GET /projects/{projectId}`
`{ id, name, sourceCount, noteCount, locationCount, sceneCount }`

### `GET /projects/{projectId}/locations`
Sidebar nav data, one call, no per-location N+1 (deliberately lightweight - see
`harness/api/mapping.py:location_summaries`):
```json
[{ "id": "loc_22e2401bba84", "name": "Tree Temple", "aliases": ["Temple"],
   "status": "proposed", "parentName": "Devgram", "sceneNumbers": ["12", "13"],
   "noteCount": 6 }]
```

### `GET /projects/{projectId}/locations/{locationId}`
Read-only brief-tab data. **There is no working-brief/approval model in Phase 1** - this
is a rendering of the extracted notes the ingest pipeline wrote, grouped by kind, not an
editable brief. An editable brief with its own separate approval is explicitly a later
phase (see "Not yet built" below); do not gate anything in Phase 1 on "brief approved."
```json
{
  "id": "loc_22e2401bba84", "name": "Tree Temple", "aliases": [], "status": "proposed",
  "ancestors": ["Devgram"],
  "scenes": [{ "id": "scn_...", "number": "12", "name": "EXT. TEMPLE FORECOURT - MORNING" }],
  "descriptionNotes": [{ "id": "note_...", "kind": "description", "body": "...",
                         "status": "proposed", "revision": 1,
                         "citations": [{ "sourceId": "...", "filename": "Ep1.pdf",
                                        "page": 5, "quote": "...", "url": null, "title": null }],
                         "sceneId": null, "includeDescendants": false }],
  "constraintNotes": [ ... same shape ... ],
  "toneNotes": [ ... same shape ... ],
  "supersededSources": []
}
```
`sceneId`/`includeDescendants` mirror the note's own `applicability` (null `sceneId` =
standing, applies to the whole location) - present here and on every other note shape
in this contract so a client can tell a standing note from a scene-scoped one without
a separate lookup, e.g. before offering `POST .../notes/{noteId}/correct` below.

**`sceneRequirements`** (additive - every field above is unchanged) is the scene-scoped
half of the brief, which the three standing lists above never contain:
```json
"sceneRequirements": [
  { "sceneId": "scn_c7d4...", "number": "4", "heading": "4. INT. ANSHUL'S HOUSE - NIGHT",
    "linked": true, "notes": [] },
  { "sceneId": "scn_8fc5...", "number": "7", "heading": "7. INT./EXT. PANDIT'S DREAM - NIGHT",
    "linked": true,
    "notes": [{ "id": "note_...", "kind": "description", "body": "...", "status": "proposed",
                "revision": 1, "citations": [...], "sceneId": "scn_8fc5...",
                "includeDescendants": false,
                "ownerId": "loc_...", "owned": true, "inheritedFrom": null, "editable": true }] }
],
"outOfRosterSceneRequirements": []
```
- One entry per scene in `scenes` above (same roster, same order), whether or not it has
  notes. `notes: []` means nothing scene-specific was extracted for that scene.
- Each note carries everything `POST .../notes/{noteId}/correct` needs: `id`, `body`,
  `kind`, `revision`, `status` (echo `revision`/`status` back as `expectedRevision`/
  `expectedStatus`), plus `sceneId`, `includeDescendants`, `citations`.
- `owned`/`inheritedFrom`/`editable`: `editable` is true only for an owned
  description/constraint/tone note - the only kind of note the correction endpoint
  accepts. The list comes straight from the location's own retrieval, which today only
  yields notes the location owns (an ancestor's notes are inherited only when standing,
  never scene-scoped), so `owned` is always `true` here at present. Don't offer
  "Correct" on anything with `editable: false`.
- `outOfRosterSceneRequirements`: scene-scoped notes whose `sceneId` is **not** one of
  this location's linked scenes (`linked: false`, `number` null, `heading` is whatever
  could be resolved or the raw id). They are surfaced rather than dropped, but they are
  not linked scenes - don't render them as part of the scene list. Rare; usually means
  a scene was relinked or a note was scoped to the wrong scene.
- A standing note corrected into a scene leaves `descriptionNotes` etc. and appears
  here immediately; correcting it back reverses that. Approvals already locked keep
  their own snapshot and surface the change via `isStale`, as before.

404 for an unknown id; 400 if `locationId` resolves to a scene, not a location.

### `GET /projects/{projectId}/locations/{locationId}/references?includeRejected=false`
```json
{
  "locationId": "loc_22e2401bba84",
  "references": [{
    "id": "note_65c0c4502636",
    "title": "Timber & stone temple",
    "image": "/projects/prj_811abbb21145/references/note_65c0c4502636/image",
    "category": "Architecture",
    "facet": "Architecture",
    "reason": "Layered stone walls, carved timber and slate roofs.",
    "direction": "Timber & stone temple",
    "directionRationale": "A starting point for the shrine beneath the tree.",
    "source": "https://commons.wikimedia.org/wiki/File:Temple_in_Chitkul.jpg",
    "credit": "Marsmx · CC BY-SA 4.0",
    "license": "CC BY-SA 4.0",
    "attribution": "Marsmx",
    "selected": true,
    "status": "confirmed",
    "guidance": "canopy shape, not the bridge",
    "owned": true,
    "inheritedFrom": null,
    "revision": 1
  }]
}
```
Notes:
- **`image` is a root-relative path.** Resolve it against `apiBase` before use in
  `<img src>` (i.e. `apiBase + ref.image`), the same base used for every other request.
- **`category`/`facet` are the harness's real facet labels** - `Place | Terrain |
  Architecture | Material` - not the frontend's current `Reference["category"]` union
  (`Architecture | "Roots & canopy" | Terrain | Uploaded`). See "Frontend changes
  required" below; the API does not lossily remap these into the old union.
- **`owned: false` + `inheritedFrom`** marks a reference confirmed on a *parent* location
  (via `include_descendants`) rather than this one. Render these distinctly - they are
  not this location's own reviewed set.
- Default excludes rejected notes. Pass `includeRejected=true` to include them (status
  `"rejected"`, `selected: false`).
- `revision`/`status` here are exactly what you must echo back on the next review call
  (see below) - the API does not track "what you last saw" for you.

### `GET /projects/{projectId}/references/{noteId}/image`
Streams the image bytes (not a signed URL - see README for why: the documented local
dev credential has no signing key). Correct `Content-Type`, `Cache-Control: private,
max-age=86400` (content is sha256-addressed/immutable once digested). 404 if the note
isn't a reference or its source can't be resolved.

## Writes

### `POST /projects/{projectId}/locations/{locationId}/references/upload?filename=...`
Attaches a user-provided image directly as a reference note for a specific location.

- **Request body**: raw image bytes (`Content-Type: image/jpeg | image/png | image/webp`).
  Filename is passed as query parameter `filename`.
- **Validation**:
  - MIME must be `image/jpeg`, `image/png`, or `image/webp`.
  - Image decoded within `MAX_REFERENCE_PIXELS` (16 MP). Corrupted or animated images (e.g. animated WebP, APNG) rejected with `400`.
  - Body size bounded by `max_upload_bytes` (`413` if exceeded).
  - Validates `locationId` belongs to `projectId` (`404` if unknown, `400` if ID belongs to a scene).
- **Behavior**:
  - Creates a location-owned reference note in `"proposed"` status with `author: "user"`.
  - Does NOT call any LLM; no fake caption, direction, or external attribution is invented.
  - Dedup: if the same image bytes are already attached to this location, returns `created: false` with the existing note's current status, revision, and guidance preserved.
  - Cross-purpose: if the image bytes were previously uploaded via `POST /sources` (ingest), the existing source record is reused and retains its ingest eligibility. If uploaded here first, the source is stored with `source_purpose: "reference"` (not in `GET /sources`, not ingestible) until explicitly uploaded via `POST /sources` which atomically promotes it.
- **Response `201`**:
```json
{
  "noteId": "note_14b2d18080a2",
  "imagePath": "/projects/prj_811abbb21145/references/note_14b2d18080a2/image",
  "created": true,
  "status": "proposed",
  "revision": 1
}
```
- Preview served via `GET {imagePath}` (`GET /projects/{projectId}/references/{noteId}/image`).
- Reviewable via standard `POST /projects/{projectId}/notes/{noteId}/review`.

### `POST /projects/{projectId}/notes/{noteId}/review`
```json
{ "decision": "confirmed", "guidance": "canopy shape, not the bridge",
  "by": "jagan", "expectedRevision": 1, "expectedStatus": "proposed" }
```
or
```json
{ "decision": "rejected", "reason": "not_useful", "by": "jagan",
  "expectedRevision": 1, "expectedStatus": "proposed" }
```
`reason` must be one of the harness's actual enum: `false | wrong_scope | duplicate |
not_useful | other`. `decision` is only ever `"confirmed"` or `"rejected"` - **there is
no "unconfirm"/"deselect" action**; see "Deselecting a reference" below.

`expectedRevision` and `expectedStatus` are **both required** and enforced atomically
server-side: the write only happens if the note is still at exactly that
(revision, status) pair. Always send back what the last `GET references` (or a prior
review response) told you for that note.

Response 200:
```json
{ "id": "note_...", "status": "confirmed", "revision": 1,
  "reviewedBy": "jagan", "reviewedAt": "2026-...", "guidance": "canopy shape, not the bridge",
  "reviewReason": null }
```
`reviewReason` is null here for an ordinary confirm/reject; it comes back `"corrected"`
only for a note that `POST .../notes/{noteId}/correct` (below) replaced - this endpoint
itself never sets that value, and rejecting a note here for an ordinary reason (`false`,
`wrong_scope`, `duplicate`, `not_useful`, `other`) is unrelated to correction.

Errors:
- `404` - unknown note (or belongs to a different project).
- `400` - e.g. rejecting without a reason, or guidance on a non-reference_image note.
- `409` - **conflict**: someone else (another tab, or a references pipeline re-run)
  already changed this note since you read it. Re-`GET` the location's references and
  show the user the current state; do not retry with the same body.
- `415` - missing/wrong `Content-Type`.
- `403` - the request's `Origin` header (browsers set this automatically; nothing for
  the frontend to do) doesn't match the server's configured frontend origin. Should
  never happen from `location-studio` itself in normal operation.

### `POST /projects/{projectId}/notes/{noteId}/correct`
The human correction/split workflow for a `description`/`constraint`/`tone` note:
fixing its wording or kind, moving it between "applies to the whole location" and "only
during this scene", or splitting one note into a standing part and a scene-specific
part - e.g. the reported case where "a framed photograph is present" (standing) and
"reflected light obscures a face" (true only in one scene) were extracted as a single
note. **Nothing does this automatically** - not extraction, not this endpoint on its
own initiative; it only acts on an explicit request naming the exact new wording/scope.

This never edits the note in place. It marks the original `rejected` (with
`reviewReason: "corrected"`) and writes one or two brand-new notes as its replacement -
mirroring how this system already treats a reviewed assertion as immutable once
written (see "Deselecting a reference" below for the same principle applied to
references). Ownership (`ownerId`) is **not** settable here and is always inherited
from the note being corrected - moving a note to a different location is out of scope
for this action.

```json
{ "successors": [
    { "kind": "description", "body": "A framed photograph is present in the house." }
  ],
  "expectedRevision": 1, "expectedStatus": "proposed", "by": "director" }
```
One successor is a plain correction. Two is a split:
```json
{ "successors": [
    { "kind": "description", "body": "A framed photograph is present in the house." },
    { "kind": "description", "body": "Reflected light obscures a face in the photograph.",
      "sceneId": "scn_8fc59f7f2860" }
  ],
  "expectedRevision": 1, "expectedStatus": "proposed", "by": "director" }
```
- `kind` must be `description`, `constraint`, or `tone` - the same kinds a brief note
  can already be; this never creates a `reference_image` or `vocabulary` note, and the
  note being corrected must itself already be one of these three (a reference image
  has its own review flow, not this one).
- `sceneId` (optional, per successor) - omit/null for "standing" (applies to the whole
  location); set it to scope that successor to one specific scene already linked to
  this location (the same set `GET .../locations/{locationId}` and the approval's own
  `sceneRequirements` show) - `400` for a scene that doesn't belong to this location, or
  doesn't exist. `includeDescendants` (optional, default `false`) works exactly like
  every other note's `applicability.includeDescendants`.
- Never edits or infers a citation - **the request has no field for that on purpose**.
  Every successor's citations are copied verbatim from the original note; only `body`/
  `kind`/scope are yours to set. This is what guarantees an edited/split note's wording
  can never be mistaken for a different verbatim screenplay excerpt.
- `expectedRevision`/`expectedStatus` are **both required**, same rationale as the
  review endpoint above - a stale pair (someone else corrected or reviewed this note
  since you read it) is a `409`, and **nothing is written**: your draft (the successors
  you already typed) is not lost, just re-fetch the note and resubmit with its current
  values.
- A note that has been replaced by a correction can't be brought back through
  `POST .../notes/{noteId}/review` either: confirming or rejecting it is a `400`
  (`"...was replaced by a correction (note_x); review the replacement note instead"`),
  or a `409` if your view of it is stale. Review the replacement instead; to undo a
  correction, correct the replacement (e.g. back to standing) - the lineage keeps every
  hop.
- A note that's already `rejected` cannot be corrected - if your own `expectedStatus`
  is `"rejected"`, that's a `400` (there's nothing live left to correct); if you
  expected `"proposed"`/`"confirmed"` but it turns out to already be rejected, that's
  the `409` case above instead, not this one.
- Every new successor starts `status: "proposed"` - **it never inherits the original's
  confirmation**, even if the original was confirmed. The wording/scope has changed, so
  it needs its own review via the same `POST .../notes/{noteId}/review` endpoint.

Response 200:
```json
{ "original": { "id": "note_...", "status": "rejected", "revision": 1,
                "reviewedBy": "director", "reviewedAt": "2026-...", "guidance": null,
                "reviewReason": "corrected" },
  "newNotes": [ { "id": "note_...", "kind": "description",
                  "body": "A framed photograph is present in the house.",
                  "status": "proposed", "revision": 1, "citations": [...],
                  "sceneId": null, "includeDescendants": false } ] }
```
`newNotes` is in the same order as the request's `successors`. `404`/`400`/`409`/`415`/
`403` as in the review endpoint above.

**Where this shows up elsewhere:**
- `GET .../locations/{locationId}` and the approval endpoints stop showing the original
  note immediately (it's `rejected`, excluded the same way any rejected note already
  is) and start showing the new one(s) - no separate refresh step or cache to clear.
- If the corrected note was part of an **already-locked** approval package,
  `GET .../locations/{locationId}/approval`'s `isStale` becomes `true` with a
  `staleReasons` entry naming the correction (see above) - the locked package itself is
  untouched; re-lock to approve the corrected wording.
- A later re-run of ingestion on the same screenplay **cannot** undo a correction: the
  harness's existing reconciliation only ever touches its own machine-proposed notes
  and already treats any non-`proposed` status (rejected included, for any reason) as a
  durable human decision it will not overwrite - your correction's new note(s) aren't
  machine-proposed at all, so re-ingestion doesn't even consider them.

### `POST /projects/{projectId}/locations/{locationId}/jobs`
```json
{ "kind": "references" }
```
- `201` `{ "id": "job_..." }` - a new run was started.
- `200` `{ "id": "job_..." }` - a run for this `(kind, location)` was **already**
  queued/running; this is the *same* job id, not a new run (idempotent trigger - safe to
  call again after a reload, or from two tabs).
- `501` - `{ "kind": "concept" }` - **concept generation does not exist in the harness**.
  There is no image-generation pipeline behind this yet. Surface this as "not available
  yet," not a silent failure or an infinite spinner.
- `404` - unknown location.
- `403` - disallowed `Origin` (see above).

Phase 1 does **not** require an approved brief before triggering a run (there is no
brief-approval model yet - see above). Remove any client-side gate on `loc.approved`
for this call in Phase 1.

### `GET /projects/{projectId}/jobs/{jobId}`
- `{ "status": "queued" }` / `{ "status": "running" }`
- `{ "status": "failed", "error": "..." }` - a real failure (exception). **An empty
  result is not a failure** - see next line.
- `{ "status": "succeeded", "references": [...], "warnings": [...] }` - `references` is
  the **full current, authoritative** reference list for the location (same shape as
  `GET .../references`, `includeRejected=false`), not a delta. This can legitimately be
  the *same* list as before, or even empty, when nothing new was found - check
  `warnings` (e.g. "no search terms survived verification") to explain that to the user
  rather than treating it as broken.

`404` for an unknown job id.

**A run has no server-side execution timeout and can stay `"running"` indefinitely** -
the pipeline runs on a real thread the server cannot force-cancel, so there is no safe
point at which the server could mark it `"failed"` while it might still be writing (see
`video-harness/README.md`). The existing `poll()` loop in `app/page.tsx` already gives
up client-side after ~12 minutes ("The run is still pending. Reload to reconnect.") -
keep that client-side bound; it is the only timeout that exists for this call. The job
itself keeps running server-side regardless, and a later `GET` on the same job id will
eventually show its real outcome.

## Concept art and visual-direction approval

Uploaded concept-art versions per location, and an explicit lock of one version + the
brief/context + selected references as the approved visual direction. **No image
generation of any kind exists here** - every version is something a human uploaded;
see "Not yet built" below for the Luma/generation boundary. **No 3D/Astra call exists
here either** - `GET .../approval` is only the retrieval a later, separate "Send to 3D
blockout" action would read from; nothing in this section calls out anywhere or marks
a package as sent.

Concept art is never a reference card and never appears in `GET .../references` or
`GET /sources` - it is a wholly separate record from both, even when it happens to
share the exact same image bytes as one of them (content-addressed dedup applies
across concept/reference/ingest uploads alike - uploading the same file three ways
still stores the bytes once). Sharing bytes with a reference or an ingested screenplay
page never makes a concept image ingest-eligible or reference-listable on its own, and
the reverse holds too: uploading a concept image never affects an existing reference
note or ingested source's own state. The one exception, matching how a reference image
already behaves: if the *same bytes* are later explicitly uploaded through
`POST /projects/{id}/sources` (the ingestion upload), that source becomes
ingest-eligible from that point on (`GET /sources` will list it) - this is the existing
promotion path applying uniformly, not something specific to concept art, and it never
retroactively changes the concept version record pointing at those bytes.

### `POST /projects/{projectId}/locations/{locationId}/concepts/upload?filename=...`
Same upload convention as `.../references/upload` above: raw image bytes
(`image/jpeg | image/png | image/webp`), `filename` as a query parameter, one image per
request. Uploading (or, client-side, merely looking at) a version **never** approves it
- only the lock endpoint below does, and it never resets an existing approval either.

Response `201`:
```json
{ "id": "cvn_...", "image": "/projects/prj_.../concepts/cvn_.../image",
  "filename": "mill_v2.jpg", "created": true, "approved": false }
```
- `created: false` - identical bytes were already uploaded as a version for this
  location; the existing version is returned (content-addressed dedup, like sources and
  reference uploads - a re-upload is always a safe no-op, never a duplicate version).
- `approved` - true iff this version is the location's currently locked one.
- `404` unknown project/location; `400` unsupported/invalid image, empty body, or a
  scene id (concept art is per location only); `413` over the size limit.

### `GET /projects/{projectId}/locations/{locationId}/concepts`
```json
{ "locationId": "loc_...", "approvedVersionId": "cvn_a1b2c3",
  "versions": [
    { "id": "cvn_a1b2c3", "image": "/projects/.../concepts/cvn_a1b2c3/image",
      "filename": "mill_v1.jpg", "createdAt": "2026-...", "author": "user", "approved": true },
    { "id": "cvn_d4e5f6", "image": "/projects/.../concepts/cvn_d4e5f6/image",
      "filename": "mill_v2.jpg", "createdAt": "2026-...", "author": "user", "approved": false }
  ] }
```
Oldest first. Use `approvedVersionId`/`approved` to badge the locked version distinctly
from plain candidates. **"Selecting a candidate" is purely client-side state** - there
is nothing to call here for that; only the lock endpoint below persists anything.

### `GET /projects/{projectId}/concepts/{conceptVersionId}/image`
Streams the bytes (same rationale as `GET .../references/{noteId}/image` - no signing
key under local dev ADC). `404` for an unknown version or project.

### `POST /projects/{projectId}/locations/{locationId}/concepts/from-reference`
```json
{ "referenceId": "note_a1b2c3" }
```
Creates a concept-candidate version from an **existing, applicable reference image** -
no bytes are downloaded or re-uploaded through the browser; the new version points
directly at the reference's own already-stored image. Response shape and semantics are
identical to `POST .../concepts/upload` above (`ConceptUploadOut`, always `201`,
`created`/`approved` mean the same thing), plus two extra fields:
```json
{ "id": "cvn_...", "image": "/projects/.../concepts/cvn_.../image", "filename": "mill_ref.jpg",
  "created": true, "approved": false,
  "promotedFromNoteId": "note_a1b2c3", "promotedFromNoteRevision": 1 }
```
- Both `promotedFrom*` fields are `null` for a version created via a raw
  `.../concepts/upload` instead.
- Permits a `proposed` **or** `confirmed` reference - creating a candidate is
  exploratory, it is not an approval decision. A `rejected` reference is refused:
  `400` `"'note_a1b2c3' is rejected and cannot be promoted to a concept candidate"`.
- `400` `"'note_x' is not a reference applicable to location {locationId}"` for an
  unrelated/unknown reference id (same ownership/inheritance rule as everywhere else
  in this section - owned, or inherited from a confirmed ancestor).
- **Never confirms, rejects, or otherwise mutates the reference note** - this reads it,
  it does not review it. The reference's own status/revision are completely
  unaffected; review it independently via `POST .../notes/{noteId}/review` as always.
- **Never touches any existing approval** - exactly like a raw upload, promoting a new
  candidate leaves whatever is currently locked alone until an explicit lock says
  otherwise.
- **This is a separate action from selecting a reference as supporting evidence.**
  Using reference X's image as the concept *candidate* (this endpoint,
  `concept_version_id`) and selecting reference X itself as a *confirmed supporting
  reference* for the approval package (`POST .../approval/lock`'s `referenceIds`,
  which still requires `confirmed` - see below) are independent: nothing stops the
  same reference note from playing both roles, or either alone.
- Idempotent and concurrency-safe the same way uploads are: retrying, or two
  concurrent promotions of the same reference (or a promotion racing a raw upload of
  the same bytes), all resolve to one version record. Whichever call's provenance was
  recorded first is never overwritten by a second, different-purpose call that happens
  to resolve to the same underlying image.
- `404` unknown project/location; `400` a scene id.

### `GET /projects/{projectId}/locations/{locationId}/approval/preview?conceptVersionId=...&referenceIds=...&depictionLabel=...`
Read-only - persists nothing. Shows exactly what a lock right now would capture for a
given candidate + an explicit reference selection (`referenceIds` repeated as a query
param, e.g. `?referenceIds=note_a&referenceIds=note_b`; omit for none) + an optional
depiction label. Call this before showing a "lock this as approved" confirmation, and
again if the candidate, selection, or label changes.
```json
{
  "locationId": "loc_...", "conceptVersionId": "cvn_a1b2c3",
  "conceptImage": "/projects/.../concepts/cvn_a1b2c3/image", "conceptFilename": "mill_v1.jpg",
  "depictionLabel": "whole-house exterior",
  "coreNotes": [ /* same shape as GET .../locations/{id}'s descriptionNotes - kind
                   "description"/"tone", unconditional (no scene) */ ],
  "coreNotesCaveat": "These are the location's own standing notes ... that distinction
                       needs human review ... nothing here infers or rewrites that
                       automatically.",
  "physicalNotes": [ /* kind "constraint", unconditional - physical/set-dressing */ ],
  "sceneRequirements": [
    { "sceneId": "scn_c7d4...", "number": "4", "heading": "4. INT. ANSHUL'S HOUSE - NIGHT", "notes": [] },
    { "sceneId": "scn_8fc5...", "number": "7", "heading": "7. INT./EXT. PANDIT'S DREAM - NIGHT",
      "notes": [ /* description/constraint/tone notes scoped to this scene */ ] },
    { "sceneId": "scn_0201...", "number": "10", "heading": "10. EXT. ANSHUL'S HOUSE / DEVGRAM LANES - MORNING", "notes": [] }
  ],
  "briefInherited": [{ "entityId": "loc_...", "name": "Devgram", "notes": [...] }],
  "briefAncestors": ["Devgram"], "supersededSources": [],
  "references": [{ "noteId": "note_...", "revision": 1, "status": "confirmed",
                   "guidance": null, "direction": null, "caption": "Stone mill with wheel.",
                   "image": "/projects/.../references/note_.../image" }],
  "contextToken": "9f3a...e21c"
}
```
**Structured sections, reusing existing fields - see "Brief sectioning" below for the
full rationale.** `coreNotes` and `physicalNotes` replace the old flat `briefNotes`;
`sceneRequirements` replaces `briefConditional` and now **always lists every scene
linked to this location** (`GET .../locations/{id}`'s own linked-scene roster,
reused, not recomputed) **regardless of whether that scene has any requirements** -
`notes: []` on a roster entry is a real fact ("nothing scene-specific was extracted for
this scene"), never an omission, as long as you got it from *this* endpoint (a
preview is always complete/current - see `sceneCoverageComplete` on
`GET .../approval` below for the one place that isn't always true).

`depictionLabel` (optional, ≤200 chars after trimming) is a small free-text
description of what the image depicts - e.g. `"whole-house exterior"`,
`"bedroom interior - top view"`. Purely descriptive: never inferred, never checked
against any room/location relationship, never a claim of spatial accuracy, and never
changes which location the concept version itself belongs to. `400` if over length.

**Every `referenceId` must be both `confirmed` and applicable to this location** through
the same ownership/inheritance rule `GET .../references` already uses (owned, or
inherited from a confirmed ancestor with `includeDescendants`) - unchanged from before,
and distinct from `.../concepts/from-reference` above, which allows `proposed` too
because it isn't approving anything. This never confirms anything - it is a read-only
gate on what may be *selected*, not a side effect:
- `400` `"'note_x' is proposed, not confirmed; only confirmed references may be selected
  for approval"` - the note exists here but hasn't been confirmed yet. Confirm it first
  via `POST /projects/{projectId}/notes/{noteId}/review`, then retry.
- `400` `"'note_x' is rejected, not confirmed; ..."` - same, for a rejected note.
- `400` `"'note_x' is not a reference applicable to location {locationId}"` - the note
  doesn't belong to this location at all (wrong location, or a note that isn't a
  reference), regardless of its status.
- `404` unknown location/concept version; `400` a scene id.

Duplicate `referenceIds` are silently deduplicated.

**Brief sectioning (why these fields, and what they don't claim).** Extraction stores
notes with a `kind` (`description | constraint | tone | ...`) and an `applicability`
(`scene_id`, `includeDescendants`) - this endpoint reuses exactly those existing fields
to sort into "core description" (`description`/`tone`, unconditional), "physical/
set-dressing" (`constraint`, unconditional - the system's existing structured slot for
standing requirements), "scene-specific" (any kind, scoped to a scene), and "inherited"
(owned by a confirmed ancestor). **What this sectioning does not do**: it does not
reclassify anything using keyword rules, and it does not resolve every ambiguity - a
note can describe a standing physical fact ("family photographs decorate the space")
and a scene/camera-specific visual detail ("...one photo's reflection hides a face") in
the same sentence, with the same `kind` and no `scene_id` either way. Nothing in this
data model distinguishes those two today, so such a note lands in `coreNotes` as-is
(never dropped, never guessed into a scene) and `coreNotesCaveat` says so explicitly.
If a note turns out to actually be scene-specific - or mixes a standing fact with a
scene-specific one in the same sentence - the fix is `POST /projects/{projectId}/notes/{noteId}/correct`
(see "Correcting a note" below), never something this or any other endpoint infers
automatically.

### `POST /projects/{projectId}/locations/{locationId}/approval/lock`
```json
{ "conceptVersionId": "cvn_a1b2c3", "referenceIds": ["note_a", "note_b"],
  "depictionLabel": "whole-house exterior",
  "contextToken": "9f3a...e21c", "expectedRevision": 0, "by": "director" }
```
`depictionLabel` is optional (omit, `null`, or `""` all mean "no label"). `contextToken`
and `expectedRevision` are **both required**, and guard two different things:
- `contextToken` - must match what a fresh preview computes for this exact
  `(conceptVersionId, referenceIds, depictionLabel)` right now - changing the label
  between preview and lock moves the token like any other change. A mismatch means the
  brief, scene roster, a selected reference, or the label changed since you fetched the
  preview - `409`, **re-fetch the preview and retry**, never resend the same token.
  The token also covers each scene's own identity (id, number, heading) - relinking a
  scene to/from this location, or renaming/renumbering one, moves the token even if
  that scene has no notes at all.
- `expectedRevision` - the `revision` last seen from `GET .../approval` (`0` if none
  exists yet). A mismatch means someone else's lock is now current - `409`, **re-fetch
  `GET .../approval` and retry**.

Retrying the exact same request is safe: if the package you're locking is already
exactly the current one (by `contextToken`), the call succeeds as a no-op regardless of
`expectedRevision` - `created: false`, same approval returned, no new revision. That
idempotency check happens atomically, alongside the revision check, inside the same
commit - never as a separate pre-check that could itself race.

**What "approved" actually means here - the exact validation/commit boundary.** The
`contextToken` check above happens *once*, against a fresh read, before anything is
written. What gets committed is built directly from that same validated read - never a
second, independently re-fetched copy. The commit itself (the atomic step that makes a
package "current") does **not** re-read notes or re-check freshness; it only guards
(a) idempotency by token equality and (b) the `expectedRevision` race between two
*concurrent lock attempts*. So: **this endpoint approves the exact snapshot you
previewed and got a token for - not "whatever the absolute latest state happens to be"
at the instant the write lands.** In this single-process local slice there is a real
but narrow window between the token check and the commit where a concurrent edit could
still land; nothing in that window is silently absorbed into what gets approved, and
nothing re-derives a "fresher" version to compile instead. Any drift that happened in
that window is never hidden - it shows up immediately afterward as `isStale`/
`staleReasons` on `GET .../approval` below, exactly as if the edit had happened a
minute later. Treat a `409` here as "go re-fetch," never as a promise that what gets
approved is instantaneously fresh at the moment of the write.

Response `201` (`created: true`) or `200` (`created: false`, idempotent no-op):
```json
{ "created": true, "approval": {
  "id": "apr_...", "locationId": "loc_...", "revision": 1,
  "conceptVersionId": "cvn_a1b2c3", "conceptImage": "/projects/.../concepts/cvn_a1b2c3/image",
  "conceptFilename": "mill_v1.jpg", "depictionLabel": "whole-house exterior",
  "coreNotes": [...], "coreNotesCaveat": "...", "physicalNotes": [...],
  "sceneRequirements": [...], "sceneCoverageComplete": true,
  "briefInherited": [...], "briefAncestors": ["Devgram"], "supersededSources": [],
  "references": [...], "contextToken": "9f3a...e21c",
  "lockedBy": "director", "lockedAt": "2026-..." } }
```
`lockedBy` is whatever free text `by` was sent (default `"user"`) - **not an
authenticated identity**; this system has no login. Never writes to a note - the
brief/reference data above is a snapshot of what was seen, not a confirmation of it -
and every `references[]` entry here is always `status: "confirmed"` (see the preview
call above: only a confirmed, applicable reference can be selected in the first place).
`sceneCoverageComplete` is always `true` for anything locked from now on (`false` is
only possible on a package locked before this slice - see "Scene coverage and backward
compatibility" below). `404`/`400` as in the preview call above.

### `GET /projects/{projectId}/locations/{locationId}/approval`
```json
{ "locationId": "loc_...", "revision": 1, "isStale": false,
  "staleReasons": [],
  "approval": { /* same shape as the lock response's "approval" above, or null if nothing has ever been locked */ } }
```
Use `revision` as the next lock's `expectedRevision`. `isStale: true` means the brief,
scene roster, a selected reference, or the depiction label has changed since this exact
package was locked - the stored snapshot itself is **never** rewritten by that; show
the user that a new approval is needed for an updated package rather than re-deriving
one. `staleReasons` is a list of human-readable strings (empty when `isStale` is
`false`), one per divergence found, e.g.:
- `"a note in the brief (note_x) changed since this was approved (was revision
  1/proposed, now 2/confirmed)"`
- `"a note in the brief (note_x) was corrected since this was approved - replaced by:
  note_y"` (see "Correcting a note" below - the original still exists, just excluded
  from retrieval like any rejected note; this is worded distinctly from a plain
  `"...was removed..."`, which means the note is genuinely gone, not superseded)
- `"1 new note in scene 7 since this was approved"`
- `"reference note_y is no longer confirmed (now rejected)"`
- `"reference note_y no longer applies to this location"` (removed, or its inheritance
  no longer reaches here)
- `"scene scn_x heading/number changed since this was approved (was '4' '4. INT. ...',
  now '4' '4. INT. ... - REVISED')"` / `"1 newly linked scene since this was approved"`
- `"the approved location was rejected"` / `"...was merged into loc_z"`

Treat these as explanatory text for a UI banner, not a stable enum to branch logic on -
the exact wording may change; only `isStale`'s boolean should drive behavior.

**This call always succeeds and returns the stored package, even when everything about
it has since diverged** - a rejected/deleted reference, an edited brief/scene note, a
relinked/renamed scene, or even the location itself having been later rejected or
merged. It never fails the whole retrieval over that; it explains it instead.

**Scene coverage and backward compatibility.** `sceneCoverageComplete` on the nested
`approval` distinguishes two eras of data:
- `true` (everything locked from now on): `sceneRequirements` always lists every scene
  currently linked to this location at lock time, so an empty `notes: []` on an entry
  is a confirmed fact, and a scene simply missing from the list means it wasn't linked
  at lock time - not "extraction found nothing."
- `false` (only possible on a package locked before this slice): `sceneRequirements`
  only ever listed scenes that happened to have a scene-conditional note at lock time -
  a scene absent from that old list may just never have been captured, not confirmed
  empty. `staleReasons` will always include one explicit line naming this
  (`"...predates full scene-roster coverage..."`) instead of a detailed scene-by-scene
  diff, which would otherwise misreport every uncaptured scene as "newly linked."
  Old approvals are never rewritten to backfill this - re-lock (a fresh preview + lock)
  to get a `sceneCoverageComplete: true` package. `depictionLabel` needs no such flag:
  `null` on old data has always correctly meant "no label was given."

## Frontend changes required (not yet made - this is the handoff, not a description of
## current `location-studio` code)

1. **`lib/api.ts`**: drop `credentials: "include"` - there is no cookie session; CORS is
   configured with `allow_credentials: false`. Base path logic is otherwise unchanged.

2. **`lib/model.ts`**: `readWorkspace`/`saveWorkspace` (IndexedDB) stop being the source
   of truth for anything backend-owned. `Reference.category` needs `"Place" | "Material"`
   added to its union (the API sends the real facet, not a lossy remap - see above).
   Consider adding `status: "proposed" | "confirmed" | "rejected"` and `owned` /
   `inheritedFrom` alongside the existing `selected` boolean, since the API now exposes
   real review state and inheritance the UI currently has no field for.

3. **`app/page.tsx`**:
   - `run()`/`poll()`: switch from posting a bare `location` object to
     `POST /projects/{pid}/locations/{lid}/jobs` and `GET /projects/{pid}/jobs/{jid}`.
   - **On a succeeded job, replace `l.refs` with `references` from the response.** Do
     not keep the current `poll()` merge logic that preserves old selected/uploaded refs
     by id - the server response is now authoritative (it already reflects every
     confirm/reject you've made), and the old merge logic exists only because the old
     `/jobs/:id` contract sent a delta. Sending the full list makes that merge redundant
     and, if kept, could mask a rejection the server already recorded.
   - Prefix every `image` field with `apiBase` before rendering.
   - Remove the `loc.approved` gate on `run("references")` in Phase 1 (no brief-approval
     model yet).
   - **Deselecting a reference**: the current `select()` toggle only flips a boolean and
     has no "reject" affordance at all. The API deliberately does not map "deselect" to
     an implicit reject - `decision` is always an explicit `confirmed`/`rejected` choice
     the user made, with a reason when rejecting. Add a distinct reject control (e.g. in
     the reference detail dialog); treat un-selecting something that was only ever
     `"proposed"` (never confirmed) as a no-op with no API call, since there is nothing
     to undo.
   - Brief tab: in Phase 1, render `descriptionNotes`/`constraintNotes`/`toneNotes` as a
     read-only list (with citations), not the editable `textarea`s bound to IndexedDB.
     There is no "open questions" data from the harness yet (no such note kind exists) -
     leave that field empty/hidden rather than inventing content for it. **Add a
     "Correct this note" action per note** (each already carries its own `id`,
     `revision`, `status`, `sceneId`) that opens a small form calling
     `POST .../notes/{noteId}/correct` (see above) - one text field (+ kind, + an
     optional "only during scene" picker) for a plain correction, or "split into two"
     to show a second set of the same fields. Never let the UI edit a citation/quote -
     the request has no field for that. On `409`, show the conflict and let the user
     re-open the form with the note's current values rather than silently discarding
     what they typed.
   - Chat panel and multi-project switching are unchanged from today's local-only
     behavior in Phase 1 - neither is implemented server-side yet (see "Not yet
     built"). Concept upload/approval **is** now implemented server-side - see item 5.

4. **New surface, not a modification**: nothing in today's `location-studio` creates a
   project or uploads a screenplay - the create → upload → ingest → poll flow above has
   no existing UI to adapt. It needs a new entry point (e.g. an "New project" action
   distinct from opening an existing one), file picker(s) calling the upload endpoint
   per file, an ingest-trigger button, and a poll loop reusing the same pattern as
   `poll()` for references jobs (see `GET .../jobs/{jobId}` above) - on a `"succeeded"`
   ingest job with `outcome` `"complete"` or `"partial"`, navigate to
   `GET /projects/{id}/locations`; on `"failed"` or `outcome: "no_op"`, show the
   per-source `sources` detail and let the user retry rather than advancing.
   - **Reload/recovery**: don't rely on upload-response state surviving a refresh -
     call `GET /projects/{id}/sources` (above) to repopulate the Sources screen
     authoritatively, the same way an in-flight ingest job is reconnected via its saved
     job id rather than client memory.

5. **New surface: concept art and lock-in**, replacing today's local-only
   concept-upload placeholder in `location-studio`:
   - A versions strip/gallery per location: file picker(s) calling
     `POST .../concepts/upload` per file, then `GET .../concepts` on load/reload -
     don't trust the upload response to survive a refresh, same reload rule as Sources.
     Badge the version matching `approvedVersionId` distinctly from plain candidates.
     Each version's `promotedFromNoteId` (non-null when created via `from-reference`
     below) can badge it as "from reference" if useful, but isn't required for the
     core flow.
   - **A "use as candidate" action on each reference card** (in the references
     panel, not just the concepts gallery): calls `POST .../concepts/from-reference`
     with that reference's id, then refreshes `GET .../concepts`. Unlike the
     concepts-upload picker, this is available for a `proposed` reference too (not
     only confirmed) - creating a candidate is exploratory. A `400` for a rejected
     reference is an edge case (the UI should already prevent picking a rejected
     card for this) - show its message rather than a generic error.
   - "Select a candidate" is client-side only (which version + which references are
     checked in the UI) - no API call until the user explicitly locks.
   - **Only confirmed references are selectable as *supporting evidence* for the
     approval** (the lock's `referenceIds` - distinct from using a reference as the
     *candidate image* above, which allows proposed). Filter that specific picker to
     `status === "confirmed"` client-side, so the user never hits the preview/lock
     endpoints' `400` for a proposed/rejected pick in normal use - that response
     exists for correctness, not as a UI-driven flow.
   - **An optional small text input for the depiction label** ("whole-house
     exterior", "bedroom interior - top view") alongside the candidate/reference
     picker - plain text, no validation beyond a ~200-char limit enforced
     server-side. Never a room/location picker; it's a caption, not a relationship.
   - Before locking: call `GET .../approval/preview` with the selected
     `conceptVersionId`/`referenceIds`/`depictionLabel` and show that snapshot as the
     confirmation ("this is what will be approved") - render `coreNotes` and
     `physicalNotes` as two distinct groups (with `coreNotesCaveat` as helper text
     under the first), and `sceneRequirements` as one row per scene including the
     ones with an empty requirements list (don't filter those out - their presence is
     the point). Then `POST .../approval/lock` with its `contextToken` and the
     `revision` last read from `GET .../approval` (`0` first time).
   - On `409`: re-fetch (`.../approval/preview` for a stale token, `.../approval` for a
     stale revision) and let the user retry - never resend the same body.
   - On reload, `GET .../approval` is authoritative for what's currently locked; it
     always returns the stored package even when it has drifted. Render `isStale: true`
     using `staleReasons` (e.g. "reference X is no longer confirmed - re-lock to
     update") rather than a generic message, and never silently re-approve. If
     `approval.sceneCoverageComplete` is `false`, show a one-line note that this
     package predates full scene coverage rather than trusting its scene list as
     exhaustive (staleReasons already says this too, but it's worth a persistent
     badge, not just a transient banner).
   - Do **not** wire a "Send to 3D blockout" button to anything yet - there is nothing
     on the other end (see "Not yet built").

## Not yet built (do not assume these exist)

- **Concept generation.** No image-generation pipeline exists in the harness at all -
  every concept version is a human upload (`POST .../concepts/upload`, above). Luma is
  not integrated and there is no fake generation endpoint standing in for it; provider
  and model selection are a separate, later piece of work. `POST .../jobs {"kind":
  "concept"}` still returns `501` on purpose.
- **"Send to 3D blockout."** `GET .../locations/{id}/approval` (above) is the retrieval
  boundary a later explicit action would read from - nothing calls Astra, invents its
  API, or marks a package as sent. That later action does not exist yet.
- **Chat.** No endpoint exists yet. Would be new code (context retrieval + a fresh model
  call), not a "connection" to something already there.
- **Working-brief editing.** The extracted notes above (`GET .../locations/{id}`) are
  still read-only in Phase 1; concept-art approval (above) is a separate, now-built
  thing layered on top of that same read-only brief, not an editor for it.
- **Document revisions** (`supersedes`/`revisionLabel` - the CLI's `drop --supersedes`
  equivalent). `register_file` already supports it; the upload endpoint deliberately
  doesn't expose it yet - no UI for it either.
- **Multi-project switching in the UI** (the API can list projects; nothing consumes it
  yet).

Brainstorming/chat, when built, must never silently alter approved script facts -
mutations always go through the same reviewed note path as the UI (`POST .../review`),
never a chat-specific write.
