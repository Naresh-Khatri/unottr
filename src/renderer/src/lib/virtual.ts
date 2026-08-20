// Minimal hand-rolled virtualizer (no external dep). Supports variable item heights via
// post-render measurement, so it works for both the recordings table (near-fixed rows) and
// the transcript list (speaker headers + wrapped text). Offsets are a plain cumulative array
// with binary search — fine at the row counts these two screens see.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

export interface UseVirtualOpts {
  count: number;
  estimateSize: (index: number) => number;
  overscan?: number;
  /** reset all measurements when this changes (e.g. switching recordings) */
  resetKey?: unknown;
}

export interface UseVirtualResult {
  containerRef: React.RefObject<HTMLDivElement | null>;
  start: number;
  end: number; // exclusive
  topPad: number;
  bottomPad: number;
  /** attach to each rendered item's root node so its real height gets measured */
  measureRef: (index: number) => (el: HTMLElement | null) => void;
  scrollToIndex: (index: number, align?: "start" | "center") => void;
}

export function useVirtual({ count, estimateSize, overscan = 6, resetKey }: UseVirtualOpts): UseVirtualResult {
  const containerRef = useRef<HTMLDivElement>(null);
  const sizes = useRef<number[]>([]);
  const offsets = useRef<number[]>([0]);
  const [range, setRange] = useState({ start: 0, end: 0 });
  const [, bump] = useReducer((c: number) => c + 1, 0);

  const rebuildOffsets = useCallback(() => {
    const offs = new Array(count + 1);
    offs[0] = 0;
    for (let i = 0; i < count; i++) offs[i + 1] = offs[i] + sizes.current[i];
    offsets.current = offs;
  }, [count]);

  const recompute = useCallback(() => {
    const el = containerRef.current;
    if (!el || count === 0) { setRange({ start: 0, end: 0 }); return; }
    const offs = offsets.current;
    const findIndex = (y: number) => {
      let lo = 0, hi = offs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (offs[mid] <= y) lo = mid; else hi = mid - 1;
      }
      return Math.min(lo, count - 1);
    };
    const start = Math.max(0, findIndex(el.scrollTop) - overscan);
    const end = Math.min(count, findIndex(el.scrollTop + el.clientHeight) + 1 + overscan);
    setRange({ start, end });
  }, [count, overscan]);

  // (re)seed sizes when the item count or identity changes
  useEffect(() => {
    const next = new Array(count);
    for (let i = 0; i < count; i++) next[i] = sizes.current[i] ?? estimateSize(i);
    sizes.current = next;
    rebuildOffsets();
    recompute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, resetKey]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("scroll", recompute, { passive: true });
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", recompute); ro.disconnect(); };
  }, [recompute]);

  const measureRef = useCallback((index: number) => (el: HTMLElement | null) => {
    if (!el) return;
    const h = el.getBoundingClientRect().height;
    if (h > 0 && Math.abs((sizes.current[index] ?? 0) - h) > 0.5) {
      sizes.current[index] = h;
      rebuildOffsets();
      bump();
      recompute();
    }
  }, [rebuildOffsets, recompute]);

  const scrollToIndex = useCallback((index: number, align: "start" | "center" = "start") => {
    const el = containerRef.current;
    if (!el || index < 0 || index >= count) return;
    const top = offsets.current[index] ?? 0;
    const size = sizes.current[index] ?? estimateSize(index);
    const target = align === "center" ? top - el.clientHeight / 2 + size / 2 : top;
    el.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    // offsets may still be estimates for not-yet-measured rows; nudge once more after layout
    requestAnimationFrame(() => {
      const top2 = offsets.current[index] ?? 0;
      const target2 = align === "center" ? top2 - el.clientHeight / 2 + (sizes.current[index] ?? size) / 2 : top2;
      el.scrollTo({ top: Math.max(0, target2), behavior: "smooth" });
    });
  }, [count, estimateSize]);

  const start = Math.min(range.start, count);
  const end = Math.min(range.end, count);
  return {
    containerRef,
    start,
    end,
    topPad: offsets.current[start] ?? 0,
    bottomPad: Math.max(0, (offsets.current[count] ?? 0) - (offsets.current[end] ?? 0)),
    measureRef,
    scrollToIndex,
  };
}
