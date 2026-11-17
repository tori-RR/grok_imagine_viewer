import { useEffect, useRef, useState } from "react";
import DownloadHistoryPanel from "../components/DownloadHistoryPanel";

interface DownloadContext {
  root: string;
  active: boolean;
  pending: boolean;
  onRetry: (historyId: string, assetIds: string[]) => Promise<void>;
}

declare global {
  interface Window {
    GivDownloadHistory?: { update: (context: DownloadContext) => void; open: () => void };
    GivI18n: {
      t: (key: string, values?: Record<string, unknown>) => string;
      message: (message: string) => string;
      locale: () => string;
      subscribe: (listener: () => void) => () => void;
    };
  }
}

export default function DownloadHistoryHost() {
  const [context, setContext] = useState<DownloadContext | null>(null);
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const backdrop = useRef<{ x: number; y: number } | null>(null);
  function outside(x: number, y: number, element: HTMLDialogElement) {
    const rect = element.getBoundingClientRect();
    return x < rect.left || x > rect.right || y < rect.top || y > rect.bottom;
  }
  useEffect(() => {
    const bridge = { update: setContext, open: () => setOpen(true) };
    window.GivDownloadHistory = bridge;
    return () => { if (window.GivDownloadHistory === bridge) delete window.GivDownloadHistory; };
  }, []);
  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [open]);
  const t = (key: string) => window.GivI18n?.t(key) ?? key;
  return <dialog ref={dialog} id="downloadHistoryDialog" className="settings-dialog failures-dialog"
    aria-labelledby="downloadHistoryTitle" onClose={() => setOpen(false)}
    onPointerDown={(event) => {
      backdrop.current = outside(event.clientX, event.clientY, event.currentTarget) ? { x: event.clientX, y: event.clientY } : null;
    }}
    onClick={(event) => {
      const start = backdrop.current;
      backdrop.current = null;
      if (start && event.target === event.currentTarget && outside(event.clientX, event.clientY, event.currentTarget)
        && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 6) dialog.current?.close();
    }}>
    {open && <>
      <header className="dialog-title">
        <h2 id="downloadHistoryTitle" data-i18n="下载历史">{t("下载历史")}</h2>
        <button type="button" className="icon-btn" aria-label={t("关闭")} data-i18n-aria-label="关闭" onClick={() => dialog.current?.close()}>×</button>
      </header>
      {context?.root ? <DownloadHistoryPanel key={context.root} root={context.root} active={context.active}
        onRetry={context.onRetry} onResume={() => context.onRetry("", [])} retryBusy={context.active || context.pending} />
        : <p>{t("请先打开或新建一个图库。")}</p>}
    </>}
  </dialog>;
}
