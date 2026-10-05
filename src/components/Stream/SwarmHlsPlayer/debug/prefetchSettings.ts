// Debug build: the prefetch depth chosen in the panel (kept in localStorage), and the running player's prefetcher.

import { clampDepth, DEFAULT_PREFETCH_DEPTH, PrefetchController } from '../prefetchLoader';

const DEPTH_KEY = 'msrs-debug-prefetch-depth';

function loadDepth(): number {
  try {
    const raw = localStorage.getItem(DEPTH_KEY);
    if (raw !== null && raw !== '') return clampDepth(Number(raw));
  } catch {
    // storage unavailable
  }
  return DEFAULT_PREFETCH_DEPTH;
}

class PrefetchSettings {
  depth = loadDepth();
  /** The prefetcher of the player on the page, if any. */
  current: PrefetchController | null = null;

  setDepth(v: number) {
    this.depth = clampDepth(v);
    try {
      localStorage.setItem(DEPTH_KEY, String(this.depth));
    } catch {
      // storage unavailable
    }
    if (this.current) this.current.depth = this.depth;
  }
}

export const prefetchSettings = new PrefetchSettings();
