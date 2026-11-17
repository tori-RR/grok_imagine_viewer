import { useEffect, useRef, useState } from "react";
import { getDownloadHistory } from "../lib/backend";
import type { DownloadHistoryItem } from "../types/api";

const t = (key: string, values?: Record<string, unknown>) => window.GivI18n?.t(key, values) ?? key;
const message = (cause: unknown) => window.GivI18n?.message(cause instanceof Error ? cause.message : String(cause)) ?? String(cause);
function dateLabel(value?: string): string {
  if (!value) return t("尚未结束");
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(window.GivI18n?.locale());
}
function phaseLabel(phase: string): string {
  return t(({ running: "进行中", interrupted: "意外中断", succeeded: "已完成", partial: "部分完成", failed: "失败", cancelled: "已取消" } as Record<string, string>)[phase] ?? phase);
}
type HistoryRead = {root: string; revision: number; controller: AbortController; busy: boolean; loaded: boolean; nextCursor: string};

export default function DownloadHistoryPanel({ root, active, onRetry, onResume, retryBusy }: {
  root: string;
  active: boolean;
  onRetry: (historyId: string, assetIds: string[]) => Promise<void>;
  onResume?: () => Promise<void>;
  retryBusy: boolean;
}) {
  const [items, setItems] = useState<DownloadHistoryItem[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [nextCursor, setNextCursor] = useState("");
  const sessionRef = useRef<HistoryRead | null>(null);
  const [revision, refresh] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [retrying, setRetrying] = useState(false);
  const [, repaint] = useState(0);
  useEffect(() => window.GivI18n?.subscribe(() => repaint((value) => value + 1)), []);

  async function readPage(session: HistoryRead, cursor?: string) {
      if (session.busy || session.controller.signal.aborted) return;
      session.busy = true;
      setBusy(true);
      try {
        const result = await getDownloadHistory(50, session.root, session.controller.signal, cursor);
        if (session.controller.signal.aborted || sessionRef.current !== session) return;
        if (result.root !== session.root) throw new Error(t("图库已切换，请重新选择下载记录。"));
        const next = (result.items ?? []).map((item) => ({ ...item, failures: item.failures ?? [] }));
        setItems(current => {
          const seen = new Set<string>();
          return (cursor ? [...current, ...next] : [...next, ...current]).filter(item => {
            if (seen.has(item.id)) return false;
            seen.add(item.id); return true;
          });
        });
        if (cursor || !session.loaded) {
          session.nextCursor = result.nextCursor ?? "";
          setNextCursor(session.nextCursor);
        }
        session.loaded = true;
        setError("");
        setSelected((current) => ({...current, ...Object.fromEntries(next.map((item) => {
          const eligible = item.failures.filter((failure) => failure.retryable).map((failure) => failure.assetId);
          return [item.id, item.id in current ? current[item.id].filter((id) => eligible.includes(id)) : eligible];
        }))}));
      } catch (cause) {
        if (!session.controller.signal.aborted && sessionRef.current === session) {
          if (!session.loaded) setItems([]);
          setError(message(cause));
        }
      } finally {
        session.busy = false;
        if (!session.controller.signal.aborted && sessionRef.current === session) {
          setBusy(false);
        }
      }
  }
  useEffect(() => {
    const previous = sessionRef.current;
    const fresh = !previous || previous.root !== root || previous.revision !== revision;
    const session: HistoryRead = {root, revision, controller: new AbortController(), busy: false,
      loaded: fresh ? false : previous?.loaded ?? false, nextCursor: fresh ? "" : previous?.nextCursor ?? ""};
    sessionRef.current = session;
    if (fresh) {setItems([]);setSelected({});setExpanded(null);setNextCursor("");}
    let timer = 0;
    async function tick() {
      await readPage(session);
      if (active && !session.controller.signal.aborted) timer = window.setTimeout(() => void tick(), 2000);
    }
    void tick();
    return () => { session.controller.abort(); window.clearTimeout(timer); };
  }, [root, active, revision]);

  async function run(action: () => Promise<void>) {
    if (retrying || retryBusy) return;
    setRetrying(true);
    setError("");
    try { await action(); }
    catch (cause) { setError(message(cause)); }
    finally { setRetrying(false); refresh((value) => value + 1); }
  }
  const disabled = retryBusy || retrying;
  return <section className="download-history" aria-label={t("下载历史")}>
    <div className="download-history-toolbar">
      <button type="button" disabled={busy} onClick={() => refresh((value) => value + 1)}>
        {t(busy ? "刷新中…" : "刷新历史")}
      </button>
    </div>
    {error && <p className="settings-error" role="alert">{error}</p>}
    {!error && !busy && items.length === 0 && <p className="settings-hint">{t("当前图库暂无下载记录。")}</p>}
    <div className="download-history-list">
      {items.map((item) => {
        const eligible = item.failures.filter((failure) => failure.retryable).map((failure) => failure.assetId);
        const ids = (selected[item.id] ?? []).filter((id) => eligible.includes(id));
        return <article className="download-history-row" key={item.id}>
          <div className="download-history-heading"><strong>{phaseLabel(item.phase)}</strong><time>{dateLabel(item.startedAt)}</time></div>
          <p>{t("成功 {success} · 失败 {failed} · 跳过 {skipped}", { success: item.counts?.succeeded ?? 0, failed: item.counts?.failed ?? 0, skipped: item.counts?.skipped ?? 0 })}
            {item.published ? " · " + t("索引已发布") : ""}</p>
          <small>{t("结束时间：{time}", { time: dateLabel(item.finishedAt) })}</small>
          {item.retryOf && <small>{t("重试自任务 {id}", { id: item.retryOf.slice(0, 8) })}</small>}
          {item.code && <small>{item.code}</small>}
          {item.failures.length > 0 && <>
            <button type="button" aria-expanded={expanded === item.id} onClick={() => setExpanded((current) => current === item.id ? null : item.id)}>
              {t(expanded === item.id ? "收起失败明细" : "查看失败明细")} ({item.failures.length})
            </button>
            {expanded === item.id && <>
              {eligible.length > 0 && <div className="download-history-toolbar">
                <button type="button" disabled={disabled} onClick={() => setSelected((current) => ({ ...current, [item.id]: eligible }))}>{t("全选可重试项")}</button>
                <button type="button" disabled={disabled} onClick={() => setSelected((current) => ({ ...current, [item.id]: [] }))}>{t("清空选择")}</button>
              </div>}
              <ul className="download-history-failures">{item.failures.slice(0, 200).map((failure, index) => <li key={failure.assetId + ":" + index}>
                {failure.retryable && <label><input type="checkbox" aria-label={t("选择重试 {id}", { id: failure.assetId })}
                  checked={ids.includes(failure.assetId)} disabled={disabled} onChange={(event) => {
                    const checked = event.target.checked;
                    setSelected((current) => {
                      const values = new Set(current[item.id] ?? eligible);
                      if (checked) values.add(failure.assetId); else values.delete(failure.assetId);
                      return { ...current, [item.id]: [...values] };
                    });
                  }} />{t("选择重试")}</label>}
                <strong>{failure.assetId}</strong>
                <span>{failure.stage} · {failure.code} · {message(failure.message)}</span>
                <small>{t("第 {attempt} 次", { attempt: failure.attempt })} · {t(failure.retryable ? "可重试" : "不可自动重试")}</small>
              </li>)}</ul>
              {eligible.length > 0 && <button type="button" disabled={disabled || ids.length === 0}
                onClick={() => void run(() => onRetry(item.id, ids))}>
                {t(retrying ? "重试运行中…" : "重试选中失败项（{count}）", { count: ids.length })}
              </button>}
            </>}
          </>}
          {onResume && ["interrupted", "cancelled"].includes(item.phase) && <div>
            <p className="settings-hint">{t("重新读取清单并跳过已验证文件。")}</p>
            <button type="button" disabled={disabled} onClick={() => void run(onResume)}>{t("继续未完成下载")}</button>
          </div>}
        </article>;
      })}
    </div>
    {nextCursor && <button type="button" disabled={busy} onClick={() => {
      const session = sessionRef.current;
      if (session) void readPage(session, session.nextCursor);
    }}>
      {t(busy ? "加载中…" : "加载更早记录")}
    </button>}
  </section>;
}
