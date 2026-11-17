import { useEffect, useRef, useState } from "react";
import type { GalleryItem } from "../types/api";

type Props = {
  item: GalleryItem;
  index: number;
  total: number;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onAddTag: (tag: string) => Promise<void>;
  tagBusy: boolean;
};

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const value = Math.floor(seconds);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainder = value % 60;
  return hours > 0
    ? hours + ":" + String(minutes).padStart(2, "0") + ":" + String(remainder).padStart(2, "0")
    : minutes + ":" + String(remainder).padStart(2, "0");
}

export default function MediaViewer({ item, index, total, onClose, onPrevious, onNext, onAddTag, tagBusy }: Props) {
  const [tag, setTag] = useState("");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [playbackError, setPlaybackError] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const isVideo = item.media === "video" || /\.(mp4|webm|mov|m4v)$/i.test(item.file);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || Boolean(target.closest("button, input, textarea, select, [contenteditable='true']")))) return;
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft") { event.preventDefault(); onPrevious(); }
      if (event.key === "ArrowRight") { event.preventDefault(); onNext(); }
      const video = videoRef.current;
      if (!isVideo || !video) return;
      if (event.code === "Space") {
        event.preventDefault();
        if (video.paused) void video.play().catch(() => undefined);
        else video.pause();
      }
      if (event.key.toLowerCase() === "m") {
        video.muted = !video.muted;
        setMuted(video.muted);
      }
      if (event.key.toLowerCase() === "j" || event.key.toLowerCase() === "l") {
        event.preventDefault();
        video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + (event.key.toLowerCase() === "j" ? -5 : 5)));
        setCurrentTime(video.currentTime);
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        const nextVolume = Math.max(0, Math.min(1, video.volume + (event.key === "ArrowUp" ? 0.05 : -0.05)));
        video.volume = nextVolume;
        video.muted = nextVolume === 0;
        setVolume(nextVolume);
        setMuted(video.muted);
      }
      if (event.key.toLowerCase() === "f") {
        const stage = stageRef.current;
        if (stage && !document.fullscreenElement) void stage.requestFullscreen().catch(() => undefined);
        else if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      }
      if (event.key === "," || event.key === "<") {
        const rate = Math.max(0.5, Math.round((video.playbackRate - 0.25) * 100) / 100);
        video.playbackRate = rate;
        setPlaybackRate(rate);
      }
      if (event.key === "." || event.key === ">") {
        const rate = Math.min(2, Math.round((video.playbackRate + 0.25) * 100) / 100);
        video.playbackRate = rate;
        setPlaybackRate(rate);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, onPrevious, onNext, isVideo]);

  useEffect(() => {
    setTag("");
    setCurrentTime(0);
    setDuration(0);
    setPlaybackRate(1);
    setPlaybackError("");
    setPlaying(true);
    const video = videoRef.current;
    if (video) {
      video.playbackRate = 1;
      video.volume = volume;
      video.muted = muted;
    }
  }, [item.id]);

  return (
    <div className="viewer-backdrop" role="presentation" onClick={onClose}>
      <section className="viewer-dialog" role="dialog" aria-modal="true" aria-label={item.file} onClick={(event) => event.stopPropagation()}>
        <header className="viewer-toolbar">
          <span title={item.file}>{item.file}</span>
          <div>
            <button type="button" onClick={onPrevious} aria-label="上一项">上一项</button>
            <button type="button" onClick={onNext} aria-label="下一项">下一项</button>
            <button type="button" onClick={onClose} aria-label="关闭">关闭</button>
          </div>
        </header>
        <div className="viewer-stage" ref={stageRef}>
          {isVideo ? (
            <div className="video-player">
              <video
                ref={videoRef}
                src={item.url}
                autoPlay
                playsInline
                onPlay={() => { setPlaying(true); setPlaybackError(""); }}
                onPause={() => setPlaying(false)}
                onEnded={onNext}
                onError={() => setPlaybackError("媒体加载失败，请检查文件或重新打开。")}
                onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
                onDurationChange={(event) => setDuration(event.currentTarget.duration || 0)}
                onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                onVolumeChange={(event) => { setMuted(event.currentTarget.muted); setVolume(event.currentTarget.volume); }}
              />
              <div className="video-controls">
                {playbackError && <div className="video-error" role="alert">{playbackError}</div>}
                <input className="video-seek" aria-label="播放进度" type="range" min={0} max={Math.max(duration, 0.01)} step="0.1" value={Math.min(currentTime, duration || 0)} onChange={(event) => {
                  const value = Number(event.target.value);
                  if (videoRef.current) videoRef.current.currentTime = value;
                  setCurrentTime(value);
                }} />
                <div className="video-controls-row">
                  <button type="button" onClick={() => {
                    const video = videoRef.current;
                    if (!video) return;
                    if (video.paused) void video.play().catch(() => undefined);
                    else video.pause();
                  }}>{playing ? "暂停" : "播放"}</button>
                  <button type="button" aria-label="后退 5 秒" onClick={() => {
                    const video = videoRef.current;
                    if (video) video.currentTime = Math.max(0, video.currentTime - 5);
                  }}>−5s</button>
                  <button type="button" aria-label="前进 5 秒" onClick={() => {
                    const video = videoRef.current;
                    if (video) video.currentTime = Math.min(video.duration || 0, video.currentTime + 5);
                  }}>+5s</button>
                  <span className="video-time">{formatTime(currentTime)} / {formatTime(duration)}</span>
                  <button type="button" onClick={() => {
                    const video = videoRef.current;
                    if (!video) return;
                    video.muted = !video.muted;
                    setMuted(video.muted);
                  }}>{muted ? "取消静音" : "静音"}</button>
                  <input className="video-volume" aria-label="音量" type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} onChange={(event) => {
                    const value = Number(event.target.value);
                    setVolume(value);
                    setMuted(value === 0);
                    if (videoRef.current) {
                      videoRef.current.volume = value;
                      videoRef.current.muted = value === 0;
                    }
                  }} />
                  <select aria-label="播放速度" value={playbackRate} onChange={(event) => {
                    const value = Number(event.target.value);
                    setPlaybackRate(value);
                    if (videoRef.current) videoRef.current.playbackRate = value;
                  }}>
                    <option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="1.75">1.75×</option><option value="2">2×</option>
                  </select>
                  <button type="button" onClick={() => {
                    const stage = stageRef.current;
                    if (stage && !document.fullscreenElement) void stage.requestFullscreen().catch(() => undefined);
                    else if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
                  }}>全屏</button>
                </div>
                <span className="video-shortcuts">空格 播放/暂停 · ←/→ 切换 · J/L 快退/快进 5 秒 · ↑/↓ 音量 · M 静音 · F 全屏 · ,/. 调速</span>
              </div>
            </div>
          ) : <img src={item.url} alt={item.file} />}
        </div>
        <section className="viewer-metadata">
          <div className="viewer-tags">
            {(item.tags ?? []).map((value) => <span className="tag-chip" key={value}>{value}</span>)}
            {(item.tags ?? []).length === 0 && <span className="viewer-hint">暂无标签</span>}
          </div>
          <form onSubmit={async (event) => {
            event.preventDefault();
            const value = tag.trim();
            if (!value || tagBusy) return;
            await onAddTag(value).then(() => setTag("")).catch(() => undefined);
          }}>
            <input aria-label="添加标签" value={tag} onChange={(event) => setTag(event.target.value)} maxLength={64} placeholder="输入标签…" />
            <button type="submit" disabled={tagBusy || !tag.trim()}>{tagBusy ? "保存中…" : "添加标签"}</button>
          </form>
        </section>
        <footer>{index + 1} / {total}</footer>
      </section>
    </div>
  );
}
