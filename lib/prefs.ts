// Browser-storage helpers for the connected workspace. Per API_CONTRACT.md this is
// UI preference / draft / pending-job storage ONLY - never a cache of backend-owned
// data, and never a source uploaded back to the harness.
const DRAFT_PREFIX = "location-studio:draft:";
const JOB_PREFIX = "location-studio:job:";
const INGEST_JOB_PREFIX = "location-studio:ingestjob:";
const SELECTION_KEY = "location-studio:selection";

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable (private mode, quota) - drafts just won't persist
  }
}
function safeRemove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export function getGuidanceDraft(noteId: string): string | null {
  return safeGet(DRAFT_PREFIX + noteId);
}
export function setGuidanceDraft(noteId: string, value: string) {
  safeSet(DRAFT_PREFIX + noteId, value);
}
export function clearGuidanceDraft(noteId: string) {
  safeRemove(DRAFT_PREFIX + noteId);
}

export type PendingJob = { jobId: string; startedAt: number };

function jobKey(projectId: string, locationId: string) {
  return `${JOB_PREFIX}${projectId}:${locationId}`;
}
export function getPendingJob(projectId: string, locationId: string): PendingJob | null {
  const raw = safeGet(jobKey(projectId, locationId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingJob;
  } catch {
    return null;
  }
}
export function setPendingJob(projectId: string, locationId: string, job: PendingJob) {
  safeSet(jobKey(projectId, locationId), JSON.stringify(job));
}
export function clearPendingJob(projectId: string, locationId: string) {
  safeRemove(jobKey(projectId, locationId));
}

// Ingest jobs are project-scoped (not location-scoped like reference jobs above), and
// kept under their own key prefix so the two pending-job kinds can never collide or be
// resumed against the wrong endpoint.
export type PendingIngestJob = { jobId: string; startedAt: number };

function ingestJobKey(projectId: string) {
  return `${INGEST_JOB_PREFIX}${projectId}`;
}
export function getPendingIngestJob(projectId: string): PendingIngestJob | null {
  const raw = safeGet(ingestJobKey(projectId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingIngestJob;
  } catch {
    return null;
  }
}
export function setPendingIngestJob(projectId: string, job: PendingIngestJob) {
  safeSet(ingestJobKey(projectId), JSON.stringify(job));
}
export function clearPendingIngestJob(projectId: string) {
  safeRemove(ingestJobKey(projectId));
}

export type Selection = { projectId: string; locationId: string | null };
export function getLastSelection(): Selection | null {
  const raw = safeGet(SELECTION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Selection;
  } catch {
    return null;
  }
}
export function setLastSelection(sel: Selection) {
  safeSet(SELECTION_KEY, JSON.stringify(sel));
}
