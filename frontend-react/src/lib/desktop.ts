import { invoke, isTauri } from "@tauri-apps/api/core";
import { decodeDownloadResult } from "./download-result";
import type { DownloadPersistence } from "./download-result";

export function isDesktopRuntime(): boolean {
  return isTauri();
}

/**
 * Keep desktop commands behind one typed adapter. Do not expose arbitrary
 * command execution or filesystem paths to remote Grok WebViews.
 */
export async function invokeDesktop<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isDesktopRuntime()) {
    throw new Error("This operation is only available in the desktop application.");
  }
  return invoke<T>(command, args);
}

export interface DesktopDownloadResult extends DownloadPersistence {
  ok: boolean;
  stopped: boolean;
  notLoggedIn: boolean;
  mismatch: boolean;
  published: boolean;
  partial: boolean;
  failures?: Array<{ assetId: string; stage: string; code: string; message: string; attempt: number; retryable: boolean; elapsedMs: number; httpStatus?: number; expectedBytes?: number; receivedBytes?: number }>;
  counts: {
    total?: number;
    attempted?: number;
    succeeded?: number;
    failed?: number;
    skipped?: number;
    [key: string]: unknown;
  };
  error?: string;
  code?: string;
}

export interface DesktopDownloadRetry {
  historyId: string;
  failedAssetIds: string[];
}

export function startDesktopDownload(root: string, retry?: DesktopDownloadRetry): Promise<DesktopDownloadResult> {
  const args: Record<string, unknown> = { root };
  if (retry) {
    args.retryOf = retry.historyId;
    args.retryAssetIds = retry.failedAssetIds;
  }
  return invokeDesktop<DesktopDownloadResult>("start_download", { args }).then(decodeDownloadResult);
}

export function stopDesktopDownload(): Promise<{ ok: boolean; stopped: boolean; published: boolean } & Pick<DownloadPersistence, "historyState" | "warnings">> {
  return invokeDesktop<{ ok: boolean; stopped: boolean; published: boolean } & Pick<DownloadPersistence, "historyState" | "warnings">>("stop_download");
}

export function pickDesktopLibrary(): Promise<string | null> {
  return invokeDesktop<string | null>("pick_library");
}

export function createDesktopLibrary(): Promise<string | null> {
  return invokeDesktop<string | null>("create_library");
}
