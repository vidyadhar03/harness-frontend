// Typed client for the video-harness Phase 1 API. Shapes mirror
// video-harness/harness/api/dto.py exactly (camelCase on the wire). See
// API_CONTRACT.md for the endpoint-by-endpoint contract this was built from.
import { apiBase, apiGet, apiPost, uploadRaw } from "./api";

export type ProjectSummary = { id: string; name: string };

export type ProjectDetail = {
  id: string;
  name: string;
  sourceCount: number;
  noteCount: number;
  locationCount: number;
  sceneCount: number;
};

export type LocationSummary = {
  id: string;
  name: string;
  aliases: string[];
  status: string;
  parentName: string | null;
  sceneNumbers: string[];
  noteCount: number;
};

export type Citation = {
  sourceId: string | null;
  filename: string | null;
  page: number | null;
  quote: string | null;
  url: string | null;
  title: string | null;
};

export type NoteStatus = "proposed" | "confirmed" | "rejected";

export type Note = {
  id: string;
  kind: string;
  body: string;
  status: NoteStatus;
  revision: number;
  citations: Citation[];
};

export type SceneRef = { id: string; number: string | null; name: string };

export type LocationDetail = {
  id: string;
  name: string;
  aliases: string[];
  status: string;
  ancestors: string[];
  scenes: SceneRef[];
  descriptionNotes: Note[];
  constraintNotes: Note[];
  toneNotes: Note[];
  supersededSources: string[];
};

export type ReferenceNote = {
  id: string;
  title: string;
  image: string; // root-relative; resolve with resolveImageUrl()
  category: string; // Place | Terrain | Architecture | Material (or "Uploaded")
  facet: string | null;
  reason: string;
  direction: string | null;
  directionRationale: string | null;
  source: string | null;
  credit: string | null;
  license: string | null;
  attribution: string | null;
  selected: boolean; // == status === "confirmed"
  status: NoteStatus;
  guidance: string;
  owned: boolean;
  inheritedFrom: string | null;
  revision: number;
};

export type ReferenceList = { locationId: string; references: ReferenceNote[] };

export type RejectReason = "false" | "wrong_scope" | "duplicate" | "not_useful" | "other";

export type ReviewRequest =
  | { decision: "confirmed"; guidance?: string; expectedRevision: number; expectedStatus: NoteStatus }
  | { decision: "rejected"; reason: RejectReason; expectedRevision: number; expectedStatus: NoteStatus };

export type ReviewResult = {
  id: string;
  status: NoteStatus;
  revision: number;
  reviewedBy: string | null;
  reviewedAt: string | null;
  guidance: string | null;
};

export type JobKind = "references" | "concept" | "ingest";
export type JobStatus = "queued" | "running" | "succeeded" | "failed";
export type IngestOutcome = "complete" | "partial" | "failed" | "no_op";

// Per-source result inside an ingest job's `sources` array. `status` is deliberately a
// plain string on the wire (harness/api/dto.py's IngestSourceResultOut), not a fixed
// literal - the harness distinguishes at least "digested" | "skipped" | "failed" |
// "unsupported", and treating it as an open string means a future addition there can't
// silently fail our type at runtime.
export type IngestSourceResult = {
  sourceId: string;
  filename: string;
  status: string;
  docType: string | null;
  entitiesCreated: number;
  notesWritten: number;
  notesReplaced: number;
  notesReused: number;
  warnings: string[];
  error: string | null;
};

export type JobStatusResult = {
  status: JobStatus;
  error?: string | null;
  warnings: string[];
  references?: ReferenceNote[] | null; // kind === "references"
  outcome?: IngestOutcome | null; // kind === "ingest"
  sources?: IngestSourceResult[] | null; // kind === "ingest"
};

// --- sources / ingest ------------------------------------------------------------------

export type SourceStatus = "uploaded" | "digesting" | "digested" | "failed" | "unsupported";

export type SourceUploadResult = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: SourceStatus;
  created: boolean; // false == this exact content was already uploaded (dedup, not an error)
  error: string | null;
};

// GET /projects/{id}/sources - authoritative, uploaded-ingestion-inputs-only listing
// (excludes reference-pipeline-fetched images; see API_CONTRACT.md). No docType or
// timestamp field exists here on purpose - don't infer either from this shape.
export type SourceSummary = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: SourceStatus;
  error: string | null;
};

// POST /projects/{id}/locations/{lid}/references/upload - response shape
export type ReferenceUploadResult = {
  noteId: string;
  imagePath: string;
  created: boolean;
  status: NoteStatus;
  revision: number;
};

const enc = encodeURIComponent;

export function listProjects(signal?: AbortSignal) {
  return apiGet<ProjectSummary[]>("/projects", undefined, { signal });
}

export function getProject(projectId: string, signal?: AbortSignal) {
  return apiGet<ProjectDetail>(`/projects/${enc(projectId)}`, undefined, { signal });
}

export function listSources(projectId: string, signal?: AbortSignal) {
  return apiGet<SourceSummary[]>(`/projects/${enc(projectId)}/sources`, undefined, { signal });
}

export function listLocations(projectId: string, signal?: AbortSignal) {
  return apiGet<LocationSummary[]>(`/projects/${enc(projectId)}/locations`, undefined, {
    signal,
  });
}

export function getLocation(projectId: string, locationId: string, signal?: AbortSignal) {
  return apiGet<LocationDetail>(
    `/projects/${enc(projectId)}/locations/${enc(locationId)}`,
    undefined,
    { signal },
  );
}

export function listReferences(
  projectId: string,
  locationId: string,
  opts?: { includeRejected?: boolean },
  signal?: AbortSignal,
) {
  return apiGet<ReferenceList>(
    `/projects/${enc(projectId)}/locations/${enc(locationId)}/references`,
    { includeRejected: opts?.includeRejected },
    { signal },
  );
}

export function reviewNote(
  projectId: string,
  noteId: string,
  body: ReviewRequest,
  signal?: AbortSignal,
) {
  return apiPost<ReviewResult>(
    `/projects/${enc(projectId)}/notes/${enc(noteId)}/review`,
    body,
    { signal },
  );
}

export function createReferenceJob(projectId: string, locationId: string, signal?: AbortSignal) {
  return apiPost<{ id: string }>(
    `/projects/${enc(projectId)}/locations/${enc(locationId)}/jobs`,
    { kind: "references" satisfies JobKind },
    { signal },
  );
}

export function getJob(projectId: string, jobId: string, signal?: AbortSignal) {
  return apiGet<JobStatusResult>(`/projects/${enc(projectId)}/jobs/${enc(jobId)}`, undefined, {
    signal,
  });
}

export function resolveImageUrl(rootRelativePath: string): string {
  return `${apiBase}${rootRelativePath}`;
}

export function createProject(name: string, signal?: AbortSignal) {
  return apiPost<ProjectSummary>("/projects", { name }, { signal });
}

/**
 * POST /projects/{id}/sources - raw request body IS the file's own bytes (no multipart),
 * filename passed as a query param. One file per request; the caller loops for a batch
 * (see API_CONTRACT.md). `onProgress` only ever fires with a number when the browser
 * actually measured it - see uploadRaw.
 */
export function uploadSource(
  projectId: string,
  file: Blob,
  filename: string,
  opts: { onProgress?: (pct: number | null) => void; signal?: AbortSignal } = {},
) {
  const qs = `?filename=${enc(filename)}`;
  return uploadRaw<SourceUploadResult>(`/projects/${enc(projectId)}/sources${qs}`, file, opts);
}

/**
 * POST /projects/{projectId}/locations/{locationId}/references/upload - raw request body
 * is the image's own bytes (JPEG, PNG, WebP), filename passed as query param.
 */
export function uploadLocationReference(
  projectId: string,
  locationId: string,
  file: Blob,
  filename: string,
  opts: { onProgress?: (pct: number | null) => void; signal?: AbortSignal } = {},
) {
  const qs = `?filename=${enc(filename)}`;
  return uploadRaw<ReferenceUploadResult>(
    `/projects/${enc(projectId)}/locations/${enc(locationId)}/references/upload${qs}`,
    file,
    opts,
  );
}

export function startIngest(
  projectId: string,
  opts: { sourceId?: string | null; force?: boolean } = {},
  signal?: AbortSignal,
) {
  return apiPost<{ id: string }>(
    `/projects/${enc(projectId)}/ingest`,
    { sourceId: opts.sourceId ?? null, force: opts.force ?? false },
    { signal },
  );
}
