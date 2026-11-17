import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { GalleryItem } from "../types/api";

type Position = { x: number; y: number; width: number; height: number };
type Viewport = { width: number; height: number; scrollTop: number };
const BAND_HEIGHT = 600;
type Props = {
  items: GalleryItem[];
  minWidth: number;
  gap?: number;
  overscan?: number;
  renderItem: (item: GalleryItem, measure: (width: number, height: number) => void) => ReactNode;
};

export default function VirtualMasonry({ items, minWidth, gap = 8, overscan = 600, renderItem }: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ width: 0, height: 0, scrollTop: 0 });
  const [ratios, setRatios] = useState<Record<string, number>>({});

  useEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;
    let frame = 0;
    const update = () => setViewport({ width: element.clientWidth, height: element.clientHeight, scrollTop: element.scrollTop });
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; update(); });
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    element.addEventListener("scroll", schedule, { passive: true });
    update();
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  const positions = useMemo(() => {
    const width = Math.max(160, viewport.width);
    const available = Math.max(minWidth, width - gap * 2);
    const columns = Math.max(1, Math.floor((available + gap) / (minWidth + gap)));
    const cardWidth = (available - gap * (columns - 1)) / columns;
    const columnY = new Array<number>(columns).fill(gap);
    const result: Position[] = new Array(items.length);
    const bands: number[][] = [];
    for (let index = 0; index < items.length; index += 1) {
      let column = 0;
      for (let candidate = 1; candidate < columns; candidate += 1) {
        if (columnY[candidate] < columnY[column] - 0.5) column = candidate;
      }
      const ratio = ratios[items[index].id] ?? 1;
      const height = Math.max(72, Math.round(cardWidth * Math.min(1.8, Math.max(0.55, ratio))));
      result[index] = { x: gap + column * (cardWidth + gap), y: columnY[column], width: cardWidth, height };
      columnY[column] += height + gap;
      const firstBand = Math.floor(result[index].y / BAND_HEIGHT);
      const lastBand = Math.floor((result[index].y + result[index].height) / BAND_HEIGHT);
      for (let band = firstBand; band <= lastBand; band += 1) {
        if (!bands[band]) bands[band] = [];
        bands[band].push(index);
      }
    }
    return { items: result, bands, height: Math.max(gap, ...columnY) };
  }, [items, minWidth, gap, ratios, viewport.width]);

  useEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;
    const maxScroll = Math.max(0, positions.height - element.clientHeight);
    if (element.scrollTop > maxScroll) {
      element.scrollTop = maxScroll;
      setViewport((current) => ({ ...current, scrollTop: maxScroll }));
    }
  }, [positions.height]);
  const visible = useMemo(() => {
    const top = Math.max(0, viewport.scrollTop - overscan);
    const bottom = viewport.scrollTop + viewport.height + overscan;
    const firstBand = Math.max(0, Math.floor(top / BAND_HEIGHT));
    const lastBand = Math.max(0, Math.floor(bottom / BAND_HEIGHT));
    const indices = new Set<number>();
    for (let band = firstBand; band <= lastBand; band += 1) {
      for (const index of positions.bands[band] ?? []) indices.add(index);
    }
    return Array.from(indices).sort((left, right) => left - right).flatMap((index) => {
      const position = positions.items[index];
      return position && position.y <= bottom && position.y + position.height >= top
        ? [{ item: items[index], position }]
        : [];
    });
  }, [items, positions, viewport.scrollTop, viewport.height, overscan]);

  useEffect(() => {
    const validIds = new Set(items.map((item) => item.id));
    setRatios((current) => {
      const entries = Object.entries(current).filter(([id]) => validIds.has(id));
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
  }, [items]);

  return (
    <div className="virtual-grid-scroll" ref={scrollerRef}>
      <div className="virtual-grid-surface" style={{ height: positions.height }}>
        {visible.map(({ item, position }) => (
          <div className="virtual-grid-item" key={item.id} style={{
            width: position.width, height: position.height,
            transform: `translate3d(${Math.round(position.x)}px, ${Math.round(position.y)}px, 0)`,
          }}>
            {renderItem(item, (width, height) => {
              if (width <= 0 || height <= 0) return;
              const ratio = height / width;
              if (!Number.isFinite(ratio)) return;
              const next = Math.min(1.8, Math.max(0.55, ratio));
              setRatios((current) => Math.abs((current[item.id] ?? 1) - next) < 0.01 ? current : { ...current, [item.id]: next });
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
