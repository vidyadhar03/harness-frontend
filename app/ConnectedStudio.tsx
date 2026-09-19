"use client";
import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clapperboard,
  FileText,
  FileWarning,
  FolderPlus,
  Image as ImageIcon,
  Info,
  Layers,
  Link2,
  Lock,
  LoaderCircle,
  MapPin,
  MessageSquareOff,
  PanelLeftClose,
  PanelRightClose,
  PauseCircle,
  Pencil,
  Search,
  Settings2,
  Sparkles,
  Upload,
  WifiOff,
  X,
  XCircle,
} from "lucide-react";
import { apiBase, HarnessApiError, isAbortError } from "../lib/api";
import {
  correctNote,
  createProject,
  createReferenceJob,
  getApproval,
  getJob,
  getLocation,
  listConceptVersions,
  listLocations,
  listProjects,
  listReferences,
  listSources,
  lockApproval,
  previewApproval,
  promoteReferenceToConcept,
  resolveImageUrl,
  reviewNote,
  startIngest,
  uploadConceptVersion,
  uploadLocationReference,
  uploadSource,
  type ApprovalContent,
  type ApprovalPreview,
  type ApprovalState,
  type ConceptVersion,
  type SceneRequirement,
  type IngestOutcome,
  type IngestSourceResult,
  type JobStatusResult,
  type LocationDetail,
  type LocationSceneRequirement,
  type LocationSummary,
  type Note,
  type NoteCorrectionSuccessor,
  type ScopedNote,
  type ProjectSummary,
  type ReferenceNote,
  type RejectReason,
  type SourceSummary,
  type SourceUploadResult,
} from "../lib/harness";
import {
  clearGuidanceDraft,
  clearPendingIngestJob,
  clearPendingJob,
  getGuidanceDraft,
  getLastSelection,
  getPendingIngestJob,
  getPendingJob,
  setGuidanceDraft,
  setLastSelection,
  setPendingIngestJob,
  setPendingJob,
} from "../lib/prefs";

type Tab = "brief" | "references" | "concept";
type View = "workspace" | "sources";
type Modal = "projects" | "connection" | null;

type UploadRowState = "queued" | "uploading" | "done" | "error";
type UploadRow = {
  id: string;
  file: File;
  filename: string;
  state: "queued" | "uploading" | "done" | "error";
  progressPct: number | null;
  errorMessage?: string;
  result?: SourceUploadResult;
};

type RefUploadRow = {
  id: string;
  file: File;
  filename: string;
  state: "queued" | "uploading" | "done" | "already_attached" | "error";
  progressPct: number | null;
  errorMessage?: string;
};

type ConceptUploadRow = {
  id: string;
  file: File;
  filename: string;
  state: "queued" | "uploading" | "done" | "already_uploaded" | "error";
  progressPct: number | null;
  errorMessage?: string;
};

// One successor's editable fields in the correction editor - mirrors
// NoteCorrectionSuccessor, kept separate so the draft can hold in-progress text
// without shape-checking against the request type on every keystroke.
type CorrectionSuccessorDraft = {
  kind: string;
  body: string;
  sceneId: string | null;
  includeDescendants: boolean;
};
type CorrectionDraft = {
  split: boolean;
  successors: CorrectionSuccessorDraft[];
  // Non-null iff the note being corrected currently has an out-of-roster scope (see
  // outOfRosterSceneRequirements) - a human-readable label for it (e.g. "Scene 99"),
  // used to explain why Save is disabled and to show the preserved original scope for
  // comparison. Never set for a standing or already-linked-scene note.
  outOfRosterLabel: string | null;
  // True once the user has explicitly touched the "applies to" selector for the
  // successor carrying the original note's scope. Meaningless (and ignored) when
  // outOfRosterLabel is null. Gates Save so an out-of-roster note's old, now-invalid
  // scope can never be silently resubmitted or silently defaulted to standing -
  // opening or cancelling the editor never sets this on its own.
  scopeChosen: boolean;
};

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function describeUpload(r: SourceUploadResult): string {
  const bits: string[] = [];
  bits.push(r.created ? "Uploaded" : "Already uploaded");
  if (r.status === "unsupported") bits.push("unsupported file type");
  return bits.join(" · ");
}

const REJECT_REASONS: { value: RejectReason; label: string }[] = [
  { value: "not_useful", label: "Not useful" },
  { value: "wrong_scope", label: "Wrong scope" },
  { value: "duplicate", label: "Duplicate" },
  { value: "false", label: "Inaccurate" },
  { value: "other", label: "Other" },
];

function describeError(e: unknown): string {
  if (e instanceof HarnessApiError) return e.message;
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

// The Location brief tab's three note sections are the only place a corrected note
// could live once reloaded - a rejected note (which correction produces) is excluded
// from all three, same as any other rejected note.
// Searches every section a correctable note can live in - the three standing lists
// AND both scene-scoped lists. A note being corrected is never guaranteed to be
// standing (scene-scoped notes are correctable too - see BriefSceneRequirementsBlock),
// so searching only the standing lists would misreport an unchanged scene-scoped note
// as "gone" on every reconciliation. Never crosses sections for the SAME id - a
// correction always mints brand-new note id(s) and retires the original, so an id
// found here is always exactly where it currently lives, not "moved" from elsewhere.
function findNoteInDetail(d: LocationDetail, noteId: string): Note | null {
  const standing =
    d.descriptionNotes.find((n) => n.id === noteId) ??
    d.constraintNotes.find((n) => n.id === noteId) ??
    d.toneNotes.find((n) => n.id === noteId);
  if (standing) return standing;
  for (const s of d.sceneRequirements) {
    const found = s.notes.find((n) => n.id === noteId);
    if (found) return found;
  }
  for (const s of d.outOfRosterSceneRequirements) {
    const found = s.notes.find((n) => n.id === noteId);
    if (found) return found;
  }
  return null;
}

function nextSignal(ref: React.MutableRefObject<AbortController | null>): AbortSignal {
  ref.current?.abort();
  const c = new AbortController();
  ref.current = c;
  return c.signal;
}

export default function ConnectedStudio() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  const [projectId, setProjectId] = useState<string | null>(null);

  const [locations, setLocations] = useState<LocationSummary[]>([]);
  const [locationsLoading, setLocationsLoading] = useState(false);
  const [locationsError, setLocationsError] = useState<string | null>(null);

  const [locationId, setLocationId] = useState<string | null>(null);
  const [detail, setDetailState] = useState<LocationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [references, setReferences] = useState<ReferenceNote[]>([]);
  const [referencesLoading, setReferencesLoading] = useState(false);
  const [referencesError, setReferencesError] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>("references");
  const [view, setView] = useState<View>("workspace");
  const [sidebar, setSidebar] = useState(true);
  const [chat, setChat] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("All references");
  const [modal, setModal] = useState<Modal>(null);
  const [notice, setNotice] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [viewer, setViewer] = useState<ReferenceNote | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState<RejectReason>("not_useful");
  const [savingNoteId, setSavingNoteId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const dialog = useRef<HTMLDialogElement>(null);

  // --- brief note correction (Location brief tab only - never the approval preview or
  // an already-locked approved package, see API_CONTRACT.md's correction section). ---
  const [correctingNote, setCorrectingNote] = useState<Note | null>(null);
  const [correctionDraft, setCorrectionDraft] = useState<CorrectionDraft | null>(null);
  const [correctionBusy, setCorrectionBusy] = useState(false);
  const [correctionError, setCorrectionError] = useState<string | null>(null);
  // True only when a network failure left the outcome genuinely unknown and the API
  // gives no way to positively identify which note(s), if any, replaced the original -
  // retry is disabled until the user re-opens the editor from a freshly reloaded brief.
  const [correctionUnknown, setCorrectionUnknown] = useState(false);
  // Which note's editor is open right now, if any - checked (alongside activeScopeRef)
  // before a late async result mutates editor state, so closing the dialog (or opening
  // a different note's editor) before a request resolves can never reopen or overwrite
  // it with a stale result.
  const correctingNoteIdRef = useRef<string | null>(null);

  // --- new-project creation ---
  const [newProjectName, setNewProjectName] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [createProjectError, setCreateProjectError] = useState<string | null>(null);

  // --- source upload batch ---
  const [uploadBatchProjectId, setUploadBatchProjectId] = useState<string | null>(null);
  const [uploadRows, setUploadRows] = useState<UploadRow[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  // --- location reference image upload ---
  const refFileInput = useRef<HTMLInputElement>(null);
  const [refUploadBusy, setRefUploadBusy] = useState(false);
  const [refUploadRows, setRefUploadRows] = useState<RefUploadRow[]>([]);
  const [refUploadBatchScope, setRefUploadBatchScope] = useState<string | null>(null);
  const refUploadBatchScopeRef = useRef<string | null>(null);

  // --- authoritative uploaded-source list (GET /projects/{id}/sources) - separate from
  // the transient uploadRows above, which log individual upload *attempts* (including
  // repeats) rather than the deduped, server-persisted set. ---
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [sourcesError, setSourcesError] = useState<string | null>(null);

  // --- concept versions (location-scoped) ---
  const [concepts, setConcepts] = useState<ConceptVersion[]>([]);
  const [approvedVersionId, setApprovedVersionId] = useState<string | null>(null);
  const [conceptsLoading, setConceptsLoading] = useState(false);
  const [conceptsError, setConceptsError] = useState<string | null>(null);
  const conceptFileInput = useRef<HTMLInputElement>(null);
  const [conceptUploadBusy, setConceptUploadBusy] = useState(false);
  const [conceptUploadRows, setConceptUploadRows] = useState<ConceptUploadRow[]>([]);
  const [conceptUploadBatchScope, setConceptUploadBatchScope] = useState<string | null>(null);

  // Candidate + reference selection for a prospective approval - purely client-side
  // (per API_CONTRACT.md: "there is nothing to call here for that") until the user
  // explicitly previews and locks. Never persisted, never sent anywhere by itself.
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [selectedReferenceIds, setSelectedReferenceIds] = useState<string[]>([]);
  // Free-text, optional - "what does this image depict?" (e.g. "whole-house
  // exterior"). Client-side only until a preview/lock sends it; editing it
  // invalidates the current preview like any other selection change.
  const [depictionLabel, setDepictionLabel] = useState("");

  // Busy state for "use as concept candidate" (POST .../concepts/from-reference),
  // keyed by reference note id - a reference card's own action, independent of the
  // concept-upload batch above.
  const [promotingNoteId, setPromotingNoteId] = useState<string | null>(null);

  // Read-only "what a lock right now would capture" - invalidated the instant the
  // candidate or reference selection changes (see the effect below), so it can never
  // be locked against a selection it no longer describes.
  const [preview, setPreview] = useState<ApprovalPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [locking, setLocking] = useState(false);

  // Authoritative "what's currently locked for this location" - GET .../approval.
  const [approvalState, setApprovalState] = useState<ApprovalState | null>(null);
  const [approvalLoading, setApprovalLoading] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  const conceptsAbort = useRef<AbortController | null>(null);
  const previewAbort = useRef<AbortController | null>(null);
  const approvalAbort = useRef<AbortController | null>(null);

  // --- ingest job (project-scoped, separate from location reference jobs) ---
  const [ingestJobId, setIngestJobId] = useState<string | null>(null);
  const [ingestBusy, setIngestBusy] = useState(false);
  const [ingestPaused, setIngestPaused] = useState<string | null>(null); // pause reason, or null
  const [ingestStatus, setIngestStatus] = useState<JobStatusResult | null>(null);
  const [ingestStatusProjectId, setIngestStatusProjectId] = useState<string | null>(null);

  const projectsAbort = useRef<AbortController | null>(null);
  const locationsAbort = useRef<AbortController | null>(null);
  const detailAbort = useRef<AbortController | null>(null);
  const referencesAbort = useRef<AbortController | null>(null);
  const sourcesAbort = useRef<AbortController | null>(null);
  const pollingScopes = useRef<Set<string>>(new Set());
  const pollingIngestProjects = useRef<Set<string>>(new Set());
  const uploadBatchProjectIdRef = useRef<string | null>(null);
  // Bumped by every explicit project selection/creation - lets an async action started
  // before a newer one finished detect that it's now stale (e.g. a slow createProject
  // response landing after the user already picked a different project by hand).
  const selectionEpoch = useRef(0);

  // Tracks which (project, location) is on screen *right now*, read by the
  // long-lived job poller so a background run for a location the user has
  // navigated away from never overwrites what's currently shown.
  const activeScopeRef = useRef<string | null>(null);
  activeScopeRef.current = projectId && locationId ? `${projectId}:${locationId}` : null;
  const activeProjectRef = useRef<string | null>(null);
  activeProjectRef.current = projectId;

  useEffect(() => {
    if (notice) {
      const t = setTimeout(() => setNotice(""), 6000);
      return () => clearTimeout(t);
    }
  }, [notice]);
  useEffect(() => {
    if (modal || viewer || correctingNote) dialog.current?.showModal();
    else dialog.current?.close();
  }, [modal, viewer, correctingNote]);
  useEffect(() => {
    if (window.innerWidth < 960) setChat(false);
    if (window.innerWidth < 650) setSidebar(false);
  }, []);

  function loadProjects() {
    const signal = nextSignal(projectsAbort);
    setProjectsLoading(true);
    setProjectsError(null);
    listProjects(signal)
      .then((data) => {
        setProjects(data);
        setProjectsLoading(false);
        const last = getLastSelection();
        const preferred =
          last && data.some((p) => p.id === last.projectId) ? last.projectId : (data[0]?.id ?? null);
        setProjectId(preferred);
      })
      .catch((e) => {
        if (isAbortError(e)) return;
        setProjectsLoading(false);
        setProjectsError(describeError(e));
      });
  }

  useEffect(() => {
    loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function loadLocations(pid: string) {
    const signal = nextSignal(locationsAbort);
    setLocationsLoading(true);
    setLocationsError(null);
    listLocations(pid, signal)
      .then((locs) => {
        setLocations(locs);
        setLocationsLoading(false);
        const last = getLastSelection();
        const preferred =
          last && last.projectId === pid && locs.some((l) => l.id === last.locationId)
            ? last.locationId
            : (locs[0]?.id ?? null);
        setLocationId(preferred);
      })
      .catch((e) => {
        if (isAbortError(e)) return;
        setLocationsLoading(false);
        setLocationsError(describeError(e));
        setLocations([]);
        setLocationId(null);
      });
  }

  function loadSources(pid: string) {
    const signal = nextSignal(sourcesAbort);
    setSourcesLoading(true);
    setSourcesError(null);
    listSources(pid, signal)
      .then((data) => {
        setSources(data);
        setSourcesLoading(false);
      })
      .catch((e) => {
        if (isAbortError(e)) return;
        setSourcesLoading(false);
        setSourcesError(describeError(e));
        setSources([]);
      });
  }

  useEffect(() => {
    if (!projectId) {
      setLocations([]);
      setLocationId(null);
      setSources([]);
      return;
    }
    setLastSelection({ projectId, locationId: null });
    loadLocations(projectId);
    loadSources(projectId);

    // Ingest state belongs to whichever project is selected - clear the previous
    // project's terminal result from view, then check whether *this* project has a
    // run left mid-flight from an earlier session (resume-after-reload), or from
    // switching away and back while it was still going.
    setIngestStatus(null);
    setIngestStatusProjectId(null);
    setIngestPaused(null);
    const pendingIngest = getPendingIngestJob(projectId);
    setIngestJobId(pendingIngest?.jobId ?? null);
    setIngestBusy(!!pendingIngest);
    if (pendingIngest) void pollIngestJob(projectId, pendingIngest.jobId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  function loadDetail(pid: string, lid: string) {
    const signal = nextSignal(detailAbort);
    setDetailLoading(true);
    setDetailError(null);
    getLocation(pid, lid, signal)
      .then((d) => {
        setDetailState(d);
        setDetailLoading(false);
      })
      .catch((e) => {
        if (isAbortError(e)) return;
        setDetailLoading(false);
        setDetailError(describeError(e));
        setDetailState(null);
      });
  }

  async function fetchReferences(
    pid: string,
    lid: string,
    signal?: AbortSignal,
  ): Promise<ReferenceNote[]> {
    const r = await listReferences(pid, lid, { includeRejected: false }, signal);
    return r.references;
  }

  function loadReferences(pid: string, lid: string) {
    const signal = nextSignal(referencesAbort);
    setReferencesLoading(true);
    setReferencesError(null);
    fetchReferences(pid, lid, signal)
      .then((refs) => {
        setReferences(refs);
        setReferencesLoading(false);
      })
      .catch((e) => {
        if (isAbortError(e)) return;
        setReferencesLoading(false);
        setReferencesError(describeError(e));
        setReferences([]);
      });
  }

  function loadConcepts(pid: string, lid: string) {
    const signal = nextSignal(conceptsAbort);
    setConceptsLoading(true);
    setConceptsError(null);
    listConceptVersions(pid, lid, signal)
      .then((data) => {
        setConcepts(data.versions);
        setApprovedVersionId(data.approvedVersionId);
        setConceptsLoading(false);
      })
      .catch((e) => {
        if (isAbortError(e)) return;
        setConceptsLoading(false);
        setConceptsError(describeError(e));
        setConcepts([]);
      });
  }

  function loadApproval(pid: string, lid: string) {
    const signal = nextSignal(approvalAbort);
    setApprovalLoading(true);
    setApprovalError(null);
    getApproval(pid, lid, signal)
      .then((data) => {
        setApprovalState(data);
        setApprovalLoading(false);
      })
      .catch((e) => {
        if (isAbortError(e)) return;
        setApprovalLoading(false);
        setApprovalError(describeError(e));
        setApprovalState(null);
      });
  }

  useEffect(() => {
    setWarnings([]);
    if (!projectId || !locationId) {
      setDetailState(null);
      setReferences([]);
      setBusy(false);
      setConcepts([]);
      setApprovedVersionId(null);
      setApprovalState(null);
      setSelectedVersionId(null);
      setSelectedReferenceIds([]);
      setDepictionLabel("");
      setPreview(null);
      closeCorrection();
      return;
    }
    setLastSelection({ projectId, locationId });
    loadDetail(projectId, locationId);
    loadReferences(projectId, locationId);
    loadConcepts(projectId, locationId);
    loadApproval(projectId, locationId);

    // Candidate/reference selection and any unlocked preview belong to whichever
    // location was previously active - never carry them into a different one.
    setSelectedVersionId(null);
    setSelectedReferenceIds([]);
    setDepictionLabel("");
    setPreview(null);
    setPreviewError(null);
    closeCorrection();

    const pending = getPendingJob(projectId, locationId);
    setBusy(!!pending);
    if (pending) void pollJob(projectId, locationId, pending.jobId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, locationId]);

  // Preview invalidation: changing the candidate, the reference selection, or the
  // depiction label means the previously-fetched preview no longer describes what a
  // lock would capture - clear it so it can never be submitted against a stale
  // selection.
  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVersionId, selectedReferenceIds.join(","), depictionLabel]);

  // Refetch approval when returning to this tab, so edits made elsewhere (e.g.
  // rejecting a reference that was part of the approved package) are reflected.
  useEffect(() => {
    if (tab === "concept" && projectId && locationId) loadApproval(projectId, locationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function pollJob(pid: string, lid: string, jobId: string) {
    const scopeKey = `${pid}:${lid}`;
    if (pollingScopes.current.has(scopeKey)) return;
    pollingScopes.current.add(scopeKey);
    const isActive = () => activeScopeRef.current === scopeKey;
    try {
      for (let n = 0; n < 240; n++) {
        let job: JobStatusResult;
        try {
          job = await getJob(pid, jobId);
        } catch (e) {
          if (e instanceof HarnessApiError && e.status === 404) {
            clearPendingJob(pid, lid);
            if (isActive()) {
              setBusy(false);
              setNotice("That run could not be found. It may be from an earlier session.");
            }
            return;
          }
          // Transient network hiccup while polling - keep trying rather than
          // giving up (the job itself is unaffected either way).
          await sleep(3000);
          continue;
        }
        if (job.status === "failed") {
          clearPendingJob(pid, lid);
          if (isActive()) {
            setBusy(false);
            setNotice(job.error || "The run failed. Your existing references are unchanged.");
          }
          return;
        }
        if (job.status === "succeeded") {
          clearPendingJob(pid, lid);
          try {
            const refs = await fetchReferences(pid, lid);
            if (isActive()) {
              setReferences(refs);
              setBusy(false);
              setWarnings(job.warnings ?? []);
              setNotice(
                refs.length
                  ? "Your results are ready."
                  : "The run finished. No new references were found.",
              );
            }
          } catch {
            if (isActive()) {
              setBusy(false);
              setNotice("Results are ready. Reopen this location to refresh the list.");
            }
          }
          return;
        }
        await sleep(3000);
      }
      // Client-side give-up only: the backend has no execution timeout, so the
      // job keeps running - we must not mark it failed, just stop watching it.
      if (isActive()) {
        setBusy(false);
        setNotice("The run is still pending. Reload to reconnect.");
      }
    } finally {
      pollingScopes.current.delete(scopeKey);
    }
  }

  async function startReferenceJob() {
    if (!projectId || !locationId || busy) return;
    setBusy(true);
    try {
      const res = await createReferenceJob(projectId, locationId);
      setPendingJob(projectId, locationId, { jobId: res.id, startedAt: Date.now() });
      void pollJob(projectId, locationId, res.id);
    } catch (e) {
      setBusy(false);
      setNotice(describeError(e));
    }
  }

  // --- new project creation ------------------------------------------------------------

  async function handleCreateProject() {
    const name = newProjectName.trim();
    if (!name || creatingProject) return;
    const epochAtStart = selectionEpoch.current;
    setCreatingProject(true);
    setCreateProjectError(null);
    try {
      const p = await createProject(name);
      setProjects((prev) => [...prev, p].sort((a, b) => a.name.localeCompare(b.name)));
      setNewProjectName("");
      if (selectionEpoch.current === epochAtStart) {
        // Nothing was selected by hand while this was in flight - the newly created
        // project is what the user is still waiting for, so it becomes current.
        selectionEpoch.current += 1;
        setProjectId(p.id);
        setView("sources");
        setModal(null);
      } else {
        // A late response from this create must not switch the user back to it -
        // they've since picked something else. It still exists in the list above.
        setNotice(`"${p.name}" was created. You've since selected another project - find it in Projects.`);
      }
    } catch (e) {
      setCreateProjectError(describeError(e));
    } finally {
      setCreatingProject(false);
    }
  }

  // --- source upload (raw body, sequential, bound to the project the batch started on) --

  async function startUploadBatch(files: FileList | null) {
    if (!files || !files.length || !projectId) return;
    const batchProjectId = projectId;
    const sameBatch = uploadBatchProjectIdRef.current === batchProjectId;
    uploadBatchProjectIdRef.current = batchProjectId;
    setUploadBatchProjectId(batchProjectId);
    const newRows: UploadRow[] = Array.from(files).map((file) => ({
      id: uid(),
      file,
      filename: file.name,
      state: "queued",
      progressPct: null,
    }));
    setUploadRows((prev) => (sameBatch ? [...prev, ...newRows] : newRows));

    for (const row of newRows) {
      // Always the project this BATCH started on, never a live re-read of `projectId` -
      // switching projects mid-batch must not redirect the remaining uploads.
      setUploadRows((prev) =>
        prev.map((r) => (r.id === row.id ? { ...r, state: "uploading" } : r)),
      );
      try {
        const result = await uploadSource(batchProjectId, row.file, row.filename, {
          onProgress: (pct) =>
            setUploadRows((prev) =>
              prev.map((r) => (r.id === row.id ? { ...r, progressPct: pct } : r)),
            ),
        });
        setUploadRows((prev) =>
          prev.map((r) => (r.id === row.id ? { ...r, state: "done", result } : r)),
        );
      } catch (e) {
        setUploadRows((prev) =>
          prev.map((r) =>
            r.id === row.id ? { ...r, state: "error", errorMessage: describeError(e) } : r,
          ),
        );
      }
    }
    // Refresh the authoritative source list - but only if that project is still the
    // one on screen; if the user switched away mid-batch, leave it alone (returning to
    // that project re-fetches fresh via the project-change effect anyway).
    if (activeProjectRef.current === batchProjectId) loadSources(batchProjectId);
  }

  // --- location reference image upload (raw image body, sequential) ---

  async function handlePickReferenceFiles(files: FileList | null) {
    if (!files || !files.length || !projectId || !locationId) return;
    const targetPid = projectId;
    const targetLid = locationId;
    const batchScope = `${targetPid}:${targetLid}`;
    refUploadBatchScopeRef.current = batchScope;
    setRefUploadBatchScope(batchScope);
    setRefUploadBusy(true);

    const fileList = Array.from(files);
    const newRows: RefUploadRow[] = fileList.map((file) => ({
      id: uid(),
      file,
      filename: file.name,
      state: "queued",
      progressPct: null,
    }));
    setRefUploadRows(newRows);

    let createdCount = 0;
    let duplicateCount = 0;
    let errorCount = 0;

    for (const row of newRows) {
      setRefUploadRows((prev) =>
        prev.map((r) => (r.id === row.id ? { ...r, state: "uploading" } : r)),
      );

      try {
        const result = await uploadLocationReference(targetPid, targetLid, row.file, row.filename, {
          onProgress: (pct) =>
            setRefUploadRows((prev) =>
              prev.map((r) => (r.id === row.id ? { ...r, progressPct: pct } : r)),
            ),
        });

        if (result.created) {
          createdCount++;
          setRefUploadRows((prev) =>
            prev.map((r) => (r.id === row.id ? { ...r, state: "done" } : r)),
          );
        } else {
          duplicateCount++;
          setRefUploadRows((prev) =>
            prev.map((r) => (r.id === row.id ? { ...r, state: "already_attached" } : r)),
          );
        }
      } catch (e) {
        errorCount++;
        const msg = describeError(e);
        setRefUploadRows((prev) =>
          prev.map((r) =>
            r.id === row.id ? { ...r, state: "error", errorMessage: msg } : r,
          ),
        );
      }
    }

    setRefUploadBusy(false);

    // Only update and trigger notice if the user is STILL on the original location scope
    if (activeScopeRef.current === batchScope) {
      if (createdCount > 0) {
        loadReferences(targetPid, targetLid);
      }
      if (duplicateCount > 0 && createdCount === 0 && errorCount === 0) {
        setNotice(
          duplicateCount === 1
            ? "Image already attached to this location."
            : `${duplicateCount} images already attached to this location.`,
        );
      } else if (createdCount > 0 && duplicateCount > 0) {
        setNotice(
          `${createdCount} reference(s) uploaded, ${duplicateCount} already attached.`,
        );
      } else if (createdCount > 0) {
        setNotice(
          `${createdCount} reference image(s) uploaded.`,
        );
      }
    }
  }

  // --- concept-art upload (raw image body, sequential; location-scoped like the
  // reference upload above) -------------------------------------------------------------

  async function handlePickConceptFiles(files: FileList | null) {
    if (!files || !files.length || !projectId || !locationId) return;
    const targetPid = projectId;
    const targetLid = locationId;
    const batchScope = `${targetPid}:${targetLid}`;
    setConceptUploadBatchScope(batchScope);
    setConceptUploadBusy(true);

    const newRows: ConceptUploadRow[] = Array.from(files).map((file) => ({
      id: uid(),
      file,
      filename: file.name,
      state: "queued",
      progressPct: null,
    }));
    setConceptUploadRows(newRows);

    let createdCount = 0;
    let duplicateCount = 0;

    for (const row of newRows) {
      setConceptUploadRows((prev) =>
        prev.map((r) => (r.id === row.id ? { ...r, state: "uploading" } : r)),
      );
      try {
        // Always the project/location this BATCH started on, never a live re-read of
        // projectId/locationId - switching away mid-batch must not redirect the rest.
        const result = await uploadConceptVersion(targetPid, targetLid, row.file, row.filename, {
          onProgress: (pct) =>
            setConceptUploadRows((prev) =>
              prev.map((r) => (r.id === row.id ? { ...r, progressPct: pct } : r)),
            ),
        });
        if (result.created) createdCount++;
        else duplicateCount++;
        setConceptUploadRows((prev) =>
          prev.map((r) =>
            r.id === row.id ? { ...r, state: result.created ? "done" : "already_uploaded" } : r,
          ),
        );
      } catch (e) {
        setConceptUploadRows((prev) =>
          prev.map((r) =>
            r.id === row.id ? { ...r, state: "error", errorMessage: describeError(e) } : r,
          ),
        );
      }
    }

    setConceptUploadBusy(false);
    if (activeScopeRef.current === batchScope) {
      if (createdCount > 0 || duplicateCount > 0) loadConcepts(targetPid, targetLid);
      if (duplicateCount > 0 && createdCount === 0) {
        setNotice(
          duplicateCount === 1
            ? "This image was already uploaded as a version for this location."
            : `${duplicateCount} images were already uploaded as versions for this location.`,
        );
      } else if (createdCount > 0) {
        setNotice(`${createdCount} concept version(s) uploaded.`);
      }
    }
  }

  // --- reference -> concept candidate (POST .../concepts/from-reference) -----------------
  // A distinct action from selecting a reference as *supporting evidence* below: this
  // creates a candidate image from a proposed-or-confirmed reference's own already-
  // stored bytes (no re-upload), never confirms/mutates the reference note, and never
  // touches any existing approval.

  async function handleUseAsCandidate(note: ReferenceNote) {
    if (!projectId || !locationId || promotingNoteId) return;
    const pid = projectId;
    const lid = locationId;
    const scope = `${pid}:${lid}`;
    setPromotingNoteId(note.id);
    try {
      const result = await promoteReferenceToConcept(pid, lid, note.id);
      if (activeScopeRef.current === scope) {
        loadConcepts(pid, lid);
        setSelectedVersionId(result.id);
        setTab("concept");
        setNotice(
          result.created
            ? "Added as a concept candidate."
            : "This reference's image was already a concept candidate for this location - selected it.",
        );
      }
    } catch (e) {
      if (activeScopeRef.current === scope) setNotice(describeError(e));
    } finally {
      setPromotingNoteId(null);
    }
  }

  // --- approval preview + lock -----------------------------------------------------------

  function toggleReferenceSelection(noteId: string) {
    setSelectedReferenceIds((prev) =>
      prev.includes(noteId) ? prev.filter((id) => id !== noteId) : [...prev, noteId],
    );
  }

  function loadPreview(
    pid: string,
    lid: string,
    versionId: string,
    referenceIds: string[],
    label: string,
  ) {
    const scope = `${pid}:${lid}`;
    const signal = nextSignal(previewAbort);
    setPreviewLoading(true);
    setPreviewError(null);
    const trimmedLabel = label.trim() === "" ? null : label;
    previewApproval(pid, lid, versionId, referenceIds, trimmedLabel, signal)
      .then((p) => {
        if (activeScopeRef.current === scope) {
          setPreview(p);
          setPreviewLoading(false);
        }
      })
      .catch((e) => {
        if (isAbortError(e)) return;
        if (activeScopeRef.current === scope) {
          setPreviewError(describeError(e));
          setPreviewLoading(false);
        }
      });
  }

  function requestPreview() {
    if (!projectId || !locationId || !selectedVersionId) return;
    loadPreview(projectId, locationId, selectedVersionId, selectedReferenceIds, depictionLabel);
  }

  async function lockVisualDirection() {
    if (!projectId || !locationId || !preview || locking) return;
    const pid = projectId;
    const lid = locationId;
    const scope = `${pid}:${lid}`;
    setLocking(true);
    try {
      const result = await lockApproval(pid, lid, {
        conceptVersionId: preview.conceptVersionId,
        referenceIds: preview.references.map((r) => r.noteId),
        depictionLabel: preview.depictionLabel,
        contextToken: preview.contextToken,
        expectedRevision: approvalState?.revision ?? 0,
      });
      if (activeScopeRef.current === scope) {
        setApprovalState({
          locationId: result.approval.locationId,
          revision: result.approval.revision,
          approval: result.approval,
          isStale: false,
          staleReasons: [],
        });
        setConcepts((prev) =>
          prev.map((v) => ({ ...v, approved: v.id === result.approval.conceptVersionId })),
        );
        setApprovedVersionId(result.approval.conceptVersionId);
        setPreview(null);
        setNotice(result.created ? "Visual direction approved." : "This was already the approved direction.");
      }
    } catch (e) {
      if (e instanceof HarnessApiError && e.status === 409) {
        // Either the context (brief/reference) changed since the preview was fetched,
        // or someone else's lock is now current - both mean "re-fetch and look again,"
        // never "resend the same request." Preserve the user's selection, refresh what
        // a retry would need, and require an explicit re-click to lock - never auto-lock.
        setNotice(`${describeError(e)} Refreshing the current state - review it before trying again.`);
        loadApproval(pid, lid);
        loadPreview(pid, lid, selectedVersionId!, selectedReferenceIds, depictionLabel);
      } else if (e instanceof HarnessApiError && e.kind === "network") {
        // Unknown outcome, not a failure - the request may have landed. Reconcile
        // against the authoritative approval rather than assuming it failed or
        // silently resubmitting.
        setNotice("Couldn't confirm whether this was approved - checking the current state.");
        loadApproval(pid, lid);
      } else {
        setNotice(describeError(e));
      }
    } finally {
      setLocking(false);
    }
  }

  // --- ingest trigger + poll (project-scoped; separate pending-job storage from the
  // location-scoped reference job above, per API_CONTRACT.md) -------------------------

  async function pollIngestJob(pid: string, jobId: string) {
    if (pollingIngestProjects.current.has(pid)) return;
    pollingIngestProjects.current.add(pid);
    const isActive = () => activeProjectRef.current === pid;
    const applyPause = (reason: string) => {
      if (isActive()) {
        setIngestBusy(false);
        setIngestPaused(reason);
      }
    };
    try {
      for (let n = 0; n < 240; n++) {
        let job: JobStatusResult;
        try {
          job = await getJob(pid, jobId);
        } catch (e) {
          if (e instanceof HarnessApiError && e.status === 404) {
            clearPendingIngestJob(pid);
            if (isActive()) {
              setIngestBusy(false);
              setIngestJobId(null);
              setNotice("That ingest run could not be found. It may be from an earlier session.");
            }
            return;
          }
          // A network error means the run's status is UNKNOWN, not failed - the job
          // keeps going server-side regardless. Stop polling and let the user resume
          // checking explicitly, rather than silently retrying forever or guessing.
          applyPause(
            "Lost the connection while checking. Processing may still be happening on the server.",
          );
          return;
        }
        if (job.status === "failed") {
          clearPendingIngestJob(pid);
          if (isActive()) {
            setIngestBusy(false);
            setIngestStatus(job);
            setIngestStatusProjectId(pid);
            // Source statuses/errors change on a failed run too (e.g. a source now
            // shows status "failed") - refresh the authoritative list either way.
            loadSources(pid);
          }
          return;
        }
        if (job.status === "succeeded") {
          clearPendingIngestJob(pid);
          if (isActive()) {
            setIngestBusy(false);
            setIngestStatus(job);
            setIngestStatusProjectId(pid);
            loadSources(pid);
          }
          // Authoritative refetch, including partial outcomes - they can still have
          // produced usable locations worth surfacing.
          if (job.outcome === "complete" || job.outcome === "partial") {
            loadLocations(pid);
          }
          return;
        }
        await sleep(3000);
      }
      // Client-side give-up, not a failure verdict - see the reference-job poller's
      // identical rationale. The job id stays in storage so a reload (or "Resume
      // checking") can reconnect to it.
      applyPause("Still processing on the server. Checking timed out here.");
    } finally {
      pollingIngestProjects.current.delete(pid);
    }
  }

  async function startIngestJob() {
    if (!projectId || ingestBusy) return;
    setIngestPaused(null);
    try {
      const res = await startIngest(projectId);
      setPendingIngestJob(projectId, { jobId: res.id, startedAt: Date.now() });
      setIngestJobId(res.id);
      setIngestBusy(true);
      setIngestStatus(null);
      void pollIngestJob(projectId, res.id);
    } catch (e) {
      // 409: a different (or externally-started) ingest is already active. The response
      // body carries only a message, never an active job id - so there is nothing to
      // adopt or retry with different options automatically; just show the message.
      setNotice(describeError(e));
    }
  }

  function resumeIngestChecking() {
    if (!projectId || !ingestJobId) return;
    setIngestPaused(null);
    setIngestBusy(true);
    void pollIngestJob(projectId, ingestJobId);
  }

  function draftFor(note: ReferenceNote): string {
    if (note.id in drafts) return drafts[note.id];
    return getGuidanceDraft(note.id) ?? note.guidance;
  }
  function setDraft(noteId: string, value: string) {
    setDrafts((d) => ({ ...d, [noteId]: value }));
    setGuidanceDraft(noteId, value);
  }

  async function submitReview(
    note: ReferenceNote,
    body: { decision: "confirmed"; guidance?: string } | { decision: "rejected"; reason: RejectReason },
  ) {
    if (!projectId || !locationId) return;
    setSavingNoteId(note.id);
    try {
      const result = await reviewNote(projectId, note.id, {
        ...body,
        expectedRevision: note.revision,
        expectedStatus: note.status,
      });
      if (result.status === "rejected") {
        setReferences((prev) => prev.filter((r) => r.id !== note.id));
      } else {
        setReferences((prev) =>
          prev.map((r) =>
            r.id === note.id
              ? {
                  ...r,
                  status: result.status,
                  selected: result.status === "confirmed",
                  revision: result.revision,
                  guidance: result.guidance ?? r.guidance,
                }
              : r,
          ),
        );
      }
      clearGuidanceDraft(note.id);
      setDrafts((d) => {
        const { [note.id]: _drop, ...rest } = d;
        return rest;
      });
      setRejecting(null);
      setViewer(null);
      setNotice(body.decision === "confirmed" ? "Saved." : "Reference rejected.");
    } catch (e) {
      if (e instanceof HarnessApiError && e.status === 409) {
        // Preserve the draft (don't touch `drafts`/local storage), fetch the
        // current state, and make the user look before retrying.
        setNotice(
          "This reference changed elsewhere since you loaded it. Showing the latest state - review it before trying again.",
        );
        try {
          const fresh = await fetchReferences(projectId, locationId);
          if (activeScopeRef.current === `${projectId}:${locationId}`) setReferences(fresh);
        } catch {
          // leave the (now possibly stale) list as-is; the user can reopen the location
        }
      } else {
        setNotice(describeError(e));
      }
    } finally {
      setSavingNoteId(null);
    }
  }

  // --- brief note correction (Correct this note / Split into two requirements) -------

  function openCorrection(note: Note) {
    correctingNoteIdRef.current = note.id;
    setCorrectingNote(note);
    // A note's current sceneId only matches a real picker option if that scene is
    // still one of this location's own linked scenes - an out-of-roster note's
    // sceneId (see outOfRosterSceneRequirements) is never accepted by the server as a
    // successor's scope (only "standing" or a linked scene are). Preserve it exactly
    // as-is regardless - never silently coerce it to standing - and instead require
    // an explicit, informed choice before Save is enabled (see outOfRosterLabel/
    // scopeChosen below and CorrectionSuccessorFields).
    const rosterIds = new Set((detail?.scenes ?? []).map((s) => s.id));
    const isOutOfRoster = note.sceneId !== null && !rosterIds.has(note.sceneId);
    const outOfRosterLabel = isOutOfRoster
      ? (detail?.outOfRosterSceneRequirements.find((s) => s.sceneId === note.sceneId)?.heading ?? note.sceneId)
      : null;
    setCorrectionDraft({
      split: false,
      successors: [
        { kind: note.kind, body: note.body, sceneId: note.sceneId, includeDescendants: note.includeDescendants },
      ],
      outOfRosterLabel,
      scopeChosen: !isOutOfRoster,
    });
    setCorrectionError(null);
    setCorrectionUnknown(false);
  }

  function closeCorrection() {
    correctingNoteIdRef.current = null;
    setCorrectingNote(null);
    setCorrectionDraft(null);
    setCorrectionError(null);
    setCorrectionUnknown(false);
    setCorrectionBusy(false);
  }

  function updateCorrectionSuccessor(index: number, patch: Partial<CorrectionSuccessorDraft>) {
    setCorrectionDraft((prev) => {
      if (!prev) return prev;
      const successors = prev.successors.map((s, i) => (i === index ? { ...s, ...patch } : s));
      // Only touching the scope picker on the successor carrying the original note's
      // scope counts as the required explicit choice - editing body/kind, or editing
      // the split's second (already-standing) successor, must never satisfy it.
      const scopeChosen = prev.scopeChosen || (index === 0 && "sceneId" in patch);
      return { ...prev, successors, scopeChosen };
    });
  }

  function toggleSplit() {
    setCorrectionDraft((prev) => {
      if (!prev || !correctingNote) return prev;
      if (prev.split) {
        // Collapse back to one successor - keep whatever the first one currently says.
        return { ...prev, split: false, successors: [prev.successors[0]] };
      }
      // A blank second successor for the user to fill in - never pre-guessed from the
      // original's wording or scope.
      return {
        ...prev,
        split: true,
        successors: [prev.successors[0], { kind: correctingNote.kind, body: "", sceneId: null, includeDescendants: false }],
      };
    });
  }

  async function submitCorrection() {
    if (!projectId || !locationId || !correctingNote || !correctionDraft || correctionBusy) return;
    const pid = projectId;
    const lid = locationId;
    const scope = `${pid}:${lid}`;
    const note = correctingNote;
    const isOpen = () => activeScopeRef.current === scope && correctingNoteIdRef.current === note.id;
    setCorrectionBusy(true);
    setCorrectionError(null);
    try {
      const successors: NoteCorrectionSuccessor[] = correctionDraft.successors.map((s) => ({
        kind: s.kind as NoteCorrectionSuccessor["kind"],
        body: s.body,
        sceneId: s.sceneId,
        includeDescendants: s.includeDescendants,
      }));
      await correctNote(pid, note.id, {
        successors,
        expectedRevision: note.revision,
        expectedStatus: note.status,
      });
      if (activeScopeRef.current === scope) {
        loadDetail(pid, lid);
        loadApproval(pid, lid);
        setNotice(
          successors.length === 2
            ? "Saved - the original note was replaced by two proposed corrections."
            : "Saved - the original note was replaced by a proposed correction.",
        );
      }
      if (isOpen()) closeCorrection();
    } catch (e) {
      if (activeScopeRef.current !== scope) return;
      if (e instanceof HarnessApiError && e.status === 409) {
        // Someone else reviewed or corrected this note since it was opened. Nothing was
        // written - preserve every draft field the user typed, refresh the note's
        // current revision/status, and require an explicit resubmit rather than
        // retrying with the now-stale (revision, status) pair.
        if (isOpen()) {
          setCorrectionError(
            "This note changed elsewhere since you opened it. Review its current state below, then save again if your correction still applies.",
          );
        }
        try {
          const fresh = await getLocation(pid, lid);
          if (activeScopeRef.current !== scope) return;
          setDetailState(fresh);
          if (isOpen()) {
            const freshNote = findNoteInDetail(fresh, note.id);
            if (freshNote) setCorrectingNote(freshNote);
            else setCorrectionUnknown(true); // no longer live - nothing left to retry against
          }
        } catch {
          // Leave the (now possibly stale) note reference as-is; the user can close and
          // reopen this note's editor from the reloaded brief once it's reachable.
        }
      } else if (e instanceof HarnessApiError && e.kind === "network") {
        // Unknown outcome, not a failure - the request may have landed, or may still
        // be in flight and land later. Never automatically resubmit; reconcile against
        // the authoritative brief instead - and never claim a definitive outcome from
        // that reconciliation either. Seeing the note back exactly as it was does NOT
        // prove the request can't still commit a moment later (it may still be
        // in-flight server-side even though the client gave up waiting on it) - only a
        // synchronous response (success, or the 409 branch above) is ever definitive.
        if (isOpen()) setCorrectionError("Could not confirm whether this saved - checking the current brief.");
        try {
          const fresh = await getLocation(pid, lid);
          if (activeScopeRef.current !== scope) return;
          setDetailState(fresh);
          loadApproval(pid, lid);
          if (isOpen()) {
            const freshNote = findNoteInDetail(fresh, note.id);
            if (freshNote && freshNote.revision === note.revision && freshNote.status === note.status) {
              // Still exactly as it was before the request - but that is not proof the
              // write didn't land or can't still land later, only that it hasn't
              // visibly landed yet. Keep the draft and let the user decide whether to
              // retry now or wait and check again.
              setCorrectionError(
                "Could not confirm whether this saved. It still shows the version you started from, but a " +
                  "delayed request could still land after this check - you can try again, or wait and reload to check once more.",
              );
            } else if (freshNote) {
              // Present but changed - a definite, observed fact, though still not proof
              // of what THIS specific request did (a correction that succeeds always
              // retires the original's id rather than leaving it present-but-changed,
              // so this change came from something else) - refresh and require review.
              setCorrectingNote(freshNote);
              setCorrectionError(
                "Could not confirm whether this saved, and the note also changed elsewhere since you opened it. " +
                  "Review its current state below, then save again if your correction still applies.",
              );
            } else {
              // Gone from every section of the current brief. That may be this exact
              // correction landing, or an unrelated change (e.g. someone else's
              // correction or ordinary review) - NoteOut carries no
              // supersededByNoteIds (or similar) that would let a client tell those
              // apart, so this does not guess either outcome.
              setCorrectionUnknown(true);
              setCorrectionError(
                "Could not confirm whether this saved. The note is no longer in the current brief, but the " +
                  "API doesn't expose enough information here to tell whether this correction is what removed " +
                  "it. Close this editor and check the brief below for the outcome.",
              );
            }
          }
        } catch {
          if (isOpen()) {
            setCorrectionError(
              "Could not confirm whether this saved - couldn't reach the harness API. Reload the brief once it's back to check.",
            );
          }
        }
      } else if (isOpen()) {
        setCorrectionError(describeError(e));
      }
    } finally {
      if (activeScopeRef.current === scope) setCorrectionBusy(false);
    }
  }

  function selectProject(id: string) {
    selectionEpoch.current += 1;
    if (id === projectId) {
      setModal(null);
      return;
    }
    setProjectId(id);
    setView("workspace");
    setModal(null);
  }

  function selectLocation(id: string) {
    setLocationId(id);
    setFilter("All references");
    setView("workspace");
  }

  const currentProject = projects.find((p) => p.id === projectId) ?? null;
  const currentLocation = locations.find((l) => l.id === locationId) ?? null;
  const confirmedCount = references.filter((r) => r.status === "confirmed").length;
  const confirmedReferences = references.filter((r) => r.status === "confirmed");
  const categories = Array.from(new Set(references.map((r) => r.category))).sort();
  const filterOptions = ["All references", "Confirmed", "Inherited", ...categories];
  const shown = references.filter((r) => {
    if (filter === "All references") return true;
    if (filter === "Confirmed") return r.status === "confirmed";
    if (filter === "Inherited") return !r.owned;
    return r.category === filter;
  });

  const visibleUploadRows = uploadBatchProjectId === projectId ? uploadRows : [];
  const foreignBatchCount =
    uploadBatchProjectId && uploadBatchProjectId !== projectId
      ? uploadRows.filter((r) => r.state === "queued" || r.state === "uploading").length
      : 0;
  const ingestResultForCurrentProject =
    ingestStatusProjectId === projectId ? ingestStatus : null;

  function closeDialog() {
    setModal(null);
    setViewer(null);
    setRejecting(null);
    closeCorrection();
  }

  return (
    <div className={`studio ${sidebar ? "" : "no-sidebar"} ${chat ? "" : "no-chat"}`}>
      <aside className="sidebar" hidden={!sidebar}>
        <div className="brand">
          <span className="brand-icon">
            <Clapperboard size={21} />
          </span>
          <strong>
            motion<span>x</span>
          </strong>
          <span className="studio-label">STUDIO</span>
        </div>
        <button
          className="project-switch"
          onClick={() => setModal("projects")}
          disabled={projectsLoading && projects.length === 0}
        >
          <span className="project-mark">{(currentProject?.name || "?")[0]?.toUpperCase()}</span>
          <span>
            <strong>
              {projectsLoading && !currentProject
                ? "Loading…"
                : (currentProject?.name ?? "No project")}
            </strong>
            <small>{projects.length} project{projects.length === 1 ? "" : "s"}</small>
          </span>
          <ChevronDown size={15} />
        </button>
        <div className="nav-label">WORKSPACE</div>
        <button
          className={`nav-item ${view === "workspace" ? "active" : ""}`}
          onClick={() => {
            setView("workspace");
            setTab("references");
          }}
        >
          <MapPin size={17} /> Locations <span>{locations.length}</span>
        </button>
        <button
          className={`nav-item ${view === "sources" ? "active" : ""}`}
          onClick={() => setView("sources")}
        >
          <Upload size={17} /> Sources
          {(ingestBusy || foreignBatchCount > 0) && <span className="nav-badge" />}
        </button>
        <div className="sidebar-section">
          <span>LOCATIONS</span>
        </div>
        <label className="location-search">
          <Search size={15} />
          <input
            placeholder="Find a location"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Find location"
          />
        </label>
        <div className="location-list">
          {locationsLoading && <div className="hint sidebar-hint">Loading locations…</div>}
          {!locationsLoading && locationsError && (
            <div className="hint sidebar-hint">Couldn&apos;t load locations.</div>
          )}
          {!locationsLoading && !locationsError && locations.length === 0 && (
            <div className="hint sidebar-hint">No locations in this project yet.</div>
          )}
          {locations
            .filter((l) => l.name.toLowerCase().includes(search.toLowerCase()))
            .map((l) => (
              <button
                key={l.id}
                className={`location-item ${l.id === locationId ? "current" : ""}`}
                onClick={() => selectLocation(l.id)}
              >
                <span className="location-glyph">
                  <MapPin size={15} />
                </span>
                <span>
                  <strong>{l.name}</strong>
                  <small>
                    {l.sceneNumbers.length} scene{l.sceneNumbers.length === 1 ? "" : "s"}
                    {l.parentName ? ` · ${l.parentName}` : ""}
                  </small>
                </span>
                {l.id === locationId && <span className="selected-dot" />}
              </button>
            ))}
        </div>
        <div className="sidebar-bottom">
          <div className="workflow-tip">
            <Layers size={18} />
            <strong>Build a place, one decision at a time.</strong>
            <p>From the script to a world you can step into.</p>
          </div>
          <button className="profile" onClick={() => setModal("connection")}>
            <span className="avatar">
              <Link2 size={15} />
            </span>
            <span>
              <strong>Connected</strong>
              <small>{apiBase}</small>
            </span>
            <Settings2 size={17} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon"
              aria-label="Toggle locations"
              onClick={() => setSidebar(!sidebar)}
            >
              <PanelLeftClose size={18} />
            </button>
            <span>{currentProject?.name ?? "—"}</span>
            <ChevronRight size={14} />
            <span>Locations</span>
            <ChevronRight size={14} />
            <strong>{currentLocation?.name ?? "—"}</strong>
          </div>
          <div className="top-actions">
            <span className="sample-badge">Connected</span>
            <button className="chat-toggle" onClick={() => setChat(!chat)}>
              <Sparkles size={16} />
              <span>Creative assistant</span>
            </button>
          </div>
        </header>
        {projectsError && (
          <div className="error-banner" role="alert">
            <WifiOff size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            {projectsError}{" "}
            <button className="retry-link" onClick={loadProjects}>
              Retry
            </button>
          </div>
        )}
        {!projectsError && locationsError && (
          <div className="error-banner" role="alert">
            {locationsError}{" "}
            <button className="retry-link" onClick={() => projectId && loadLocations(projectId)}>
              Retry
            </button>
          </div>
        )}
        <div className="workspace-body">
          <main className="canvas">
            {view === "sources" && projectId ? (
              <SourcesPanel
                projectName={currentProject?.name ?? null}
                sources={sources}
                sourcesLoading={sourcesLoading}
                sourcesError={sourcesError}
                onRetrySources={() => projectId && loadSources(projectId)}
                uploadRows={visibleUploadRows}
                foreignBatchCount={foreignBatchCount}
                onPickFiles={() => fileInput.current?.click()}
                ingestBusy={ingestBusy}
                ingestPaused={ingestPaused}
                ingestResult={ingestResultForCurrentProject}
                onStartIngest={startIngestJob}
                onResumeChecking={resumeIngestChecking}
                locationsCount={locations.length}
                onContinueToLocations={() => setView("workspace")}
              />
            ) : !projectsLoading && !projectsError && projects.length === 0 ? (
              <div className="empty">
                <FolderEmptyIcon />
                <h3>No projects yet</h3>
                <p>Create a project to start uploading a screenplay or notes.</p>
                <button className="primary" onClick={() => setModal("projects")}>
                  <FolderPlus size={16} />
                  New project
                </button>
              </div>
            ) : !locationId && !locationsLoading ? (
              <div className="empty">
                <MapPin size={35} />
                <h3>No location selected</h3>
                <p>
                  {locations.length === 0
                    ? "This project has no locations yet - upload and process sources to extract some."
                    : "Choose a location from the sidebar."}
                </p>
                {locations.length === 0 && (
                  <button className="outline" onClick={() => setView("sources")}>
                    <Upload size={15} />
                    Go to sources
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="location-heading">
                  <div>
                    <div className="eyebrow">
                      LOCATION WORKSPACE
                      {detail?.ancestors?.[0] && <span> / {detail.ancestors[0].toUpperCase()}</span>}
                    </div>
                    <h1>{currentLocation?.name ?? (detailLoading ? "Loading…" : "—")}</h1>
                    <div className="location-meta">
                      <span>
                        <Clapperboard size={14} /> Scenes{" "}
                        {detail?.scenes?.map((s) => s.number).filter(Boolean).join(", ") ||
                          currentLocation?.sceneNumbers.join(", ") ||
                          "not assigned"}
                      </span>
                      {detail?.status && (
                        <span className="status-pill">
                          <span className="tiny-dot" />
                          {detail.status[0].toUpperCase() + detail.status.slice(1)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <nav className="tabs" aria-label="Location stages">
                  {(["brief", "references", "concept"] as Tab[]).map((t, i) => (
                    <button
                      key={t}
                      onClick={() => setTab(t)}
                      aria-current={tab === t ? "page" : undefined}
                      className={tab === t ? "selected" : ""}
                    >
                      <span className="step">
                        {t === "concept" && approvedVersionId ? <Lock size={11} /> : i + 1}
                      </span>
                      {t === "brief"
                        ? "Location brief"
                        : t === "references"
                          ? "Visual references"
                          : "Concept & approval"}
                      {t === "references" && <span className="count">{references.length}</span>}
                      {t === "concept" && concepts.length > 0 && (
                        <span className="count">{concepts.length}</span>
                      )}
                    </button>
                  ))}
                </nav>
                {tab === "brief" && (
                  <section className="brief-view">
                    <div className="section-title">
                      <div>
                        <h2>A shared picture of the place</h2>
                        <p>Extracted notes from the script and source material, grouped by kind.</p>
                      </div>
                      <FileText size={24} />
                    </div>
                    <div className="sample-note">
                      There&apos;s no editable working brief yet - see workspace settings - but you
                      can correct an individual note&apos;s wording, kind, or scope below.
                    </div>
                    {detailLoading && <div className="hint">Loading brief…</div>}
                    {detailError && (
                      <div className="error-banner">
                        {detailError}{" "}
                        <button
                          className="retry-link"
                          onClick={() => projectId && locationId && loadDetail(projectId, locationId)}
                        >
                          Retry
                        </button>
                      </div>
                    )}
                    {detail && (
                      <>
                        {detail.scenes.length > 0 && (
                          <NoteGroup title="Linked scenes">
                            <ul className="scene-list">
                              {detail.scenes.map((s) => (
                                <li key={s.id}>
                                  {s.number && <strong>{s.number}</strong>} {s.name}
                                </li>
                              ))}
                            </ul>
                          </NoteGroup>
                        )}
                        <NoteBlock title="Description" notes={detail.descriptionNotes} onCorrect={openCorrection} />
                        <NoteBlock title="Constraints" notes={detail.constraintNotes} onCorrect={openCorrection} />
                        <NoteBlock title="Tone" notes={detail.toneNotes} onCorrect={openCorrection} />
                        <BriefSceneRequirementsBlock items={detail.sceneRequirements} onCorrect={openCorrection} />
                        <OutOfRosterSceneRequirementsBlock
                          items={detail.outOfRosterSceneRequirements}
                          onCorrect={openCorrection}
                        />
                        {detail.supersededSources.length > 0 && (
                          <p className="hint">
                            {detail.supersededSources.length} source(s) superseded by a newer version.
                          </p>
                        )}
                        {detail.descriptionNotes.length === 0 &&
                          detail.constraintNotes.length === 0 &&
                          detail.toneNotes.length === 0 &&
                          detail.sceneRequirements.every((s) => s.notes.length === 0) &&
                          detail.outOfRosterSceneRequirements.length === 0 && (
                            <div className="empty">
                              <FileText size={30} />
                              <h3>No extracted notes yet</h3>
                              <p>Nothing has been written for this location&apos;s brief yet.</p>
                            </div>
                          )}
                      </>
                    )}
                  </section>
                )}
                {tab === "references" && (
                  <section className="reference-view">
                    {warnings.length > 0 && (
                      <div className="brief-banner warning-banner">
                        <div>
                          <AlertTriangle size={17} />
                          <span>{warnings.join(" ")}</span>
                        </div>
                      </div>
                    )}
                    <div className="section-title">
                      <div>
                        <h2>Find the feeling of this place.</h2>
                        <p>Confirm the references worth keeping, reject the rest.</p>
                      </div>
                      <div className="button-row">
                        <button
                          className="outline"
                          disabled={busy || refUploadBusy || !locationId}
                          onClick={() => refFileInput.current?.click()}
                        >
                          {refUploadBusy ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />}
                          Upload reference
                        </button>
                        <button className="primary" disabled={busy || refUploadBusy} onClick={startReferenceJob}>
                          {busy ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
                          Find inspiration
                        </button>
                      </div>
                    </div>
                    {refUploadBatchScope === `${projectId}:${locationId}` && refUploadRows.length > 0 && (
                      <div className="upload-list ref-upload-list" style={{ marginBottom: "16px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                          <span className="hint" style={{ fontWeight: 600 }}>Reference uploads</span>
                          {!refUploadBusy && (
                            <button
                              className="icon"
                              onClick={() => setRefUploadRows([])}
                              title="Clear upload list"
                              aria-label="Clear upload list"
                            >
                              <X size={14} />
                            </button>
                          )}
                        </div>
                        {refUploadRows.map((r) => (
                          <div
                            key={r.id}
                            className={`upload-row upload-row-${r.state === "already_attached" ? "done" : r.state}`}
                          >
                            <span className="upload-row-icon">
                              {r.state === "queued" && <Circle size={14} />}
                              {r.state === "uploading" && <LoaderCircle className="spin" size={16} />}
                              {r.state === "done" && <CheckCircle2 size={16} />}
                              {r.state === "already_attached" && <Info size={16} />}
                              {r.state === "error" && <XCircle size={16} />}
                            </span>
                            <span className="upload-row-name">{r.filename}</span>
                            <span className="upload-row-status">
                              {r.state === "queued" && "Queued…"}
                              {r.state === "uploading" &&
                                (r.progressPct !== null ? `Uploading… ${r.progressPct}%` : "Uploading…")}
                              {r.state === "done" && "Uploaded"}
                              {r.state === "already_attached" && "Already attached to this location"}
                              {r.state === "error" && (r.errorMessage || "Failed")}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {referencesLoading && <div className="hint">Loading references…</div>}
                    {referencesError && (
                      <div className="error-banner">
                        {referencesError}{" "}
                        <button
                          className="retry-link"
                          onClick={() => projectId && locationId && loadReferences(projectId, locationId)}
                        >
                          Retry
                        </button>
                      </div>
                    )}
                    {!referencesLoading && !referencesError && (
                      <>
                        <div className="filter-row">
                          {filterOptions.map((f) => (
                            <button
                              className={filter === f ? "active" : ""}
                              key={f}
                              onClick={() => setFilter(f)}
                            >
                              {f}
                              {f === "Confirmed" && <span>{confirmedCount}</span>}
                            </button>
                          ))}
                          <span className="results-count">{shown.length} references</span>
                        </div>
                        {shown.length > 0 ? (
                          <div className="reference-grid">
                            {shown.map((r, i) => (
                              <ReferenceCard
                                key={r.id}
                                r={r}
                                index={i}
                                draft={draftFor(r)}
                                onDraftChange={(v) => setDraft(r.id, v)}
                                saving={savingNoteId === r.id}
                                rejecting={rejecting === r.id}
                                rejectReason={rejectReason}
                                onRejectReasonChange={setRejectReason}
                                onOpen={() => setViewer(r)}
                                onConfirm={() =>
                                  submitReview(r, { decision: "confirmed", guidance: draftFor(r) })
                                }
                                onStartReject={() => setRejecting(r.id)}
                                onCancelReject={() => setRejecting(null)}
                                onConfirmReject={() =>
                                  submitReview(r, { decision: "rejected", reason: rejectReason })
                                }
                                promotingCandidate={promotingNoteId === r.id}
                                onUseAsCandidate={() => void handleUseAsCandidate(r)}
                              />
                            ))}
                          </div>
                        ) : (
                          <div className="empty">
                            <ImageIcon size={35} />
                            <h3>
                              {references.length === 0
                                ? "A fresh board for this location."
                                : "Nothing matches this filter."}
                            </h3>
                            <p>
                              {references.length === 0
                                ? "Run “Find inspiration” to search for references."
                                : "Try a different filter."}
                            </p>
                          </div>
                        )}
                        <div className="selection-bar">
                          <div>
                            <span className="selection-stack">
                              <Layers size={20} />
                            </span>
                            <span>
                              <strong>
                                {confirmedCount
                                  ? `${confirmedCount} references confirmed`
                                  : "Nothing confirmed yet"}
                              </strong>
                              <small>Confirm the references that define this location&apos;s look.</small>
                            </span>
                          </div>
                          <button className="text-action" onClick={() => setTab("concept")}>
                            Shape the concept <ArrowRight size={17} />
                          </button>
                        </div>
                      </>
                    )}
                  </section>
                )}
                {tab === "concept" && (
                  <section className="concept-view">
                    <div className="section-title">
                      <div>
                        <h2>Make it your location.</h2>
                        <p>
                          Upload a finished concept image, then lock one version - with the brief and
                          the references it should carry - as the approved visual direction.
                        </p>
                      </div>
                      <div className="button-row">
                        <button
                          className="outline"
                          disabled={conceptUploadBusy || !locationId}
                          onClick={() => conceptFileInput.current?.click()}
                        >
                          {conceptUploadBusy ? (
                            <LoaderCircle className="spin" size={16} />
                          ) : (
                            <Upload size={16} />
                          )}
                          Upload concept
                        </button>
                      </div>
                    </div>

                    {conceptUploadBatchScope === `${projectId}:${locationId}` &&
                      conceptUploadRows.length > 0 && (
                        <div className="upload-list" style={{ marginBottom: "20px" }}>
                          {conceptUploadRows.map((r) => (
                            <ConceptUploadRowView key={r.id} row={r} />
                          ))}
                        </div>
                      )}

                    {conceptsLoading && <div className="hint">Loading concept versions…</div>}
                    {conceptsError && (
                      <div className="error-banner">
                        {conceptsError}{" "}
                        <button
                          className="retry-link"
                          onClick={() => projectId && locationId && loadConcepts(projectId, locationId)}
                        >
                          Retry
                        </button>
                      </div>
                    )}
                    {!conceptsLoading && !conceptsError && concepts.length === 0 && (
                      <div className="empty concept-empty">
                        <span className="empty-art">
                          <ImageIcon size={37} />
                          <Sparkles size={18} />
                        </span>
                        <h3>No concept art yet.</h3>
                        <p>
                          Upload a finished image to start choosing a visual direction. There is no
                          image generation in this phase - every version here is something you upload.
                        </p>
                      </div>
                    )}
                    {!conceptsLoading && !conceptsError && concepts.length > 0 && (
                      <>
                        <div className="concept-grid">
                          {concepts.map((v) => (
                            <ConceptVersionCard
                              key={v.id}
                              v={v}
                              selected={v.id === selectedVersionId}
                              onSelect={() => setSelectedVersionId(v.id)}
                            />
                          ))}
                        </div>

                        <div className="direction-summary">
                          <span className="eyebrow">APPLICABLE REFERENCES</span>
                          <p>
                            Choose which confirmed references this approval should carry. None are
                            selected automatically.
                          </p>
                          {confirmedReferences.length === 0 ? (
                            <p className="hint">
                              No confirmed references yet - confirm some on the references tab first.
                            </p>
                          ) : (
                            <div className="reference-picker-list">
                              {confirmedReferences.map((r) => (
                                <label key={r.id} className="reference-picker-row">
                                  <input
                                    type="checkbox"
                                    checked={selectedReferenceIds.includes(r.id)}
                                    onChange={() => toggleReferenceSelection(r.id)}
                                  />
                                  <img src={resolveImageUrl(r.image)} alt={r.title} />
                                  <span>
                                    {r.title}
                                    {!r.owned && <small> · from {r.inheritedFrom}</small>}
                                  </span>
                                </label>
                              ))}
                            </div>
                          )}
                          <label className="guidance-field" style={{ marginTop: 16 }}>
                            WHAT DOES THIS IMAGE DEPICT? (OPTIONAL)
                            <input
                              value={depictionLabel}
                              onChange={(e) => setDepictionLabel(e.target.value)}
                              placeholder="e.g. Whole-house exterior, Bedroom interior — top view"
                              maxLength={200}
                            />
                          </label>
                          <div className="button-row" style={{ marginTop: 16 }}>
                            <button
                              className="outline"
                              disabled={!selectedVersionId || previewLoading}
                              onClick={requestPreview}
                            >
                              {previewLoading ? (
                                <LoaderCircle className="spin" size={15} />
                              ) : (
                                <Sparkles size={15} />
                              )}
                              Preview approval
                            </button>
                          </div>
                          {!selectedVersionId && (
                            <p className="hint" style={{ marginTop: 10 }}>
                              Select a concept version above first.
                            </p>
                          )}
                          {previewError && <div className="error-banner">{previewError}</div>}
                        </div>

                        {preview && (
                          <div className="approval-preview-box">
                            <span className="eyebrow">PREVIEW - NOT YET APPROVED</span>
                            <ApprovalContentView content={preview} />
                            <div className="button-row" style={{ marginTop: 18 }}>
                              <button className="primary" disabled={locking} onClick={lockVisualDirection}>
                                {locking ? (
                                  <LoaderCircle className="spin" size={16} />
                                ) : (
                                  <Lock size={16} />
                                )}
                                Lock visual direction
                              </button>
                            </div>
                          </div>
                        )}
                      </>
                    )}

                    {approvalLoading && <div className="hint">Loading approval status…</div>}
                    {approvalError && (
                      <div className="error-banner">
                        {approvalError}{" "}
                        <button
                          className="retry-link"
                          onClick={() => projectId && locationId && loadApproval(projectId, locationId)}
                        >
                          Retry
                        </button>
                      </div>
                    )}
                    {approvalState?.approval && (
                      <div className="approved-package">
                        <div className="approved-banner">
                          <Lock size={20} />
                          <div>
                            <strong>Visual direction approved</strong>
                            <p>
                              Locked {new Date(approvalState.approval.lockedAt).toLocaleString()}
                              {approvalState.approval.lockedBy ? ` by ${approvalState.approval.lockedBy}` : ""}.
                            </p>
                          </div>
                        </div>
                        {approvalState.isStale && (
                          <div className="brief-banner warning-banner">
                            <div>
                              <AlertTriangle size={17} />
                              <span>
                                The brief, a scene, a selected reference, or the depiction label has
                                changed since this was approved. The approval below is preserved as-is -
                                preview and lock again to update it.
                              </span>
                            </div>
                          </div>
                        )}
                        {approvalState.isStale && approvalState.staleReasons.length > 0 && (
                          <ul className="stale-reasons">
                            {approvalState.staleReasons.map((reason, i) => (
                              <li key={i}>{reason}</li>
                            ))}
                          </ul>
                        )}
                        <ApprovalContentView
                          content={approvalState.approval}
                          sceneCoverageComplete={approvalState.approval.sceneCoverageComplete}
                        />
                      </div>
                    )}

                    <p className="hint" style={{ marginTop: 24 }}>
                      Sending an approved direction to 3D blockout isn&apos;t connected yet.
                    </p>
                  </section>
                )}
              </>
            )}
            <footer className="canvas-footer">
              <span>{currentProject?.name?.toUpperCase() ?? ""} / LOCATION DEVELOPMENT</span>
              <span>Connected to {apiBase}</span>
            </footer>
          </main>
          {chat && (
            <aside className="assistant-panel">
              <div className="assistant-heading">
                <div>
                  <span className="spark-icon">
                    <Sparkles size={18} />
                  </span>
                  <strong>Creative assistant</strong>
                </div>
                <button className="icon" aria-label="Close assistant" onClick={() => setChat(false)}>
                  <PanelRightClose size={18} />
                </button>
              </div>
              <div className="conversation chat-disabled">
                <div className="assistant-intro">
                  <span className="assistant-avatar">
                    <MessageSquareOff size={20} />
                  </span>
                  <h3>AI chat isn&apos;t available yet</h3>
                  <p>
                    The harness doesn&apos;t expose a chat endpoint in this phase. You can still
                    review the extracted brief and manage references for this location.
                  </p>
                </div>
              </div>
            </aside>
          )}
        </div>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept=".pdf,.txt,.md,.png,.jpg,.jpeg,.webp,.heic,.heif"
        multiple
        hidden
        onChange={(e) => {
          void startUploadBatch(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={refFileInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        hidden
        onChange={(e) => {
          void handlePickReferenceFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={conceptFileInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        hidden
        onChange={(e) => {
          void handlePickConceptFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {notice && (
        <div className="toast" role="status">
          <Check size={17} />
          {notice}
          <button className="icon" aria-label="Dismiss notification" onClick={() => setNotice("")}>
            <X size={15} />
          </button>
        </div>
      )}
      <dialog
        ref={dialog}
        onCancel={closeDialog}
        onClick={(e) => {
          if (e.target === e.currentTarget) closeDialog();
        }}
      >
        <div className="dialog-content">
          <button className="dialog-close icon" onClick={closeDialog} aria-label="Close dialog">
            <X size={20} />
          </button>
          {modal === "connection" && (
            <>
              <span className="dialog-symbol">
                <Settings2 size={24} />
              </span>
              <h2>Workspace connection</h2>
              <div className="connection-status">
                <span className="tiny-dot" />
                Harness API configured at <code>{apiBase}</code>
              </div>
              <p>
                Available now: creating a project, uploading a screenplay/notes and processing
                them into locations, browsing projects and locations, reading extracted brief
                context, confirming/rejecting references, and running reference search.
              </p>
              <p className="small">
                Not yet available from this workspace: editing or approving the working brief, AI
                chat, concept generation, and reference/concept-art uploads.
              </p>
              <button className="primary" onClick={closeDialog}>
                Back to workspace
              </button>
            </>
          )}
          {modal === "projects" && (
            <>
              <span className="eyebrow">PROJECTS</span>
              <h2>New project</h2>
              <form
                className="new-project-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleCreateProject();
                }}
              >
                <input
                  autoFocus
                  required
                  maxLength={120}
                  placeholder="e.g. Dehleez"
                  aria-label="New project name"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  disabled={creatingProject}
                />
                <button className="primary" type="submit" disabled={creatingProject || !newProjectName.trim()}>
                  {creatingProject ? <LoaderCircle className="spin" size={15} /> : <FolderPlus size={15} />}
                  Create
                </button>
              </form>
              {createProjectError && <p className="hint error-text">{createProjectError}</p>}
              <h2 className="modal-subheading">Switch project</h2>
              {projectsLoading && <p>Loading projects…</p>}
              {projectsError && <p>{projectsError}</p>}
              {!projectsLoading && !projectsError && projects.length === 0 && (
                <p>No projects yet - create one above.</p>
              )}
              {projects.map((p) => (
                <button
                  key={p.id}
                  className="source-row project-row"
                  onClick={() => selectProject(p.id)}
                >
                  <MapPin size={18} />
                  <span>{p.name}</span>
                  {p.id === projectId && <small>Current</small>}
                </button>
              ))}
            </>
          )}
          {viewer && !modal && (
            <ReferenceDialog
              r={viewer}
              draft={draftFor(viewer)}
              onDraftChange={(v) => setDraft(viewer.id, v)}
              saving={savingNoteId === viewer.id}
              rejecting={rejecting === viewer.id}
              rejectReason={rejectReason}
              onRejectReasonChange={setRejectReason}
              onConfirm={() => submitReview(viewer, { decision: "confirmed", guidance: draftFor(viewer) })}
              onStartReject={() => setRejecting(viewer.id)}
              onCancelReject={() => setRejecting(null)}
              onConfirmReject={() => submitReview(viewer, { decision: "rejected", reason: rejectReason })}
              promotingCandidate={promotingNoteId === viewer.id}
              onUseAsCandidate={() => void handleUseAsCandidate(viewer)}
            />
          )}
          {correctingNote && !modal && !viewer && correctionDraft && (
            <CorrectionEditor
              original={correctingNote}
              scenes={detail?.scenes ?? []}
              draft={correctionDraft}
              busy={correctionBusy}
              error={correctionError}
              unknown={correctionUnknown}
              onSuccessorChange={updateCorrectionSuccessor}
              onToggleSplit={toggleSplit}
              onSave={() => void submitCorrection()}
              onClose={closeDialog}
            />
          )}
        </div>
      </dialog>
    </div>
  );
}

function FolderEmptyIcon() {
  return <Layers size={35} />;
}

function NoteGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="note-group">
      <h3 className="note-group-title">{title}</h3>
      {children}
    </div>
  );
}

// "description" -> "Description", etc. Falls back to capitalizing whatever string
// arrives (kind is deliberately an open string on the wire, not a fixed literal - see
// harness.ts) rather than hiding an unrecognized kind entirely.
function describeNoteKind(kind: string): string {
  const known: Record<string, string> = { description: "Description", constraint: "Constraint", tone: "Tone" };
  return known[kind] ?? (kind.length ? kind[0].toUpperCase() + kind.slice(1) : kind);
}

function NoteItem({
  note,
  onCorrect,
  readOnlyHint,
  showKind,
}: {
  note: LocationDetail["descriptionNotes"][number];
  // Only ever passed on the current Location brief tab - never inside an approval
  // preview or an already-locked approved package (see API_CONTRACT.md's correction
  // section: controls belong on the live brief, not a historical snapshot). Callers
  // must gate this on owned && editable themselves for a ScopedNote - never assume
  // either just because today's fixtures happen to always be owned.
  onCorrect?: (note: Note) => void;
  // Shown instead of a correct button for an inherited (owned: false) scene note -
  // e.g. "Inherited from Devgram - read-only here".
  readOnlyHint?: string;
  // Scene-specific cards only (Brief tab's own scene requirements, out-of-roster,
  // approval preview, and an approved package's own snapshot) - standing
  // Description/Constraint/Tone sections already say the kind in their own heading,
  // so this stays unset there. Always reads note.kind exactly as stored/returned -
  // never inferred or recomputed, so a historical snapshot's own kind is preserved
  // as-is even if current extraction logic would classify it differently today.
  showKind?: boolean;
}) {
  return (
    <div className="note-item">
      {showKind && <span className="note-kind-label">{describeNoteKind(note.kind)}</span>}
      <p>{note.body}</p>
      {note.citations.length > 0 && (
        <ul className="citation-list">
          {note.citations.map((c, i) => (
            <li key={i}>
              {c.url ? (
                <a href={c.url} target="_blank" rel="noreferrer">
                  {c.title || c.filename || "Source"}
                </a>
              ) : (
                <span>{c.filename || c.title || "Source"}</span>
              )}
              {c.page != null && ` · p.${c.page}`}
              {c.quote && <blockquote>&ldquo;{c.quote}&rdquo;</blockquote>}
            </li>
          ))}
        </ul>
      )}
      {onCorrect && (
        <button className="correct-note-btn" onClick={() => onCorrect(note)}>
          <Pencil size={12} />
          Correct this note
        </button>
      )}
      {readOnlyHint && <p className="hint inherited-hint">{readOnlyHint}</p>}
    </div>
  );
}

function NoteBlock({
  title,
  notes,
  footer,
  onCorrect,
  showKind,
}: {
  title: string;
  notes: LocationDetail["descriptionNotes"];
  footer?: string;
  onCorrect?: (note: Note) => void;
  // Approval preview/package call sites only (core/physical/inherited) - the Brief
  // tab's own standing Description/Constraint/Tone sections already say the kind in
  // their heading, so they leave this unset. See NoteItem's own showKind doc.
  showKind?: boolean;
}) {
  if (notes.length === 0) return null;
  return (
    <NoteGroup title={title}>
      {notes.map((n) => (
        <NoteItem key={n.id} note={n} onCorrect={onCorrect} showKind={showKind} />
      ))}
      {footer && <p className="hint note-block-footer">{footer}</p>}
    </NoteGroup>
  );
}

// Location brief tab only - the scene-scoped half of GET .../locations/{locationId},
// distinct from SceneRequirementsBlock below (which renders the Concept & approval
// preview/package's own sceneRequirements - plain notes, no per-note ownership, and
// never carries a correction control per API_CONTRACT.md). One row per linked scene,
// always present even when empty - "No additional requirements extracted" is a
// confirmed fact there, never an omission.
function BriefSceneRequirementsBlock({
  items,
  onCorrect,
}: {
  items: LocationSceneRequirement[];
  onCorrect: (note: ScopedNote) => void;
}) {
  if (items.length === 0) return null;
  return (
    <NoteGroup title="Scene-specific requirements">
      {items.map((s) => (
        <div className="scene-requirement" key={s.sceneId}>
          <h4>
            {s.number && <strong>{s.number}</strong>} {s.heading}
          </h4>
          {s.notes.length === 0 ? (
            <p className="hint">No additional requirements extracted.</p>
          ) : (
            s.notes.map((n) => (
              <NoteItem
                key={n.id}
                note={n}
                onCorrect={n.owned && n.editable ? () => onCorrect(n) : undefined}
                readOnlyHint={
                  !n.owned ? `Inherited from ${n.inheritedFrom ?? "an ancestor location"} - read-only here` : undefined
                }
                showKind
              />
            ))
          )}
        </div>
      ))}
    </NoteGroup>
  );
}

// outOfRosterSceneRequirements - scene-conditional notes whose sceneId is NOT one of
// this location's linked scenes. Only ever includes entries with a real note (the
// backend never sends an empty stub here), and is rendered distinctly so it's never
// mistaken for a confirmed scene link.
function OutOfRosterSceneRequirementsBlock({
  items,
  onCorrect,
}: {
  items: LocationSceneRequirement[];
  onCorrect: (note: ScopedNote) => void;
}) {
  if (items.length === 0) return null;
  return (
    <NoteGroup title="Not currently linked to this location">
      <p className="hint">
        These scene-conditional notes reference a scene outside this location&apos;s current
        linked-scene roster - shown for visibility, not as a confirmed scene link.
      </p>
      {items.map((s) => (
        <div className="scene-requirement scene-requirement-unlinked" key={s.sceneId}>
          {s.notes.map((n) => (
            <NoteItem
              key={n.id}
              note={n}
              onCorrect={n.owned && n.editable ? () => onCorrect(n) : undefined}
              readOnlyHint={
                !n.owned ? `Inherited from ${n.inheritedFrom ?? "an ancestor location"} - read-only here` : undefined
              }
              showKind
            />
          ))}
        </div>
      ))}
    </NoteGroup>
  );
}

// One row per scene in the location's linked-scene roster - always present regardless
// of whether that scene has any requirements (see API_CONTRACT.md: an empty notes
// list is a confirmed fact here, never an omission). `number`/`heading` both null is
// the defensive edge case of a scene-conditional note whose scene isn't part of the
// roster at all - kept visible, but never presented as a confirmed scene link.
function SceneRequirementsBlock({ items }: { items: SceneRequirement[] }) {
  if (items.length === 0) return null;
  const linked = items.filter((s) => s.number !== null || s.heading !== null);
  const unlinked = items.filter((s) => s.number === null && s.heading === null);
  return (
    <NoteGroup title="Scene-specific requirements">
      {linked.map((s) => (
        <div className="scene-requirement" key={s.sceneId}>
          <h4>
            {s.number && <strong>{s.number}</strong>} {s.heading}
          </h4>
          {s.notes.length === 0 ? (
            <p className="hint">No additional requirements extracted.</p>
          ) : (
            s.notes.map((n) => <NoteItem key={n.id} note={n} showKind />)
          )}
        </div>
      ))}
      {unlinked.length > 0 && (
        <div className="scene-requirement scene-requirement-unlinked">
          <h4>Not currently linked to this location</h4>
          <p className="hint">
            These scene-conditional notes reference a scene outside this location&apos;s current
            linked-scene roster - shown for visibility, not as a confirmed scene link.
          </p>
          {unlinked.map((s) => s.notes.map((n) => <NoteItem key={n.id} note={n} showKind />))}
        </div>
      )}
    </NoteGroup>
  );
}

function ReviewControls({
  r,
  draft,
  onDraftChange,
  saving,
  rejecting,
  rejectReason,
  onRejectReasonChange,
  onConfirm,
  onStartReject,
  onCancelReject,
  onConfirmReject,
}: {
  r: ReferenceNote;
  draft: string;
  onDraftChange: (v: string) => void;
  saving: boolean;
  rejecting: boolean;
  rejectReason: RejectReason;
  onRejectReasonChange: (v: RejectReason) => void;
  onConfirm: () => void;
  onStartReject: () => void;
  onCancelReject: () => void;
  onConfirmReject: () => void;
}) {
  if (!r.owned) {
    return (
      <p className="hint inherited-hint">Reviewed on {r.inheritedFrom} · read-only here</p>
    );
  }
  if (rejecting) {
    return (
      <div className="reject-row">
        <select
          aria-label="Reason for rejecting"
          value={rejectReason}
          onChange={(e) => onRejectReasonChange(e.target.value as RejectReason)}
        >
          {REJECT_REASONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button className="outline" onClick={onCancelReject} disabled={saving}>
          Cancel
        </button>
        <button className="primary" onClick={onConfirmReject} disabled={saving}>
          {saving ? <LoaderCircle className="spin" size={14} /> : "Confirm reject"}
        </button>
      </div>
    );
  }
  return (
    <>
      <label className="guidance-field">
        USE FOR
        <input
          aria-label={`Use ${r.title} for`}
          value={draft}
          placeholder="e.g. canopy shape, not the bridge"
          onChange={(e) => onDraftChange(e.target.value)}
        />
      </label>
      <div className="button-row review-row">
        <button className="primary" onClick={onConfirm} disabled={saving}>
          {saving ? (
            <LoaderCircle className="spin" size={14} />
          ) : (
            <Check size={14} />
          )}
          {r.status === "confirmed" ? "Save guidance" : "Confirm"}
        </button>
        <button className="outline" onClick={onStartReject} disabled={saving}>
          <X size={14} />
          Reject
        </button>
      </div>
    </>
  );
}

function ReferenceCard({
  r,
  index,
  draft,
  onDraftChange,
  saving,
  rejecting,
  rejectReason,
  onRejectReasonChange,
  onOpen,
  onConfirm,
  onStartReject,
  onCancelReject,
  onConfirmReject,
  promotingCandidate,
  onUseAsCandidate,
}: {
  r: ReferenceNote;
  index: number;
  draft: string;
  onDraftChange: (v: string) => void;
  saving: boolean;
  rejecting: boolean;
  rejectReason: RejectReason;
  onRejectReasonChange: (v: RejectReason) => void;
  onOpen: () => void;
  onConfirm: () => void;
  onStartReject: () => void;
  onCancelReject: () => void;
  onConfirmReject: () => void;
  promotingCandidate: boolean;
  onUseAsCandidate: () => void;
}) {
  return (
    <article
      className={`reference-card ${r.status === "confirmed" ? "is-selected" : ""} ${!r.owned ? "inherited" : ""}`}
    >
      <div className="image-wrap">
        <button className="image-button" onClick={onOpen} aria-label={`View ${r.title}`}>
          <img
            src={resolveImageUrl(r.image)}
            alt={r.title}
            onError={(e) => {
              e.currentTarget.style.opacity = "0";
              e.currentTarget.parentElement!.classList.add("image-missing");
            }}
          />
        </button>
        <span className="image-number">{String(index + 1).padStart(2, "0")}</span>
        <span className="category">{r.category}</span>
        {!r.owned && <span className="inherited-badge">From {r.inheritedFrom}</span>}
      </div>
      <div className="card-content">
        <button className="card-title" onClick={onOpen}>
          {r.title}
          <ArrowUpRight size={15} />
        </button>
        <p>{r.reason}</p>
        <ReviewControls
          r={r}
          draft={draft}
          onDraftChange={onDraftChange}
          saving={saving}
          rejecting={rejecting}
          rejectReason={rejectReason}
          onRejectReasonChange={onRejectReasonChange}
          onConfirm={onConfirm}
          onStartReject={onStartReject}
          onCancelReject={onCancelReject}
          onConfirmReject={onConfirmReject}
        />
        <button className="use-as-candidate" disabled={promotingCandidate} onClick={onUseAsCandidate}>
          {promotingCandidate ? <LoaderCircle className="spin" size={13} /> : <ImageIcon size={13} />}
          Use as concept candidate
        </button>
        <div className="card-meta">
          <span>{r.attribution || "Wikimedia Commons"}</span>
          <span>{r.status === "confirmed" ? "Confirmed" : r.status === "proposed" ? "Proposed" : r.status}</span>
        </div>
      </div>
    </article>
  );
}

function ReferenceDialog({
  r,
  draft,
  onDraftChange,
  saving,
  rejecting,
  rejectReason,
  onRejectReasonChange,
  onConfirm,
  onStartReject,
  onCancelReject,
  onConfirmReject,
  promotingCandidate,
  onUseAsCandidate,
}: {
  r: ReferenceNote;
  draft: string;
  onDraftChange: (v: string) => void;
  saving: boolean;
  rejecting: boolean;
  rejectReason: RejectReason;
  onRejectReasonChange: (v: RejectReason) => void;
  onConfirm: () => void;
  onStartReject: () => void;
  onCancelReject: () => void;
  onConfirmReject: () => void;
  promotingCandidate: boolean;
  onUseAsCandidate: () => void;
}) {
  return (
    <>
      <img className="detail-image" src={resolveImageUrl(r.image)} alt={r.title} />
      <span className="eyebrow">{r.category}</span>
      <h2>{r.title}</h2>
      <p>{r.reason}</p>
      {r.directionRationale && <p className="small">{r.directionRationale}</p>}
      <p className="small">
        {[r.credit, r.license].filter(Boolean).join(" · ") || "No attribution recorded"}
      </p>
      {!r.owned && <p className="hint inherited-hint">Reviewed on {r.inheritedFrom}</p>}
      <ReviewControls
        r={r}
        draft={draft}
        onDraftChange={onDraftChange}
        saving={saving}
        rejecting={rejecting}
        rejectReason={rejectReason}
        onRejectReasonChange={onRejectReasonChange}
        onConfirm={onConfirm}
        onStartReject={onStartReject}
        onCancelReject={onCancelReject}
        onConfirmReject={onConfirmReject}
      />
      <button
        className="use-as-candidate"
        disabled={promotingCandidate}
        onClick={onUseAsCandidate}
        style={{ marginTop: 14 }}
      >
        {promotingCandidate ? <LoaderCircle className="spin" size={13} /> : <ImageIcon size={13} />}
        Use as concept candidate
      </button>
      {r.source && /^https?:\/\//.test(r.source) && (
        <div className="button-row" style={{ marginTop: 16 }}>
          <a className="outline" href={r.source} target="_blank" rel="noreferrer">
            Original source
            <ArrowUpRight size={15} />
          </a>
        </div>
      )}
    </>
  );
}

// --- Brief note correction (Correct this note / Split into two requirements) -----------
// Location brief tab only - see NoteItem's onCorrect prop. Never rendered from an
// approval preview or an already-locked approved package.

// Human-readable scope for the note currently being corrected, shown for comparison
// against whatever the user is drafting. outOfRosterLabel (only ever non-null for a
// note whose own scope is out-of-roster) is passed through rather than recomputed, so
// this always agrees with what openCorrection/CorrectionEditor already decided.
function describeNoteScope(
  note: Note,
  scenes: LocationDetail["scenes"],
  outOfRosterLabel: string | null,
): string {
  if (note.sceneId === null) return "Standing (whole location)";
  const linked = scenes.find((s) => s.id === note.sceneId);
  if (linked) return linked.number ? `${linked.number} · ${linked.name}` : linked.name;
  return `${outOfRosterLabel ?? note.sceneId} - not currently linked to this location`;
}

function CorrectionEditor({
  original,
  scenes,
  draft,
  busy,
  error,
  unknown,
  onSuccessorChange,
  onToggleSplit,
  onSave,
  onClose,
}: {
  original: Note;
  scenes: LocationDetail["scenes"];
  draft: CorrectionDraft;
  busy: boolean;
  error: string | null;
  unknown: boolean;
  onSuccessorChange: (index: number, patch: Partial<CorrectionSuccessorDraft>) => void;
  onToggleSplit: () => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const scopeResolved = !draft.outOfRosterLabel || draft.scopeChosen;
  const canSave = !busy && !unknown && scopeResolved && draft.successors.every((s) => s.body.trim().length > 0);
  return (
    <>
      <span className="eyebrow">{draft.split ? "SPLIT INTO TWO REQUIREMENTS" : "CORRECT THIS NOTE"}</span>
      <h2>{draft.split ? "Split into two requirements" : "Correct this note"}</h2>
      <p className="small">
        Saving replaces the original below in the current brief and creates{" "}
        {draft.split ? "two proposed corrections" : "a proposed correction"} - it does not approve
        them. Confirm or reject each one separately, same as any other note.
      </p>

      <div className="correction-original">
        <span className="eyebrow">ORIGINAL</span>
        <NoteItem note={original} />
        <p className="hint correction-original-scope">
          Currently applies to: {describeNoteScope(original, scenes, draft.outOfRosterLabel)}
        </p>
      </div>

      {draft.outOfRosterLabel && !draft.scopeChosen && (
        <div className="brief-banner warning-banner">
          <div>
            <AlertTriangle size={17} />
            <span>
              This note is currently scoped to {draft.outOfRosterLabel}, which is not linked to
              this location. Choose Standing or one of this location&apos;s linked scenes below
              before saving - nothing here picks one for you.
            </span>
          </div>
        </div>
      )}

      {draft.successors.map((s, i) => (
        <CorrectionSuccessorFields
          key={i}
          label={draft.split ? (i === 0 ? "First requirement" : "Second requirement") : "Corrected text"}
          successor={s}
          scenes={scenes}
          outOfRosterLabel={i === 0 ? draft.outOfRosterLabel : null}
          disabled={busy || unknown}
          onChange={(patch) => onSuccessorChange(i, patch)}
        />
      ))}
      <p className="hint">
        Citations copy verbatim from the original above - there&apos;s no field to edit them here.
      </p>

      <button className="text-action" onClick={onToggleSplit} disabled={busy || unknown} style={{ margin: "4px 0 18px" }}>
        {draft.split ? "Merge back into one correction" : "Split into two requirements"}
      </button>

      {error && <div className="error-banner">{error}</div>}

      <div className="button-row" style={{ marginTop: 18 }}>
        <button className="outline" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="primary" onClick={onSave} disabled={!canSave}>
          {busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
          Save correction
        </button>
      </div>
    </>
  );
}

function CorrectionSuccessorFields({
  label,
  successor,
  scenes,
  outOfRosterLabel,
  disabled,
  onChange,
}: {
  label: string;
  successor: CorrectionSuccessorDraft;
  scenes: LocationDetail["scenes"];
  // Set only for the successor carrying the original note's scope, and only while
  // that scope is still an unresolved out-of-roster one - see openCorrection.
  outOfRosterLabel?: string | null;
  disabled: boolean;
  onChange: (patch: Partial<CorrectionSuccessorDraft>) => void;
}) {
  // Never true once the user has picked anything from this select - every real
  // option is either null (standing) or a scene actually in `scenes`, so a fresh
  // choice always clears this on its own; nothing needs to reset it explicitly.
  const isUnresolvedOutOfRoster =
    !!outOfRosterLabel && successor.sceneId !== null && !scenes.some((sc) => sc.id === successor.sceneId);
  return (
    <div className="correction-successor">
      <span className="eyebrow">{label.toUpperCase()}</span>
      <label className="guidance-field">
        TEXT
        <textarea
          value={successor.body}
          onChange={(e) => onChange({ body: e.target.value })}
          disabled={disabled}
          rows={3}
          maxLength={2000}
        />
      </label>
      <div className="correction-row">
        <label className="guidance-field">
          KIND
          <select
            value={successor.kind}
            onChange={(e) => onChange({ kind: e.target.value })}
            disabled={disabled}
          >
            <option value="description">Description</option>
            <option value="constraint">Constraint</option>
            <option value="tone">Tone</option>
          </select>
        </label>
        <label className="guidance-field">
          APPLIES TO
          <select
            value={isUnresolvedOutOfRoster ? "__unresolved__" : (successor.sceneId ?? "")}
            onChange={(e) => onChange({ sceneId: e.target.value || null })}
            disabled={disabled}
            className={isUnresolvedOutOfRoster ? "needs-choice" : undefined}
          >
            {isUnresolvedOutOfRoster && (
              <option value="__unresolved__" disabled>
                {outOfRosterLabel} - not currently linked to this location
              </option>
            )}
            <option value="">Standing (whole location)</option>
            {scenes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.number ? `${s.number} · ${s.name}` : s.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={successor.includeDescendants}
          onChange={(e) => onChange({ includeDescendants: e.target.checked })}
          disabled={disabled}
        />
        Also applies to child locations
      </label>
    </div>
  );
}

// --- Sources panel (project creation -> upload -> ingest -> locations) --------------------

function UploadRowView({ row }: { row: UploadRow }) {
  return (
    <div className={`upload-row upload-row-${row.state}`}>
      <span className="upload-row-icon">
        {row.state === "uploading" && <LoaderCircle className="spin" size={16} />}
        {row.state === "queued" && <Circle size={14} />}
        {row.state === "done" &&
          (row.result?.status === "unsupported" ? (
            <FileWarning size={16} />
          ) : (
            <CheckCircle2 size={16} />
          ))}
        {row.state === "error" && <XCircle size={16} />}
      </span>
      <span className="upload-row-name">{row.filename}</span>
      <span className="upload-row-status">
        {row.state === "queued" && "Waiting…"}
        {row.state === "uploading" &&
          (row.progressPct != null ? `Uploading… ${row.progressPct}%` : "Uploading…")}
        {row.state === "done" && row.result && describeUpload(row.result)}
        {row.state === "error" && (row.errorMessage || "Upload failed")}
      </span>
      {row.state === "uploading" && row.progressPct != null && (
        <span className="progress-bar" aria-hidden>
          <span className="progress-fill" style={{ width: `${row.progressPct}%` }} />
        </span>
      )}
    </div>
  );
}

const OUTCOME_META: Record<
  IngestOutcome,
  { label: string; tone: "success" | "warning" | "error" | "neutral" }
> = {
  complete: { label: "All sources processed", tone: "success" },
  partial: { label: "Some sources failed", tone: "warning" },
  failed: { label: "Ingestion failed", tone: "error" },
  no_op: { label: "Nothing to process", tone: "neutral" },
};

function SourceResultRow({ s }: { s: IngestSourceResult }) {
  return (
    <div className={`source-result-row source-result-${s.status}`}>
      <span className="upload-row-icon">
        {s.status === "digested" && <CheckCircle2 size={16} />}
        {s.status === "skipped" && <Check size={16} />}
        {s.status === "failed" && <XCircle size={16} />}
        {s.status === "unsupported" && <FileWarning size={16} />}
      </span>
      <span className="upload-row-name">{s.filename}</span>
      <span className="upload-row-status">
        {s.status === "digested" && `Digested · ${s.notesWritten} note(s), ${s.entitiesCreated} location(s)`}
        {s.status === "skipped" && "Already up to date"}
        {s.status === "unsupported" && "Unsupported file type"}
        {s.status === "failed" && (s.error || "Failed")}
      </span>
    </div>
  );
}

// Authoritative GET /projects/{id}/sources row. Deliberately shows only filename,
// status and the source's own error - no docType or timestamp exists on this shape
// (see API_CONTRACT.md), so none is invented here.
function SourceListRow({ s }: { s: SourceSummary }) {
  return (
    <div className={`source-list-row source-list-${s.status}`}>
      <span className="upload-row-icon">
        {s.status === "uploaded" && <Circle size={14} />}
        {s.status === "digesting" && <LoaderCircle className="spin" size={16} />}
        {s.status === "digested" && <CheckCircle2 size={16} />}
        {s.status === "failed" && <XCircle size={16} />}
        {s.status === "unsupported" && <FileWarning size={16} />}
      </span>
      <span className="upload-row-name">{s.filename}</span>
      <span className="upload-row-status">
        {s.status === "uploaded" && "Uploaded, not yet processed"}
        {s.status === "digesting" && "Processing…"}
        {s.status === "digested" && "Processed"}
        {s.status === "unsupported" && (s.error || "Unsupported file type")}
        {s.status === "failed" && (s.error || "Failed")}
      </span>
    </div>
  );
}

function SourcesPanel({
  projectName,
  sources,
  sourcesLoading,
  sourcesError,
  onRetrySources,
  uploadRows,
  foreignBatchCount,
  onPickFiles,
  ingestBusy,
  ingestPaused,
  ingestResult,
  onStartIngest,
  onResumeChecking,
  locationsCount,
  onContinueToLocations,
}: {
  projectName: string | null;
  sources: SourceSummary[];
  sourcesLoading: boolean;
  sourcesError: string | null;
  onRetrySources: () => void;
  uploadRows: UploadRow[];
  foreignBatchCount: number;
  onPickFiles: () => void;
  ingestBusy: boolean;
  ingestPaused: string | null;
  ingestResult: JobStatusResult | null;
  onStartIngest: () => void;
  onResumeChecking: () => void;
  locationsCount: number;
  onContinueToLocations: () => void;
}) {
  const outcome = ingestResult?.outcome ?? null;
  const meta = outcome ? OUTCOME_META[outcome] : null;
  const anyUploadInFlight = uploadRows.some((r) => r.state === "queued" || r.state === "uploading");

  return (
    <section className="sources-view">
      <div className="section-title">
        <div>
          <h2>Upload and process sources</h2>
          <p>
            {projectName ? `For ${projectName}. ` : ""}
            Upload a screenplay or notes file, then process them to extract locations.
          </p>
        </div>
        <div className="button-row">
          <button className="outline" onClick={onPickFiles}>
            <Upload size={15} />
            Upload files
          </button>
        </div>
      </div>

      {foreignBatchCount > 0 && (
        <p className="hint">
          {foreignBatchCount} file(s) are still uploading to the project you switched from - they
          won&apos;t be redirected here.
        </p>
      )}

      {uploadRows.length > 0 && (
        <div className="upload-list">
          {uploadRows.map((r) => (
            <UploadRowView key={r.id} row={r} />
          ))}
        </div>
      )}

      <NoteGroup title="Uploaded sources">
        {sourcesLoading && <p className="hint">Loading sources…</p>}
        {!sourcesLoading && sourcesError && (
          <div className="error-banner">
            {sourcesError}{" "}
            <button className="retry-link" onClick={onRetrySources}>
              Retry
            </button>
          </div>
        )}
        {!sourcesLoading && !sourcesError && sources.length === 0 && (
          <p className="hint">No sources uploaded yet.</p>
        )}
        {!sourcesLoading && !sourcesError && sources.length > 0 && (
          <div className="upload-list">
            {sources.map((s) => (
              <SourceListRow key={s.id} s={s} />
            ))}
          </div>
        )}
      </NoteGroup>

      <div className="ingest-action">
        <button className="primary" onClick={onStartIngest} disabled={ingestBusy || anyUploadInFlight}>
          {ingestBusy ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
          Process sources
        </button>
        <p className="hint">Processes every source listed above that&apos;s eligible.</p>
      </div>

      {ingestBusy && !ingestPaused && (
        <div className="brief-banner">
          <div>
            <LoaderCircle className="spin" size={17} />
            <span>Processing sources… this can take a few minutes and keeps running even if you leave this page.</span>
          </div>
        </div>
      )}

      {ingestPaused && (
        <div className="brief-banner warning-banner">
          <div>
            <PauseCircle size={17} />
            <span>{ingestPaused}</span>
          </div>
          <button onClick={onResumeChecking}>Resume checking</button>
        </div>
      )}

      {meta && ingestResult && (
        <div className={`outcome-banner outcome-${meta.tone}`}>
          <div className="outcome-banner-head">
            {meta.tone === "success" && <CheckCircle2 size={18} />}
            {meta.tone === "warning" && <AlertTriangle size={18} />}
            {meta.tone === "error" && <XCircle size={18} />}
            {meta.tone === "neutral" && <FileText size={18} />}
            <strong>{meta.label}</strong>
          </div>
          {ingestResult.error && <p>{ingestResult.error}</p>}
          {outcome === "no_op" && (
            <p>Nothing was eligible to process yet - upload a source above first.</p>
          )}
          {(outcome === "complete" || outcome === "partial") && locationsCount === 0 && (
            <p>Ingestion finished, but no locations were extracted from these sources yet.</p>
          )}
          {ingestResult.sources && ingestResult.sources.length > 0 && (
            <div className="upload-list">
              {ingestResult.sources.map((s) => (
                <SourceResultRow key={s.sourceId} s={s} />
              ))}
            </div>
          )}
          {(outcome === "complete" || outcome === "partial") && (
            <button className="primary" onClick={onContinueToLocations}>
              Continue to locations
              <ArrowRight size={15} />
            </button>
          )}
        </div>
      )}
    </section>
  );
}

// --- Concept art + visual-direction approval -----------------------------------------

function ConceptUploadRowView({ row }: { row: ConceptUploadRow }) {
  return (
    <div className={`upload-row upload-row-${row.state === "already_uploaded" ? "done" : row.state}`}>
      <span className="upload-row-icon">
        {row.state === "queued" && <Circle size={14} />}
        {row.state === "uploading" && <LoaderCircle className="spin" size={16} />}
        {row.state === "done" && <CheckCircle2 size={16} />}
        {row.state === "already_uploaded" && <Info size={16} />}
        {row.state === "error" && <XCircle size={16} />}
      </span>
      <span className="upload-row-name">{row.filename}</span>
      <span className="upload-row-status">
        {row.state === "queued" && "Waiting…"}
        {row.state === "uploading" &&
          (row.progressPct != null ? `Uploading… ${row.progressPct}%` : "Uploading…")}
        {row.state === "done" && "Uploaded"}
        {row.state === "already_uploaded" && "Already uploaded for this location"}
        {row.state === "error" && (row.errorMessage || "Upload failed")}
      </span>
      {row.state === "uploading" && row.progressPct != null && (
        <span className="progress-bar" aria-hidden>
          <span className="progress-fill" style={{ width: `${row.progressPct}%` }} />
        </span>
      )}
    </div>
  );
}

function ConceptVersionCard({
  v,
  selected,
  onSelect,
}: {
  v: ConceptVersion;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <article className={`concept-card ${selected ? "is-selected" : ""}`}>
      <button onClick={onSelect} aria-label={`Select ${v.filename} as candidate`}>
        <img src={resolveImageUrl(v.image)} alt={v.filename} />
      </button>
      <div>
        <span>
          <small>
            {v.approved ? "APPROVED VERSION" : "CANDIDATE"}
            {v.promotedFromNoteId && " · FROM REFERENCE"}
          </small>
          <strong>{v.filename}</strong>
        </span>
        <button className={selected ? "outline" : "primary"} onClick={onSelect}>
          {selected ? (
            <>
              <Check size={15} />
              Selected
            </>
          ) : (
            "Select"
          )}
        </button>
      </div>
    </article>
  );
}

// Shared by the read-only preview and the authoritative approved package - both are
// the same ApprovalContent shape (see API_CONTRACT.md), so they render identically.
// `sceneCoverageComplete` is only meaningful for an already-locked package (a preview
// is always complete/current - omit it, or leave it undefined, there).
function ApprovalContentView({
  content,
  sceneCoverageComplete,
}: {
  content: ApprovalContent;
  sceneCoverageComplete?: boolean;
}) {
  const hasAnything =
    content.coreNotes.length > 0 ||
    content.physicalNotes.length > 0 ||
    content.sceneRequirements.length > 0 ||
    content.briefInherited.length > 0 ||
    content.references.length > 0;
  const scenesAvailable = sceneCoverageComplete !== false;
  return (
    <div className="approval-content">
      <img className="detail-image" src={resolveImageUrl(content.conceptImage)} alt={content.conceptFilename} />
      {content.depictionLabel && (
        <p className="depiction-label">
          <span className="eyebrow">DEPICTS</span> {content.depictionLabel}
        </p>
      )}
      <NoteBlock
        title="Core description"
        notes={content.coreNotes}
        footer={content.coreNotes.length > 0 ? content.coreNotesCaveat : undefined}
        showKind
      />
      <NoteBlock title="Physical & set-dressing requirements" notes={content.physicalNotes} showKind />
      {scenesAvailable ? (
        <SceneRequirementsBlock items={content.sceneRequirements} />
      ) : (
        <div className="scene-coverage-unavailable">
          <AlertTriangle size={15} />
          <span>
            Scene coverage unavailable in this older approval. The scenes shown when this was
            locked may be incomplete - preview and lock again for full, current scene coverage.
          </span>
        </div>
      )}
      {content.briefInherited.map((i) => (
        <NoteBlock key={i.entityId} title={`Inherited from ${i.name}`} notes={i.notes} showKind />
      ))}
      {content.supersededSources.length > 0 && (
        <p className="hint">
          {content.supersededSources.length} source(s) superseded by a newer version.
        </p>
      )}
      {content.references.length > 0 && (
        <NoteGroup title="Selected references">
          <div className="approval-ref-list">
            {content.references.map((r) => (
              <div key={r.noteId} className="approval-ref-row">
                <img src={resolveImageUrl(r.image)} alt={r.caption} />
                <div>
                  <strong>{r.direction || r.caption}</strong>
                  {r.guidance && <p className="hint">Use for: {r.guidance}</p>}
                </div>
              </div>
            ))}
          </div>
        </NoteGroup>
      )}
      {!hasAnything && <p className="hint">No brief context or references included in this package.</p>}
    </div>
  );
}
