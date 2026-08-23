"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getOverview, ApiError, hasApiOverride } from "./api";
import { buildDemoOverview } from "./demo";
import type { Overview } from "./types";

/**
 * Eases a number toward its target instead of snapping. Live metrics change on
 * every poll, and a hard jump reads as a glitch rather than an update.
 */
export function useCountUp(target: number, duration = 700): number {
  const [value, setValue] = useState(target);

  // The live value lives in a ref, not in the effect's closure: when `target`
  // changes mid-tween the cleanup needs the value as of *now*, and a closure
  // captured at effect-creation time is already stale by then — which showed
  // up as the number jumping backwards before easing forward again.
  const currentRef = useRef(target);
  const frameRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!Number.isFinite(target)) return;

    const from = currentRef.current;
    if (from === target) return;

    const start = performance.now();

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // easeOutExpo — fast settle, no overshoot
      const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      const next = from + (target - from) * eased;

      currentRef.current = next;
      setValue(next);

      if (t < 1) frameRef.current = requestAnimationFrame(step);
    };

    frameRef.current = requestAnimationFrame(step);

    return () => {
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    };
  }, [target, duration]);

  return value;
}

export interface OverviewState {
  data: Overview | null;
  error: string | null;
  loading: boolean;
  refreshing: boolean;
  refresh: () => Promise<void>;
  lastFetchedAt: number;
  /** True when `data` is synthetic because no engine answered. */
  demo: boolean;
}

/**
 * Polls /overview. Backs off when the tab is hidden so a dashboard left open
 * in a background tab is not hammering the API (and its RPC quota) all day.
 */
export function useOverview(intervalMs = 10_000): OverviewState {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastFetchedAt, setLastFetchedAt] = useState(0);
  const [demo, setDemo] = useState(false);

  // Guards against a slow response from a previous poll overwriting a newer one.
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setRefreshing(true);

    try {
      const next = await getOverview();
      if (id !== requestId.current) return;
      setData(next);
      setDemo(false);
      setError(null);
      setLastFetchedAt(Date.now());
    } catch (err) {
      if (id !== requestId.current) return;

      const message =
        err instanceof ApiError ? err.message : "Unexpected error loading data";

      // With no engine reachable and no deliberate override, fall back to a
      // synthetic dataset rather than showing an error card. A first-time
      // visitor learns nothing from "connection refused"; the UI labels this
      // as demo data throughout so it can never be mistaken for live figures.
      if (!hasApiOverride()) {
        setData(buildDemoOverview());
        setDemo(true);
        setError(null);
        setLastFetchedAt(Date.now());
      } else {
        setError(message);
      }
    } finally {
      if (id === requestId.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();

    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer) return;
      timer = setInterval(() => void refresh(), intervalMs);
    };

    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void refresh();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh, intervalMs]);

  return { data, error, loading, refreshing, refresh, lastFetchedAt, demo };
}

/** Re-renders on a timer so "12s ago" labels stay honest. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}

/** True only after the first client render — used to gate time-relative text
 *  that would otherwise differ between server and client HTML. */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

/**
 * Keyboard navigation for the wallet list.
 *
 * A monitoring dashboard is something you scan repeatedly, and reaching for
 * the mouse to change wallet breaks that. Bindings are ignored while a field
 * has focus so typing an address never moves the selection.
 */
export function useListKeyboardNav({
  count,
  index,
  onSelect,
  onAdd,
}: {
  count: number;
  index: number;
  onSelect: (next: number) => void;
  onAdd?: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case "ArrowDown":
        case "j":
          if (count === 0) return;
          e.preventDefault();
          onSelect((index + 1) % count);
          break;
        case "ArrowUp":
        case "k":
          if (count === 0) return;
          e.preventDefault();
          onSelect((index - 1 + count) % count);
          break;
        case "/":
          if (!onAdd) return;
          e.preventDefault();
          onAdd();
          break;
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count, index, onSelect, onAdd]);
}
