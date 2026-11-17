export type LibraryMode = "empty" | "index" | "combos" | "single" | "loose";

export interface LibraryGroup {
  section: string;
  folder: string;
  name?: string;
  title?: string;
  count?: number;
  images?: number;
  videos?: number;
  [key: string]: unknown;
}

export interface GalleryItem {
  id: string;
  file: string;
  media?: string;
  url: string;
  created?: string;
  duration?: number;
  fav?: boolean;
  dislike?: boolean;
  tags?: string[];
  section?: string;
  folder?: string;
  [key: string]: unknown;
}

export interface LibrarySummary {
  ok: boolean;
  root: string;
  mode?: LibraryMode;
  combos?: LibraryGroup[];
  other?: LibraryGroup[];
  tags?: string[];
  hasTrash?: boolean;
  live?: boolean;
  generation?: number;
  [key: string]: unknown;
}

export interface ComboResponse {
  ok: boolean;
  root: string;
  section: string;
  folder: string;
  items: GalleryItem[];
  card?: LibraryGroup;
  lastViewedId?: string;
  metaError?: string;
}

export interface BackendHealth {
  app: string;
  backend: "go";
  protocolVersion: number;
  instanceId: string;
  pid: number;
  port: number;
}

export interface PreferencesResponse {
  ok: boolean;
  preferences: Record<string, unknown>;
  systemLanguage: string;
}

export interface DownloadStatus {
  ok: boolean;
  active: boolean;
  runId?: number;
  phase?: string;
  statusLine?: string;
  counts?: {
    total?: number;
    attempted?: number;
    succeeded?: number;
    failed?: number;
    skipped?: number;
  };
}

export interface DownloadProgress {
  runId: number;
  phase: string;
  total: number;
  attempted: number;
  succeeded: number;
  failed: number;
  statusLine?: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "ApiError";
  }
}


export interface DownloadHistoryItem {
  id: string;
  runId: number;
  startedAt: string;
  finishedAt?: string;
  retryOf?: string;
  phase: "running" | "interrupted" | "succeeded" | "partial" | "failed" | "cancelled" | string;
  code?: string;
  published: boolean;
  counts: NonNullable<DownloadStatus["counts"]>;
  failures: Array<{
    assetId: string;
    stage: string;
    code: string;
    message: string;
    attempt: number;
    retryable: boolean;
  }>;
}

export interface DownloadHistoryResponse {
  ok: boolean;
  root: string;
  schemaVersion: number;
  items: DownloadHistoryItem[];
  nextCursor: string;
}

export interface DownloadRetryRequest {
  historyId: string;
  expectedRoot: string;
  failedAssetIds: string[];
}

export interface DownloadRetryResponse {
  ok: boolean;
  runId: number;
  acceptedAssetIds: string[];
}
