// The shell's history as a hook, wired to the mouse's side buttons.

import { useCallback, useEffect, useState } from "react";
import {
  canGoBack, canGoForward, currentView, goBack, goForward, initHistory, pushView,
} from "@/lib/history";
import type { History } from "@/lib/history";

export interface Nav<T> {
  view: T;
  go: (view: T) => void;
  back: () => void;
  forward: () => void;
  canBack: boolean;
  canForward: boolean;
}

/** `key` decides what counts as the same place; keep it module-scoped so it stays stable. */
export function useHistory<T>(initial: T, key: (v: T) => string): Nav<T> {
  const [h, setH] = useState<History<T>>(() => initHistory(initial));

  const go = useCallback((view: T) => setH((s) => pushView(s, view, key)), [key]);
  const back = useCallback(() => setH(goBack), []);
  const forward = useCallback(() => setH(goForward), []);

  useMouseNavButtons(back, forward);

  return {
    view: currentView(h),
    go,
    back,
    forward,
    canBack: canGoBack(h),
    canForward: canGoForward(h),
  };
}

/**
 * Chromium hands the side buttons to the page as 3 = back, 4 = forward. Captured at the window
 * so a widget that swallows mousedown can't eat them, and cancelled because the default action
 * is a page-history walk that means nothing in a single-document app.
 */
export function useMouseNavButtons(back: () => void, forward: () => void): void {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      if (e.button === 3) back();
      else forward();
    };
    const swallow = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) e.preventDefault();
    };
    window.addEventListener("mousedown", onDown, { capture: true });
    window.addEventListener("auxclick", swallow, { capture: true });
    return () => {
      window.removeEventListener("mousedown", onDown, { capture: true });
      window.removeEventListener("auxclick", swallow, { capture: true });
    };
  }, [back, forward]);
}
