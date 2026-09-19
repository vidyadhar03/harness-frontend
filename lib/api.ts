// Optional Python service. See API_CONTRACT.md for the exact boundary.
export const apiBase = (process.env.NEXT_PUBLIC_HARNESS_API_URL ?? "").replace(
  /\/$/,
  "",
);

export class HarnessApiError extends Error {
  status?: number;
  kind: "network" | "http";
  constructor(message: string, opts: { status?: number; kind: "network" | "http" }) {
    super(message);
    this.name = "HarnessApiError";
    this.status = opts.status;
    this.kind = opts.kind;
  }
}

type RequestOptions = { signal?: AbortSignal };

function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

async function send<T>(
  path: string,
  init: RequestInit,
  opts: RequestOptions = {},
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(30000);
  const signal = opts.signal ? anySignal([opts.signal, timeoutSignal]) : timeoutSignal;
  let r: Response;
  try {
    r = await fetch(`${apiBase}${path}`, { ...init, signal });
  } catch (e) {
    // Caller cancelled (e.g. switching location/project): propagate the raw
    // AbortError untouched so callers can silently ignore it.
    if (opts.signal?.aborted) throw e;
    if (e instanceof DOMException && e.name === "TimeoutError") {
      throw new HarnessApiError("The harness request timed out.", { kind: "network" });
    }
    throw new HarnessApiError(
      "Can't reach the harness API. Check that it's running.",
      { kind: "network" },
    );
  }
  if (!r.ok) {
    let detail = "";
    try {
      const body = await r.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      // no JSON body; fall through to the generic message
    }
    throw new HarnessApiError(detail || `Harness request failed (${r.status}).`, {
      status: r.status,
      kind: "http",
    });
  }
  return r.json();
}

type QueryValue = string | number | boolean | undefined | string[];

function toQueryString(params: Record<string, QueryValue>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    // Repeated key for an array (e.g. ?referenceIds=a&referenceIds=b) - matches
    // FastAPI's list[str] query param convention used by the approval preview route.
    const values = Array.isArray(v) ? v : [v];
    for (const value of values) {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

export function apiGet<T>(
  path: string,
  params?: Record<string, QueryValue>,
  opts?: RequestOptions,
): Promise<T> {
  const qs = params ? toQueryString(params) : "";
  return send<T>(`${path}${qs}`, { method: "GET" }, opts);
}

export function apiPost<T>(
  path: string,
  body: unknown,
  opts?: RequestOptions,
): Promise<T> {
  return send<T>(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    opts,
  );
}

export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

/**
 * Raw-body upload (POST /projects/{id}/sources - see API_CONTRACT.md: the body IS the
 * file's own bytes, no multipart envelope). Uses XMLHttpRequest instead of fetch solely
 * because it's the only web API that exposes real upload-progress events
 * (`upload.onprogress`) - fetch's ReadableStream request bodies don't report progress in
 * any browser today. `onProgress` is only ever called with a number when the browser
 * reports `lengthComputable`; otherwise it's called with `null` so callers never fabricate
 * a percentage from nothing.
 */
export function uploadRaw<T>(
  path: string,
  file: Blob,
  opts: { onProgress?: (pct: number | null) => void; signal?: AbortSignal } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${apiBase}${path}`, true);
    xhr.responseType = "json";
    xhr.timeout = 120000; // uploads can legitimately be larger/slower than a 30s JSON call
    xhr.upload.onprogress = (e) => {
      opts.onProgress?.(e.lengthComputable ? Math.round((e.loaded / e.total) * 100) : null);
    };
    xhr.onerror = () =>
      reject(
        new HarnessApiError("Can't reach the harness API. Check that it's running.", {
          kind: "network",
        }),
      );
    xhr.ontimeout = () =>
      reject(new HarnessApiError("The upload timed out.", { kind: "network" }));
    xhr.onabort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    xhr.onload = () => {
      let body: unknown = xhr.response;
      if (body == null && xhr.responseText) {
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          body = null;
        }
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as T);
        return;
      }
      const detail =
        body && typeof (body as Record<string, unknown>).detail === "string"
          ? ((body as Record<string, unknown>).detail as string)
          : "";
      reject(
        new HarnessApiError(detail || `Harness request failed (${xhr.status}).`, {
          status: xhr.status,
          kind: "http",
        }),
      );
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      opts.signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(file);
  });
}

// Used only by the local/disconnected sample workspace, which never actually
// reaches the network (see app/page.tsx) - kept so that code path still type-checks.
export async function request<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${apiBase}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok)
    throw new Error(`Harness request failed (${r.status}). Please try again.`);
  return r.json();
}
