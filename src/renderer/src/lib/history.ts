// The shell's history stack. There is no router — the whole app is one view object — so
// back/forward is ours to model. Kept free of the DOM so the node suite can exercise it.

export interface History<T> {
  entries: T[];
  index: number;
}

// a long session shouldn't grow the stack without limit; the oldest entries fall off the back
const MAX_ENTRIES = 50;

export const initHistory = <T>(view: T): History<T> => ({ entries: [view], index: 0 });

export const currentView = <T>(h: History<T>): T => h.entries[h.index]!;

export const canGoBack = <T>(h: History<T>): boolean => h.index > 0;
export const canGoForward = <T>(h: History<T>): boolean => h.index < h.entries.length - 1;

/** Push, discarding anything forward of here. Re-selecting the current screen is not a move. */
export function pushView<T>(h: History<T>, view: T, key: (v: T) => string): History<T> {
  if (key(currentView(h)) === key(view)) return h;
  const entries = [...h.entries.slice(0, h.index + 1), view];
  const dropped = Math.max(0, entries.length - MAX_ENTRIES);
  return { entries: entries.slice(dropped), index: entries.length - dropped - 1 };
}

export const goBack = <T>(h: History<T>): History<T> =>
  canGoBack(h) ? { ...h, index: h.index - 1 } : h;

export const goForward = <T>(h: History<T>): History<T> =>
  canGoForward(h) ? { ...h, index: h.index + 1 } : h;
