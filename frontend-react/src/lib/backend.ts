import type {
  BackendHealth,
  DownloadStatus,
  DownloadHistoryResponse,
  ComboResponse,
  LibrarySummary,
  PreferencesResponse,
} from "../types/api";
import { ApiError } from "../types/api";

type JsonObject = Record<string, unknown>;

/**
 * The React gallery is served from the authenticated Go Sidecar origin.
 * Session credentials stay in the HttpOnly cookie installed by the Rust
 * WebView host; JavaScript never reads or stores the session token.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    cache: "no-store",
  });

  const contentType = response.headers.get("content-type") ?? "";
  const body: JsonObject | undefined = contentType.includes("application/json")
    ? await response.json() as JsonObject
    : undefined;

  if (!response.ok) {
    const code = typeof body?.code === "string" ? body.code : undefined;
    const message = typeof body?.error === "string"
      ? body.error
      : `Request failed (${response.status})`;
    throw new ApiError(message, response.status, code);
  }

  return body as T;
}

function query(values: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function post<T>(path: string, body: JsonObject): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export function getDownloadHistory(limit = 50, expectedRoot?: string, signal?: AbortSignal, cursor?: string): Promise<DownloadHistoryResponse> {
  const bounded = Math.max(1, Math.min(200, Math.floor(limit)));
  return request<DownloadHistoryResponse>("/api/download/history" + query({ limit: bounded, expectedRoot, cursor }), { signal });
}

export function getDownloadStatus(): Promise<DownloadStatus> {
  return request<DownloadStatus>("/api/download/status");
}

export function getBackendHealth(): Promise<BackendHealth> {
  return request<BackendHealth>("/api/health");
}

export function getLibrarySummary(refresh = false): Promise<LibrarySummary> {
  return request<LibrarySummary>(`/api/library${query({ refresh: refresh ? 1 : undefined })}`);
}

export function getCombo(section: string, folder = ""): Promise<ComboResponse> {
  return request<ComboResponse>(`/api/combo${query({ section, folder })}`);
}

export function getFlatLibrary(): Promise<{ ok: boolean; root: string; items: ComboResponse["items"] }> {
  return request("/api/flat");
}

export function getMetadata(): Promise<{ ok: boolean; root: string; meta: { revision: number } }> {
  return request("/api/meta");
}



export function getViews(): Promise<{ ok: boolean; root?: string; views: Record<string, { density: string; sort: string; tile: number; cats: string[] }> }> {
  return request("/api/views");
}

export function getPreferences(): Promise<PreferencesResponse> {
  return request<PreferencesResponse>("/api/preferences");
}

export function getTrash(): Promise<{ ok: boolean; items: Array<Record<string, unknown>> }> {
  return request<{ ok: boolean; items: Array<Record<string, unknown>> }>("/api/trash");
}

export function setLibraryRoot(root: string): Promise<LibrarySummary> {
  return post<LibrarySummary>("/api/root", { root });
}

export function browseDirectories(path = ""): Promise<JsonObject> {
  return request<JsonObject>(`/api/browse${query({ path })}`);
}

export function createLibrary(root: string): Promise<LibrarySummary> {
  return post<LibrarySummary>("/api/library/create", { root });
}

export function updateMetadata(payload: JsonObject): Promise<JsonObject> {
  return post<JsonObject>("/api/meta", payload);
}

export function savePreferences(payload: JsonObject): Promise<JsonObject> {
  return post<JsonObject>("/api/preferences", payload);
}

export function saveViews(views: Record<string, unknown>, expectedRoot: string): Promise<JsonObject> {
  return post<JsonObject>("/api/views", { views, expectedRoot });
}

export function addToTrash(payload: JsonObject): Promise<JsonObject> {
  return post<JsonObject>("/api/trash", payload);
}

export function restoreFromTrash(payload: JsonObject): Promise<JsonObject> {
  return post<JsonObject>("/api/trash/restore", payload);
}

export function purgeTrash(payload: JsonObject): Promise<JsonObject> {
  return post<JsonObject>("/api/trash/purge", payload);
}

export function saveCopy(payload: JsonObject): Promise<JsonObject> {
  return post<JsonObject>("/api/save-copy", payload);
}

export function revealPath(payload: JsonObject): Promise<JsonObject> {
  return post<JsonObject>("/api/reveal", payload);
}

export function prepareCover(payload: JsonObject): Promise<JsonObject> {
  return post<JsonObject>("/api/cover/prepare", payload);
}

export function getMediaUrl(item: Pick<ComboResponse["items"][number], "url">): string {
  return item.url;
}
