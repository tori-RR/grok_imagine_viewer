export interface DownloadPersistence {
  resultVersion: 1;
  historyState: "persisted" | "pending" | "unavailable" | "not_applicable";
  warnings: Array<"history_persistence_pending">;
}

export function decodeDownloadResult<T>(value: T): T & DownloadPersistence {
  const result = value as Record<string, unknown>;
  if (!result || result.resultVersion !== 1 ||
      !["persisted", "pending", "unavailable", "not_applicable"].includes(String(result.historyState)) ||
      !Array.isArray(result.warnings) || result.warnings.some(code => code !== "history_persistence_pending") ||
      ["ok", "stopped", "published"].some(key => typeof result[key] !== "boolean") ||
      !result.counts || ["total", "attempted", "succeeded", "failed", "skipped"].some(key => {
        const n = (result.counts as Record<string, unknown>)[key]; return !Number.isSafeInteger(n) || Number(n) < 0;
      })) {
    throw new Error("下载结果协议无效。");
  }
  return value as T & DownloadPersistence;
}
