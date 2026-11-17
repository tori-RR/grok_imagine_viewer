import { useEffect, useRef, useState } from "react";
import DownloadHistoryHost from "./DownloadHistoryHost";
import originalDocument from "../../../static/index.html?raw";
import "../../../static/style.css";
import "../../../static/player.css";
import "./original-viewer.css";

// This is a build-time, repository-owned template, NOT API/user-supplied HTML.
// Keep the original controller in one explicit DOM island while declarative
// components are migrated against screenshot/interaction parity tests.
const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(originalDocument)?.[1];
if (!body) throw new Error("Original viewer template has no body");
const markup = body.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");

export default function OriginalViewer() {
  const started = useRef(false);
  const [error, setError] = useState("");
  useEffect(() => {
    // Document-lifetime controller, intentionally mounted once (not StrictMode).
    if (started.current) return;
    started.current = true;
    void (async () => {
      await import("../../../static/locales/en.js");
      await import("../../../static/i18n.js");
      await import("../../../static/player-settings.js");
      await import("../../../static/environment.js");
      await import("../../../static/app.js");
    })().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "界面初始化失败"));
  }, []);
  return <>
    <div style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: markup }} />
    <DownloadHistoryHost />
    {error && <div role="alert" style={{ position: "fixed", bottom: 12, left: 12, padding: 12, background: "#241416", color: "#ffb1b1", zIndex: 99999 }}>{error}</div>}
  </>;
}
