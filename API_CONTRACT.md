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
                                        "page": 5, "quote": "...", "url": null, "title": null }] }],
  "constraintNotes": [ ... same shape ... ],
  "toneNotes": [ ... same shape ... ],
  "supersededSources": []
}
```
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
  "reviewedBy": "jagan", "reviewedAt": "2026-...", "guidance": "canopy shape, not the bridge" }
```
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
     leave that field empty/hidden rather than inventing content for it.
   - Chat panel, concept upload/generation, and multi-project switching are unchanged
     from today's local-only behavior in Phase 1 - none of that is implemented
     server-side yet (see "Not yet built").

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

## Not yet built (do not assume these exist)

- **Concept generation.** No image-generation pipeline exists in the harness at all.
  `POST .../jobs {"kind": "concept"}` returns `501` on purpose.
- **Chat.** No endpoint exists yet. Would be new code (context retrieval + a fresh model
  call), not a "connection" to something already there.
- **Working-brief editing/approval**, separate from the extracted notes above.
- **Reference/concept image uploads** (visual inspiration / concept art). Screenplay and
  notes uploads for ingestion (`POST /projects/{id}/sources`, above) exist; reference
  and concept image uploads are a separate, still-unbuilt thing.
- **Document revisions** (`supersedes`/`revisionLabel` - the CLI's `drop --supersedes`
  equivalent). `register_file` already supports it; the upload endpoint deliberately
  doesn't expose it yet - no UI for it either.
- **Multi-project switching in the UI** (the API can list projects; nothing consumes it
  yet).

Brainstorming/chat, when built, must never silently alter approved script facts -
mutations always go through the same reviewed note path as the UI (`POST .../review`),
never a chat-specific write.
