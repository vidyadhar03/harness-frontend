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
  // Mirrors the note's own applicability - null sceneId means "standing" (applies to
  // the whole location). Present so a client can tell a standing note from a
  // scene-scoped one without a separate lookup, e.g. before offering a correction.
  sceneId: string | null;
  includeDescendants: boolean;
};

export type SceneRef = { id: string; number: string | null; name: string };

// A Note plus what's needed to decide whether/how to offer "Correct this note" - see
// POST .../notes/{noteId}/correct. `owned` is always true and `editable` always mirrors
// a supported kind in every fixture today (retrieval never yields an inherited
// scene-scoped note), but that's a fact about today's data, not a guarantee this type
// encodes - always check both fields rather than assuming either.
export type ScopedNote = Note & {
  ownerId: string;
  owned: boolean;
  inheritedFrom: string | null; // ancestor location name, when owned is false
  editable: boolean; // true iff owned and a kind correctNote() accepts
};

// One scene's scene-scoped notes, exactly as the Location brief surfaces them.
// `linked: true` entries are the location's own linked-scene roster (one per scene,
// notes: [] is a confirmed "nothing extracted" fact, never an omission). `linked:
// false` entries (only ever present in outOfRosterSceneRequirements) are
// scene-conditional notes whose sceneId isn't part of that roster at all - number is
// always null there; never render them as a confirmed scene link.
export type LocationSceneRequirement = {
  sceneId: string;
  number: string | null;
  heading: string | null;
  linked: boolean;
  notes: ScopedNote[];
};

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
  // The scene-scoped half of the brief - the three standing lists above never
  // contain a scene-scoped note. One entry per linked scene, always present even
  // when empty; see LocationSceneRequirement.
  sceneRequirements: LocationSceneRequirement[];
  // Conditional notes whose sceneId is not one of this location's linked scenes -
  // surfaced for visibility, never presented as part of the scene roster. Only ever
  // includes entries that actually have a correctable note (never an empty stub).
  outOfRosterSceneRequirements: LocationSceneRequirement[];
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
  // "corrected" iff this exact note was just replaced by correctNote() below; null for
  // an ordinary confirm/reject. Open string (not a fixed literal), matching the same
  // forward-compat convention as IngestSourceResult.status.
  reviewReason: string | null;
};

// --- note correction / splitting ---------------------------------------------------

export type NoteCorrectionSuccessor = {
  kind: "description" | "constraint" | "tone";
  body: string;
  // Omit/null for "standing" (applies to the whole location); set to scope this
  // successor to one specific scene already linked to the location being corrected.
  sceneId?: string | null;
  includeDescendants?: boolean;
};

export type CorrectNoteRequest = {
  successors: NoteCorrectionSuccessor[]; // 1 = plain correction, 2 = split
  expectedRevision: number;
  expectedStatus: NoteStatus;
  by?: string;
};

export type NoteCorrectionResult = {
  original: ReviewResult; // now status "rejected", reviewReason "corrected"
  newNotes: Note[]; // same order as the request's successors
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

// --- concept versions / visual-direction approval ---------------------------------------

export type ConceptVersion = {
  id: string;
  image: string; // root-relative; resolve with resolveImageUrl()
  filename: string;
  createdAt: string;
  author: "agent" | "user";
  approved: boolean; // true iff this is the location's currently locked version
  // Both null for a raw upload; both set iff this version was created via
  // promoteReferenceToConcept - see API_CONTRACT.md. Never rewritten by a later,
  // different-purpose call that happens to resolve to the same (location, bytes).
  promotedFromNoteId: string | null;
  promotedFromNoteRevision: number | null;
};

export type ConceptVersionList = {
  locationId: string;
  approvedVersionId: string | null;
  versions: ConceptVersion[];
};

export type ConceptUploadResult = {
  id: string;
  image: string;
  filename: string;
  created: boolean; // false == identical bytes already uploaded for this location
  approved: boolean;
  promotedFromNoteId: string | null;
  promotedFromNoteRevision: number | null;
};

// One entry per scene in the location's linked-scene roster (always present,
// regardless of whether that scene has any requirements - see API_CONTRACT.md).
// `number`/`heading` are both null only for the defensive edge case of a
// scene-conditional note whose scene isn't in the roster at all - never treat that as
// a confirmed scene link.
export type SceneRequirement = { sceneId: string; number: string | null; heading: string | null; notes: Note[] };
export type ApprovalInherited = { entityId: string; name: string; notes: Note[] };

export type ApprovedReference = {
  noteId: string;
  revision: number;
  status: NoteStatus; // always "confirmed" in practice - only a confirmed ref can be selected
  guidance: string | null;
  direction: string | null;
  caption: string;
  image: string;
};

// Shared shape between GET .../approval/preview and the "approval" object embedded in
// GET .../approval and POST .../approval/lock - see API_CONTRACT.md.
export type ApprovalContent = {
  conceptVersionId: string;
  conceptImage: string;
  conceptFilename: string;
  // Free-text, user-supplied ("whole-house exterior") - never inferred, never a claim
  // of spatial accuracy, never implies a room/location relationship.
  depictionLabel: string | null;
  // kind "description"/"tone", unconditional - the location's own standing notes.
  coreNotes: Note[];
  // Always present alongside coreNotes - see CORE_NOTES_CAVEAT in harness/memory/concepts.py:
  // extraction can't yet tell a standing physical fact apart from a scene-specific
  // visual detail sharing the same kind/no-scene-id, so nothing here is reclassified
  // by keyword guessing.
  coreNotesCaveat: string;
  // kind "constraint", unconditional - physical/set-dressing requirements.
  physicalNotes: Note[];
  sceneRequirements: SceneRequirement[];
  briefInherited: ApprovalInherited[];
  briefAncestors: string[];
  supersededSources: string[];
  references: ApprovedReference[];
  contextToken: string;
};

export type ApprovalPreview = ApprovalContent & { locationId: string };

export type ApprovalPackage = ApprovalContent & {
  id: string;
  locationId: string;
  revision: number;
  // False iff this approval predates full-roster scene coverage (locked before this
  // slice) - when false, an empty/missing scene in sceneRequirements must NOT be read
  // as "no requirements were extracted"; see API_CONTRACT.md's "Scene coverage and
  // backward compatibility".
  sceneCoverageComplete: boolean;
  lockedBy: string | null;
  lockedAt: string;
};

export type ApprovalState = {
  locationId: string;
  revision: number; // 0 when approval is null; feed into the next lock's expectedRevision
  approval: ApprovalPackage | null;
  isStale: boolean;
  staleReasons: string[];
};

export type ApprovalLockRequest = {
  conceptVersionId: string;
  referenceIds: string[];
  depictionLabel?: string | null;
  contextToken: string;
  expectedRevision: number;
  by?: string; // free text, NOT an authenticated identity - omit to let the server default apply
};

export type ApprovalLockResult = { created: boolean; approval: ApprovalPackage };

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

/**
 * POST .../notes/{noteId}/correct - never edits the note in place. Marks it rejected
 * (reviewReason "corrected") and writes one (plain correction) or two (split) brand-new
 * proposed notes as its replacement. Citations are always copied verbatim server-side -
 * this request has no field for editing them.
 */
export function correctNote(
  projectId: string,
  noteId: string,
  body: CorrectNoteRequest,
  signal?: AbortSignal,
) {
  return apiPost<NoteCorrectionResult>(
    `/projects/${enc(projectId)}/notes/${enc(noteId)}/correct`,
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

export function listConceptVersions(projectId: string, locationId: string, signal?: AbortSignal) {
  return apiGet<ConceptVersionList>(
    `/projects/${enc(projectId)}/locations/${enc(locationId)}/concepts`,
    undefined,
    { signal },
  );
}

/**
 * POST .../concepts/upload - raw image bytes (JPEG/PNG/WebP), filename as a query
 * param, one image per request - same convention as the reference/source uploads.
 * Never approves anything and never touches an existing approval either way.
 */
export function uploadConceptVersion(
  projectId: string,
  locationId: string,
  file: Blob,
  filename: string,
  opts: { onProgress?: (pct: number | null) => void; signal?: AbortSignal } = {},
) {
  const qs = `?filename=${enc(filename)}`;
  return uploadRaw<ConceptUploadResult>(
    `/projects/${enc(projectId)}/locations/${enc(locationId)}/concepts/upload${qs}`,
    file,
    opts,
  );
}

/**
 * POST .../concepts/from-reference - creates a concept-candidate version pointing
 * directly at an existing reference's own stored image (no bytes re-uploaded).
 * Permits a proposed or confirmed reference (only rejected is refused); never
 * confirms/mutates the reference note, and never touches any existing approval.
 */
export function promoteReferenceToConcept(
  projectId: string,
  locationId: string,
  referenceId: string,
  signal?: AbortSignal,
) {
  return apiPost<ConceptUploadResult>(
    `/projects/${enc(projectId)}/locations/${enc(locationId)}/concepts/from-reference`,
    { referenceId },
    { signal },
  );
}

export function getApproval(projectId: string, locationId: string, signal?: AbortSignal) {
  return apiGet<ApprovalState>(
    `/projects/${enc(projectId)}/locations/${enc(locationId)}/approval`,
    undefined,
    { signal },
  );
}

/** Read-only: exactly what a lock right now would capture. Persists nothing. */
export function previewApproval(
  projectId: string,
  locationId: string,
  conceptVersionId: string,
  referenceIds: string[],
  depictionLabel: string | null,
  signal?: AbortSignal,
) {
  return apiGet<ApprovalPreview>(
    `/projects/${enc(projectId)}/locations/${enc(locationId)}/approval/preview`,
    { conceptVersionId, referenceIds, depictionLabel: depictionLabel ?? undefined },
    { signal },
  );
}

export function lockApproval(
  projectId: string,
  locationId: string,
  body: ApprovalLockRequest,
  signal?: AbortSignal,
) {
  return apiPost<ApprovalLockResult>(
    `/projects/${enc(projectId)}/locations/${enc(locationId)}/approval/lock`,
    body,
    { signal },
  );
}
