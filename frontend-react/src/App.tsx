import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addToTrash, getBackendHealth, getCombo, getDownloadStatus, getLibrarySummary, getMetadata, getPreferences, getTrash, getViews, purgeTrash, restoreFromTrash, savePreferences, saveViews, setLibraryRoot, updateMetadata } from "./lib/backend";
import { useAppStore } from "./store/app";
import MediaViewer from "./components/MediaViewer";
import DownloadHistoryPanel from "./components/DownloadHistoryPanel";
import VirtualMasonry from "./components/VirtualMasonry";
import { createDesktopLibrary, isDesktopRuntime, pickDesktopLibrary, startDesktopDownload, stopDesktopDownload, type DesktopDownloadResult } from "./lib/desktop";
import type { BackendHealth, ComboResponse, LibraryGroup, LibrarySummary, PreferencesResponse } from "./types/api";

const navigation = [
  { id: "library", label: "图库", hint: "Library" },
  { id: "downloads", label: "下载任务", hint: "Downloads" },
  { id: "trash", label: "回收站", hint: "Trash" },
  { id: "settings", label: "设置", hint: "Settings" },
] as const;

type LoadState = "loading" | "ready" | "error";

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours > 0 ? hours + ":" + String(minutes).padStart(2, "0") + ":" + String(remainder).padStart(2, "0") : minutes + ":" + String(remainder).padStart(2, "0");
}

function groupLabel(group: LibraryGroup): string {
  return group.title || group.name || group.folder || group.section || "未命名分组";
}

export default function App() {
  const activeView = useAppStore((state) => state.activeView);
  const setActiveView = useAppStore((state) => state.setActiveView);
  const collapsed = useAppStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useAppStore((state) => state.toggleSidebar);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [error, setError] = useState("");
  const [health, setHealth] = useState<BackendHealth | null>(null);
  const [library, setLibrary] = useState<LibrarySummary | null>(null);
  const [preferences, setPreferences] = useState<PreferencesResponse | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<LibraryGroup | null>(null);
  const [combo, setCombo] = useState<ComboResponse | null>(null);
  const [comboLoading, setComboLoading] = useState(false);
  const [comboError, setComboError] = useState("");
  const [search, setSearch] = useState("");
  const [mediaFilter, setMediaFilter] = useState("all");
  const [sortOrder, setSortOrder] = useState("newest");
  const [selectedTag, setSelectedTag] = useState("");
  const [tileMinWidth, setTileMinWidth] = useState(190);
  const [metaRevision, setMetaRevision] = useState(0);
  const [favoriteBusy, setFavoriteBusy] = useState<string | null>(null);
  const [tagBusy, setTagBusy] = useState(false);
  const [trashItems, setTrashItems] = useState<any[]>([]);
  const [trashBusy, setTrashBusy] = useState(false);
  const [trashError, setTrashError] = useState("");
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [downloadResult, setDownloadResult] = useState<DesktopDownloadResult | null>(null);
  const [downloadStatus, setDownloadStatus] = useState<import("./types/api").DownloadStatus | null>(null);
  const [downloadError, setDownloadError] = useState("");
  const [languageBusy, setLanguageBusy] = useState(false);
  const [libraryDialogBusy, setLibraryDialogBusy] = useState(false);
  const [activeMediaId, setActiveMediaId] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectionGroupKeyRef = useRef("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkTagValue, setBulkTagValue] = useState("");
  const viewsConfigRef = useRef<Record<string, any> | null>(null);
  const [viewsRoot, setViewsRoot] = useState("");
  const [viewsLoaded, setViewsLoaded] = useState(false);
  const [viewsSaveError, setViewsSaveError] = useState("");

  const groups = useMemo(
    () => [...(library?.combos ?? []), ...(library?.other ?? [])],
    [library],
  );

  async function refresh() {
    setLoadState("loading");
    setError("");
    try {
      const [nextHealth, nextLibrary, nextPreferences, nextMeta, nextViews] = await Promise.all([
        getBackendHealth(), getLibrarySummary(true), getPreferences(), getMetadata(), getViews(),
      ]);
      setHealth(nextHealth);
      setLibrary(nextLibrary);
      setPreferences(nextPreferences);
      setMetaRevision(nextMeta.meta.revision);
      viewsConfigRef.current = nextViews.views ?? null;
      setViewsRoot(nextViews.root ?? nextLibrary.root ?? "");
      const savedView = nextViews.views?.combos;
      if (savedView) {
        setSortOrder(savedView.sort === "asc" ? "oldest" : savedView.sort === "fav" ? "fav" : "newest");
        if (typeof savedView.tile === "number" && savedView.tile > 0) setTileMinWidth(Math.max(96, Math.min(240, savedView.tile)));
        setSelectedTag(savedView.cats?.[0] ?? "");
      }
      setViewsLoaded(true);
      const nextGroups = [...(nextLibrary.combos ?? []), ...(nextLibrary.other ?? [])];
      setSelectedGroup((current) => {
        if (current && nextGroups.some((group) => group.section === current.section && group.folder === current.folder)) {
          return nextGroups.find((group) => group.section === current.section && group.folder === current.folder) ?? current;
        }
        return nextGroups[0] ?? null;
      });
      setLoadState("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法连接本地图库服务");
      setLoadState("error");
    }
  }

  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    const nextGroupKey = selectedGroup ? JSON.stringify([selectedGroup.section, selectedGroup.folder ?? ""]) : "";
    if (selectionGroupKeyRef.current !== nextGroupKey) {
      selectionGroupKeyRef.current = nextGroupKey;
      setSelectedIds([]);
      setSelectionMode(false);
    }
    if (!selectedGroup) {
      setCombo(null);
      return;
    }
    let cancelled = false;
    setComboLoading(true);
    setComboError("");
    getCombo(selectedGroup.section, selectedGroup.folder ?? "")
      .then((value) => { if (!cancelled) setCombo(value); })
      .catch((cause: unknown) => {
        if (!cancelled) setComboError(cause instanceof Error ? cause.message : "读取分组失败");
      })
      .finally(() => { if (!cancelled) setComboLoading(false); });
    return () => { cancelled = true; };
  }, [selectedGroup]);

  const visibleItems = useMemo(() => {
    const items = (combo?.items ?? []).filter((item) => {
      const matchesSearch = !search || item.file.toLowerCase().includes(search.toLowerCase());
      const isVideo = item.media === "video" || /\.(mp4|webm|mov|m4v)$/i.test(item.file);
      const matchesType = mediaFilter === "all" || (mediaFilter === "video" ? isVideo : mediaFilter === "image" ? !isVideo : item.fav === true);
      const matchesTag = !selectedTag || (item.tags ?? []).includes(selectedTag);
      return matchesSearch && matchesType && matchesTag;
    });
    items.sort((left, right) => {
      if (sortOrder === "fav" && Boolean(left.fav) !== Boolean(right.fav)) return left.fav ? -1 : 1;
      const leftTime = Date.parse(left.created ?? "");
      const rightTime = Date.parse(right.created ?? "");
      const delta = (Number.isFinite(leftTime) ? leftTime : 0) - (Number.isFinite(rightTime) ? rightTime : 0);
      return sortOrder === "newest" ? -delta : delta;
    });
    return items;
  }, [combo, search, mediaFilter, selectedTag, sortOrder]);

  async function toggleFavorite(itemId: string) {
    if (!combo || !library?.root || favoriteBusy) return;
    const item = combo.items.find((candidate) => candidate.id === itemId);
    if (!item) return;
    setFavoriteBusy(itemId);
    try {
      const result = await updateMetadata({ expectedRoot: library.root, expectedRevision: metaRevision, item: { id: item.id, fav: !item.fav } });
      const meta = result.meta as { revision?: number } | undefined;
      if (typeof meta?.revision === "number") setMetaRevision(meta.revision);
      setCombo(await getCombo(combo.section, combo.folder));
    } catch (cause) { setComboError(cause instanceof Error ? cause.message : "收藏保存失败"); }
    finally { setFavoriteBusy(null); }
  }

  const activeMediaIndex = visibleItems.findIndex((item) => item.id === activeMediaId);
  const activeMedia = activeMediaIndex >= 0 ? visibleItems[activeMediaIndex] : null;
  const closeMediaViewer = useCallback(() => setActiveMediaId(null), []);
  const previousMedia = useCallback(() => {
    if (!visibleItems.length) return;
    const index = visibleItems.findIndex((item) => item.id === activeMediaId);
    setActiveMediaId(visibleItems[(index - 1 + visibleItems.length) % visibleItems.length].id);
  }, [visibleItems, activeMediaId]);
  const nextMedia = useCallback(() => {
    if (!visibleItems.length) return;
    const index = visibleItems.findIndex((item) => item.id === activeMediaId);
    setActiveMediaId(visibleItems[(index + 1) % visibleItems.length].id);
  }, [visibleItems, activeMediaId]);
  function toggleSelected(itemId: string) {
    setSelectedIds((current) => current.includes(itemId) ? current.filter((id) => id !== itemId) : [...current, itemId]);
  }

  function selectAllVisible() { setSelectedIds(visibleItems.map((item) => item.id)); }
  function clearSelection() { setSelectedIds([]); setSelectionMode(false); }

  async function bulkFavorite() {
    if (!combo || !library?.root || !selectedIds.length || bulkBusy) return;
    const targets = combo.items.filter((item) => selectedIds.includes(item.id) && !item.fav);
    if (!targets.length) { setComboError("所选项目已经全部收藏。"); return; }
    setBulkBusy(true); setComboError("");
    try {
      const result = await updateMetadata({
        expectedRoot: library.root, expectedRevision: metaRevision,
        itemPatches: targets.map((item) => ({ id: item.id, section: item.section ?? combo.section, folder: item.folder ?? combo.folder, fav: true })),
        groupPatches: [],
      });
      const meta = result.meta as { revision?: number } | undefined;
      if (typeof meta?.revision === "number") setMetaRevision(meta.revision);
      setCombo(await getCombo(combo.section, combo.folder));
      clearSelection();
    } catch (cause) { setComboError(cause instanceof Error ? cause.message : "批量收藏失败"); }
    finally { setBulkBusy(false); }
  }

  async function bulkDislike() {
    if (!combo || !library?.root || !selectedIds.length || bulkBusy) return;
    const targets = combo.items.filter((item) => selectedIds.includes(item.id));
    if (!targets.length) return;
    setBulkBusy(true); setComboError("");
    try {
      const result = await updateMetadata({ expectedRoot: library.root, expectedRevision: metaRevision, itemPatches: targets.map((item) => ({ id: item.id, section: item.section ?? combo.section, folder: item.folder ?? combo.folder, dislike: true })), groupPatches: [] });
      const meta = result.meta as { revision?: number } | undefined;
      if (typeof meta?.revision === "number") setMetaRevision(meta.revision);
      setCombo(await getCombo(combo.section, combo.folder));
      clearSelection();
    } catch (cause) { setComboError(cause instanceof Error ? cause.message : "批量标记不喜欢失败"); }
    finally { setBulkBusy(false); }
  }

  async function bulkRemoveTag() {
    const tag = bulkTagValue.trim();
    if (!combo || !library?.root || !selectedIds.length || !tag || bulkBusy) return;
    const targets = combo.items.filter((item) => selectedIds.includes(item.id) && (item.tags ?? []).includes(tag));
    if (!targets.length) { setComboError("所选项目没有这个标签。"); return; }
    setBulkBusy(true); setComboError("");
    try {
      const result = await updateMetadata({ expectedRoot: library.root, expectedRevision: metaRevision, itemPatches: targets.map((item) => ({ id: item.id, section: item.section ?? combo.section, folder: item.folder ?? combo.folder, tags: (item.tags ?? []).filter((value) => value !== tag) })), groupPatches: [] });
      const meta = result.meta as { revision?: number } | undefined;
      if (typeof meta?.revision === "number") setMetaRevision(meta.revision);
      setCombo(await getCombo(combo.section, combo.folder));
      setBulkTagValue("");
      clearSelection();
    } catch (cause) { setComboError(cause instanceof Error ? cause.message : "批量移除标签失败"); }
    finally { setBulkBusy(false); }
  }
  async function bulkAddTag() {
    const tag = bulkTagValue.trim();
    if (!combo || !library?.root || !selectedIds.length || !tag || bulkBusy) return;
    const targets = combo.items.filter((item) => selectedIds.includes(item.id));
    if (!targets.length) return;
    setBulkBusy(true); setComboError("");
    try {
      const result = await updateMetadata({
        expectedRoot: library.root, expectedRevision: metaRevision,
        itemPatches: targets.map((item) => ({ id: item.id, section: item.section ?? combo.section, folder: item.folder ?? combo.folder, tags: Array.from(new Set([...(item.tags ?? []), tag])) })),
        groupPatches: [],
      });
      const meta = result.meta as { revision?: number } | undefined;
      if (typeof meta?.revision === "number") setMetaRevision(meta.revision);
      setCombo(await getCombo(combo.section, combo.folder));
      setBulkTagValue("");
      clearSelection();
    } catch (cause) { setComboError(cause instanceof Error ? cause.message : "批量添加标签失败"); }
    finally { setBulkBusy(false); }
  }

  async function bulkTrash() {
    if (!combo || !library?.root || !selectedIds.length || bulkBusy) return;
    const ids = selectedIds.filter((id) => combo.items.some((item) => item.id === id));
    if (!ids.length) return;
    if (!window.confirm("将选中的 " + ids.length + " 项移入回收站？之后仍可恢复。")) return;
    setBulkBusy(true); setComboError("");
    try {
      const result = await addToTrash({ expectedRoot: library.root, groups: [{ section: combo.section, folder: combo.folder, ids }] });
      const outcome = result as { moved?: unknown[]; errors?: unknown[] };
      const movedIds = new Set((outcome.moved ?? []).map((row) => typeof row === "string" ? row : row && typeof row === "object" && "id" in row ? String((row as { id: unknown }).id) : "").filter(Boolean));
      const failedIds = ids.filter((id) => !movedIds.has(id));
      if (outcome.errors?.length || failedIds.length) setComboError("部分项目未能移入回收站；成功 " + movedIds.size + " 项，待重试 " + failedIds.length + " 项。");
      setCombo(await getCombo(combo.section, combo.folder));
      setSelectedIds(failedIds);
      setSelectionMode(failedIds.length > 0);
      await refresh();
    } catch (cause) { setComboError(cause instanceof Error ? cause.message : "批量移入回收站失败"); }
    finally { setBulkBusy(false); }
  }
  async function addMediaTag(itemId: string, tag: string) {
    if (!combo || !library?.root || tagBusy) return;
    const item = combo.items.find((candidate) => candidate.id === itemId);
    if (!item) return;
    const tags = [...new Set([...(item.tags ?? []), tag.trim()].filter(Boolean))];
    setTagBusy(true);
    try {
      const result = await updateMetadata({ expectedRoot: library.root, expectedRevision: metaRevision, item: { id: item.id, tags } });
      const meta = result.meta as { revision?: number } | undefined;
      if (typeof meta?.revision === "number") setMetaRevision(meta.revision);
      setCombo(await getCombo(combo.section, combo.folder));
    } catch (cause) {
      setComboError(cause instanceof Error ? cause.message : "标签保存失败");
      throw cause;
    } finally { setTagBusy(false); }
  }
  async function chooseLibrary(createNew: boolean) {
    if (!isDesktopRuntime() || libraryDialogBusy) return;
    setLibraryDialogBusy(true); setError("");
    try {
      const root = createNew ? await createDesktopLibrary() : await pickDesktopLibrary();
      if (!root) return;
      await setLibraryRoot(root);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "图库目录操作失败"); }
    finally { setLibraryDialogBusy(false); }
  }

  useEffect(() => {
    if (!downloadBusy) return;
    let active = true;
    const poll = async () => {
      try {
        const status = await getDownloadStatus();
        if (active) setDownloadStatus(status);
      } catch {
        // Keep the Tauri command result authoritative if polling is unavailable.
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 700);
    return () => { active = false; window.clearInterval(timer); };
  }, [downloadBusy]);

  async function runDesktopDownload() {
    if (!library?.root || downloadBusy) return;
    setDownloadBusy(true); setDownloadError(""); setDownloadResult(null); setDownloadStatus(null);
    try { setDownloadResult(await startDesktopDownload(library.root)); }
    catch (cause) { setDownloadError(cause instanceof Error ? cause.message : "下载启动失败"); }
    finally { setDownloadBusy(false); }
  }

  async function retryDesktopFailures(historyId: string, failedAssetIds: string[]) {
    if (!library?.root || downloadBusy || failedAssetIds.length === 0) return;
    setDownloadBusy(true); setDownloadError(""); setDownloadResult(null); setDownloadStatus(null);
    try {
      setDownloadResult(await startDesktopDownload(library.root, { historyId, failedAssetIds }));
    } catch (cause) {
      setDownloadError(cause instanceof Error ? cause.message : "失败项目重试启动失败");
    } finally {
      setDownloadBusy(false);
    }
  }

  async function cancelDesktopDownload() {
    if (downloadBusy) {
      try { await stopDesktopDownload(); }
      catch (cause) { setDownloadError(cause instanceof Error ? cause.message : "停止请求失败"); }
    }
  }

  async function changeLanguage(language: string) {
    if (languageBusy) return;
    setLanguageBusy(true);
    try {
      await savePreferences({ language });
      setPreferences((current) => current ? { ...current, preferences: { ...current.preferences, language } } : current);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "语言设置保存失败"); }
    finally { setLanguageBusy(false); }
  }
  async function refreshTrash() {
    setTrashBusy(true); setTrashError("");
    try { const result = await getTrash(); setTrashItems(result.items ?? []); }
    catch (cause) { setTrashError(cause instanceof Error ? cause.message : "读取回收站失败"); }
    finally { setTrashBusy(false); }
  }

  async function changeTrash(item: any, purge: boolean) {
    if (!library?.root || trashBusy) return;
    if (purge && !window.confirm("彻底删除后无法恢复，确定继续？")) return;
    setTrashBusy(true); setTrashError("");
    try {
      const action = purge ? purgeTrash : restoreFromTrash;
      const result = await action({ expectedRoot: library.root, ids: [item.id] });
      const outcome = result as { errors?: unknown[]; conflicts?: unknown[] };
      if ((outcome.errors?.length ?? 0) || (outcome.conflicts?.length ?? 0)) throw new Error("操作未完全成功，请检查该条目。");
      const refreshed = await getTrash(); setTrashItems(refreshed.items ?? []);
      await refresh();
    } catch (cause) { setTrashError(cause instanceof Error ? cause.message : "回收站操作失败"); }
    finally { setTrashBusy(false); }
  }

  useEffect(() => {
    const currentViews = viewsConfigRef.current;
    if (!viewsLoaded || !currentViews || !library?.root || viewsRoot !== library.root) return;
    const timer = window.setTimeout(() => {
      const bucket = selectedGroup?.section === "combos" ? "combos" : "other";
      const next = {
        ...currentViews,
        [bucket]: {
          ...(currentViews[bucket] ?? {}),
          density: "expanded",
          sort: sortOrder === "oldest" ? "asc" : sortOrder === "fav" ? "fav" : "desc",
          tile: Math.max(96, Math.min(240, tileMinWidth)),
          cats: selectedTag ? [selectedTag] : [],
        },
      };
      void saveViews(next, library.root)
        .then(() => { viewsConfigRef.current = next; setViewsSaveError(""); })
        .catch((cause) => setViewsSaveError(cause instanceof Error ? cause.message : "视图设置保存失败"));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [viewsLoaded, viewsRoot, library?.root, selectedGroup, sortOrder, tileMinWidth, selectedTag]);
  useEffect(() => { if (activeView === "trash" && loadState === "ready") void refreshTrash(); }, [activeView, loadState]);
  const active = navigation.find((item) => item.id === activeView);

  return (
    <main className="app-shell">
      <aside className={collapsed ? "sidebar collapsed" : "sidebar"}>
        <div className="brand">
          <div className="brand-mark">G</div>
          {!collapsed && <div><strong>Grok Imagine</strong><span>Viewer</span></div>}
        </div>
        <nav aria-label="主导航">
          {navigation.map((item) => (
            <button className={activeView === item.id ? "nav-item active" : "nav-item"} key={item.id}
              onClick={() => setActiveView(item.id)} title={collapsed ? item.label : undefined}>
              <span className="nav-dot" />
              {!collapsed && <><span>{item.label}</span><small>{item.hint}</small></>}
            </button>
          ))}
        </nav>
        <button className="collapse-button" onClick={toggleSidebar}>
          {collapsed ? "展开侧栏" : "收起侧栏"}
        </button>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div><span className="eyebrow">LOCAL MEDIA LIBRARY</span><h1>{active?.label}</h1></div>
          <div className="runtime-pill"><span className={loadState === "ready" ? "online" : ""} />
            {loadState === "loading" ? "正在连接" : loadState === "error" ? "服务不可用" : "Go Backend"}
          </div>
        </header>

        <section className="content">
          {loadState === "loading" && <div className="empty-state"><h2>正在连接本地服务</h2><p>正在检查 Go Sidecar、图库和本地设置。</p></div>}
          {loadState === "error" && <div className="empty-state"><h2>无法连接图库服务</h2><p>{error}</p><button className="action-button" onClick={() => void refresh()}>重新连接</button></div>}

          {loadState === "ready" && activeView === "library" && (
            <div className="library-layout">
              <div className="library-heading">
                <div><span className="eyebrow">BACKEND CONNECTED</span><h2>{library?.ok ? "媒体图库" : "请选择或创建图库"}</h2><p>{library?.root || "当前尚未选择图库目录。"}</p></div>
                <div className="library-header-actions"><button className="action-button" onClick={() => void refresh()}>刷新</button><button className="action-button" disabled={!isDesktopRuntime() || libraryDialogBusy} onClick={() => void chooseLibrary(false)}>切换图库</button></div>
              </div>
              {!library?.ok && (
                <div className="empty-state">
                  <h2>选择图库目录</h2>
                  <p>选择已有 Grok Imagine 图库，或创建一个新的图库目录。原有媒体文件不会被移动。</p>
                  <div className="download-actions">
                    <button className="action-button" disabled={!isDesktopRuntime() || libraryDialogBusy} onClick={() => void chooseLibrary(false)}>选择已有图库</button>
                    <button className="action-button" disabled={!isDesktopRuntime() || libraryDialogBusy} onClick={() => void chooseLibrary(true)}>创建新图库</button>
                  </div>
                  {!isDesktopRuntime() && <p className="muted">目录选择需要在 Tauri 桌面应用中使用。</p>}
                </div>
              )}
              {library?.ok && (
                <div className="library-workspace">
                  <aside className="group-list" aria-label="图库分组">
                    {groups.map((group) => (
                      <button key={`${group.section}/${group.folder}`}
                        className={selectedGroup?.section === group.section && selectedGroup?.folder === group.folder ? "group-item selected" : "group-item"}
                        onClick={() => setSelectedGroup(group)}>
                        <span>{groupLabel(group)}</span><small>{typeof group.count === "number" ? group.count : ""}</small>
                      </button>
                    ))}
                    {groups.length === 0 && <p className="muted">图库中暂无分组</p>}
                  </aside>
                  <div className="media-panel">
                    <div className="media-heading">
                      <h3>{combo?.card ? groupLabel(combo.card) : selectedGroup ? groupLabel(selectedGroup) : "媒体"}</h3>
                      <span>{combo?.items.length ?? 0} 项</span>
                    </div>
                    <div className="media-toolbar">
                      <input aria-label="搜索媒体文件名" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索文件名…" />
                      <select aria-label="媒体类型" value={mediaFilter} onChange={(event) => setMediaFilter(event.target.value)}>
                        <option value="all">全部</option><option value="image">图片</option><option value="video">视频</option><option value="favorites">收藏</option>
                      </select>
                      <select aria-label="排序" value={sortOrder} onChange={(event) => setSortOrder(event.target.value)}>
                        <option value="newest">最新优先</option><option value="oldest">最早优先</option><option value="fav">收藏优先</option>
                      </select>
                      <select aria-label="标签筛选" value={selectedTag} onChange={(event) => setSelectedTag(event.target.value)}>
                        <option value="">全部标签</option>
                        {(library?.tags ?? []).map((tag) => <option key={tag} value={tag}>{tag}</option>)}
                      </select>
                      <button className={selectionMode ? "toolbar-reset active" : "toolbar-reset"} onClick={() => { setSelectionMode((value) => !value); setSelectedIds([]); }}>
                        {selectionMode ? "退出多选" : "多选"}
                      </button>
                      <label className="tile-width-control">卡片宽度
                        <input type="range" min="96" max="240" step="8" value={tileMinWidth} onChange={(event) => setTileMinWidth(Number(event.target.value))} />
                      </label>
                      {(search || mediaFilter !== "all" || sortOrder !== "newest" || selectedTag) && (
                        <button className="toolbar-reset" onClick={() => { setSearch(""); setMediaFilter("all"); setSortOrder("newest"); setSelectedTag(""); }}>重置筛选</button>
                      )}
                    </div>
                    {viewsSaveError && <p className="error-text">{viewsSaveError}</p>}
                    {comboLoading && <p className="muted">正在读取媒体…</p>}
                    {comboError && <p className="error-text">{comboError}</p>}
                    {!comboLoading && !comboError && combo?.items.length === 0 && <p className="muted">这个分组暂时没有媒体。</p>}
                    {selectionMode && (
                      <div className="bulk-toolbar">
                        <span>已选择 {selectedIds.length} 项</span>
                        <button className="action-button" disabled={bulkBusy || !visibleItems.length} onClick={selectAllVisible}>全选当前结果</button>
                        <button className="action-button" disabled={bulkBusy || !selectedIds.length} onClick={clearSelection}>清空</button>
                        <button className="action-button" disabled={bulkBusy || !selectedIds.length} onClick={() => void bulkFavorite()}>批量收藏</button>
                        <button className="action-button" disabled={bulkBusy || !selectedIds.length} onClick={() => void bulkDislike()}>标记不喜欢</button>
                        <input className="bulk-tag-input" aria-label="批量标签操作" placeholder="输入标签" value={bulkTagValue} maxLength={64} onChange={(event) => setBulkTagValue(event.target.value)} />
                        <button className="action-button" disabled={bulkBusy || !selectedIds.length || !bulkTagValue.trim()} onClick={() => void bulkAddTag()}>添加标签</button>
                        <button className="action-button" disabled={bulkBusy || !selectedIds.length || !bulkTagValue.trim()} onClick={() => void bulkRemoveTag()}>移除标签</button>
                        <button className="action-button danger" disabled={bulkBusy || !selectedIds.length} onClick={() => void bulkTrash()}>{bulkBusy ? "处理中…" : "移入回收站"}</button>
                      </div>
                    )}
                    <VirtualMasonry
                      items={visibleItems}
                      minWidth={tileMinWidth}
                      renderItem={(item, measure) => (
                        <figure className="media-card">
                          {selectionMode && (
                            <button type="button" className={selectedIds.includes(item.id) ? "tile-select selected" : "tile-select"}
                              aria-label={selectedIds.includes(item.id) ? "取消选择" : "选择媒体"}
                              disabled={bulkBusy} onClick={() => toggleSelected(item.id)}>
                              {selectedIds.includes(item.id) ? "✓" : ""}
                            </button>
                          )}
                          <button type="button" className="media-preview" onClick={() => setActiveMediaId(item.id)} onMouseEnter={(event) => { const video = event.currentTarget.querySelector("video"); if (video) void video.play().catch(() => undefined); }} onMouseLeave={(event) => { const video = event.currentTarget.querySelector("video"); if (video) { video.pause(); video.currentTime = 0; } }} aria-label={"打开 " + item.file}>
                            {item.media === "video" || item.file.match(/\.(mp4|webm|mov|m4v)$/i)
                              ? <video src={item.url} muted preload="metadata" onLoadedMetadata={(event) => measure(event.currentTarget.videoWidth, event.currentTarget.videoHeight)} />
                              : <img src={item.url} loading="lazy" alt={item.file} onLoad={(event) => measure(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} /> }
                          </button>
                          {typeof item.duration === "number" && item.duration > 0 && <span className="media-duration">{formatDuration(item.duration)}</span>}
                          <div className="media-card-footer">
                            <figcaption title={item.file}>{item.file}</figcaption>
                            <button type="button" className={item.fav ? "favorite-button active" : "favorite-button"} aria-label={item.fav ? "取消收藏" : "收藏"} disabled={favoriteBusy === item.id} onClick={() => void toggleFavorite(item.id)}>{item.fav ? "★" : "☆"}</button>
                          </div>
                        </figure>
                      )}
                    />
                    {!comboLoading && visibleItems.length === 0 && <p className="muted">没有符合筛选条件的媒体。</p>}
                  </div>
                </div>
              )}
              <div className="status-grid">
                <div><strong>Go Sidecar</strong><span>PID {health?.pid} · Port {health?.port}</span></div>
                <div><strong>图库状态</strong><span>{library?.mode ?? "empty"}</span></div>
                <div><strong>语言设置</strong><span>{String(preferences?.preferences.language ?? preferences?.systemLanguage ?? "auto")}</span></div>
              </div>
            </div>
          )}
          {loadState === "ready" && activeView === "downloads" && <div className="empty-state"><h2>下载任务</h2><p>下载认证和 Grok WebView 会话仍由 Rust 安全托管，下载协调与文件操作由 Go 后端执行。</p>{!isDesktopRuntime() && <p className="muted">下载控制需要在 Tauri 桌面应用中使用。</p>}<div className="download-actions"><button className="action-button" disabled={!isDesktopRuntime() || downloadBusy || !library?.root} onClick={() => void runDesktopDownload()}>{downloadBusy ? "下载准备中…" : "开始下载"}</button><button className="action-button danger" disabled={!isDesktopRuntime() || !downloadBusy} onClick={() => void cancelDesktopDownload()}>停止下载</button></div>{downloadStatus && <div className="download-result"><strong>{downloadStatus.active ? "下载进行中" : "下载状态"}</strong><span>{downloadStatus.phase ?? "等待任务"} · {downloadStatus.statusLine ?? ""}</span><span>已尝试：{downloadStatus.counts?.attempted ?? 0} / {downloadStatus.counts?.total ?? 0} · 成功：{downloadStatus.counts?.succeeded ?? 0} · 失败：{downloadStatus.counts?.failed ?? 0} · 跳过：{downloadStatus.counts?.skipped ?? 0}</span><div className="download-progress-track"><div className="download-progress-fill" style={{ width: Math.min(100, Math.round(((downloadStatus.counts?.attempted ?? 0) / Math.max(1, downloadStatus.counts?.total ?? 0)) * 100)) + "%" }} /></div></div>}{downloadError && <p className="error-text">{downloadError}</p>}{downloadResult && <div className="download-result"><strong>{downloadResult.ok ? "下载完成" : downloadResult.stopped ? "已停止" : "下载未完成"}</strong><span>成功：{downloadResult.counts?.succeeded ?? 0} · 失败：{downloadResult.counts?.failed ?? 0} · 跳过：{downloadResult.counts?.skipped ?? 0}</span>{downloadResult.published && <span>图库索引已发布；已完成的素材已保留。</span>}{downloadResult.error && <p>{downloadResult.error}</p>}{(downloadResult.failures?.length ?? 0) > 0 && <div className="download-failures"><strong>失败明细（{downloadResult.failures?.length}）</strong>{downloadResult.failures?.slice(0, 20).map((failure, index) => <div className="download-failure" key={failure.assetId + ":" + failure.stage + ":" + index}><span>{failure.assetId}</span><span>{failure.stage} · {failure.code} · 第 {failure.attempt} 次</span><p>{failure.message}</p>{failure.retryable && <small>可重试</small>}</div>)}</div>}</div>}<DownloadHistoryPanel key={library?.root ?? "no-library"} root={library?.root ?? ""} active={downloadBusy} retryBusy={downloadBusy} onRetry={retryDesktopFailures} /></div>}
          {loadState === "ready" && activeView === "trash" && <div className="empty-state"><div className="media-heading"><h2>回收站</h2><button className="action-button" disabled={trashBusy} onClick={() => void refreshTrash()}>刷新</button></div>{trashError && <p className="error-text">{trashError}</p>}{trashBusy && <p className="muted">正在处理…</p>}{!trashBusy && trashItems.length === 0 && <p className="muted">回收站为空。</p>}<div className="trash-list">{trashItems.map((item) => <div className="trash-row" key={item.id}><div><strong>{item.file}</strong><small>{item.section} / {item.folder}</small></div><div className="trash-actions"><button className="action-button" disabled={trashBusy} onClick={() => void changeTrash(item, false)}>恢复</button><button className="action-button danger" disabled={trashBusy} onClick={() => void changeTrash(item, true)}>彻底删除</button></div></div>)}</div></div>}
          {activeMedia && <MediaViewer item={activeMedia} index={activeMediaIndex} total={visibleItems.length} onClose={closeMediaViewer} onPrevious={previousMedia} onNext={nextMedia} onAddTag={(tag) => addMediaTag(activeMedia.id, tag)} tagBusy={tagBusy} />}
          {loadState === "ready" && activeView === "settings" && <div className="empty-state"><h2>设置</h2><label className="setting-row">界面语言<select value={String(preferences?.preferences.language ?? "auto")} disabled={languageBusy} onChange={(event) => void changeLanguage(event.target.value)}><option value="auto">跟随系统</option><option value="zh-CN">简体中文</option><option value="en">English</option></select></label><p className="muted">设置由 Go 后端持久化，应用重启后保留。</p></div>}
        </section>
      </section>
    </main>
  );
}
