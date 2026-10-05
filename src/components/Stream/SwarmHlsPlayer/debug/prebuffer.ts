// Debug build only: hold playback until enough media is buffered ahead (start, after a seek, after a stall).
// The decision is a pure function so it can be unit-tested; prebufferGate.ts applies it to a <video>.

export type PrebufferReason = 'start' | 'seek' | 'stall' | 'play';

export type PrebufferOutcome =
  /** Buffered ahead reached the target. */
  | 'target'
  /** The buffer reaches the end of the media (VOD) or the live edge, so it can't grow to the target. */
  | 'end'
  | 'timeout'
  /** Pre-buffering is switched off (target 0). */
  | 'off'
  /** The user paused while it was held; it stays paused and is not resumed. */
  | 'user-paused'
  /** Someone else changed the playback rate while it was held. */
  | 'overridden'
  /** A new wait (e.g. a seek) replaced this one. */
  | 'superseded';

export interface PrebufferInput {
  /** Seconds to have buffered ahead before playing; 0 = off. */
  targetSec: number;
  /** Seconds buffered ahead of the playhead, in the range that contains it. */
  bufferedAhead: number;
  currentTime: number;
  /**
   * Where the media ends: the duration for a VOD, the live edge (end of the seekable range) for live.
   * NaN / Infinity / null when unknown.
   */
  mediaEnd: number | null;
  /** How long this wait has lasted so far. */
  waitedMs: number;
  /** Hard cap on a wait. */
  timeoutMs: number;
  /** The user paused the media themselves. */
  userPaused: boolean;
}

export type PrebufferDecision = { hold: true } | { hold: false; outcome: PrebufferOutcome };

export const DEFAULT_TARGET_SEC = 6;
export const MAX_TARGET_SEC = 20;
export const DEFAULT_TIMEOUT_MS = 30_000;
/** A buffer within this distance of the media end counts as reaching it (segment rounding). */
export const END_SLACK_SEC = 0.5;

/** Keep holding, or let playback go (and why). */
export function prebufferDecision(input: PrebufferInput): PrebufferDecision {
  const { targetSec, bufferedAhead, currentTime, mediaEnd, waitedMs, timeoutMs, userPaused } = input;
  if (userPaused) return { hold: false, outcome: 'user-paused' };
  if (!(targetSec > 0)) return { hold: false, outcome: 'off' };
  if (bufferedAhead >= targetSec) return { hold: false, outcome: 'target' };
  if (mediaEnd !== null && Number.isFinite(mediaEnd) && currentTime + bufferedAhead >= mediaEnd - END_SLACK_SEC) {
    return { hold: false, outcome: 'end' };
  }
  if (waitedMs >= timeoutMs) return { hold: false, outcome: 'timeout' };
  return { hold: true };
}

/** Whether a new wait should start at all for this trigger (no point holding if it would release at once). */
export function shouldStartWait(input: Omit<PrebufferInput, 'waitedMs' | 'timeoutMs'>): boolean {
  return prebufferDecision({ ...input, waitedMs: 0, timeoutMs: Infinity }).hold;
}

export function clampTarget(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_TARGET_SEC;
  return Math.min(Math.max(Math.round(v), 0), MAX_TARGET_SEC);
}

/** Scale for the buffer bar: max(target × 2, 20 s). */
export function bufferBarMax(targetSec: number): number {
  return Math.max(targetSec * 2, 20);
}

export type BufferLevel = 'low' | 'under-target' | 'ok';

/** Red under 2 s, amber under the target, green at or above it. */
export function bufferLevel(ahead: number, targetSec: number): BufferLevel {
  if (ahead < 2) return 'low';
  if (ahead < targetSec) return 'under-target';
  return 'ok';
}

// ---- Shared state between the gate (player side) and the panel ----

const TARGET_KEY = 'msrs-debug-prebuffer-target';

export interface PrebufferWait {
  reason: PrebufferReason;
  startedAt: number;
  endedAt: number | null;
  /** Media time the wait is for. */
  at: number;
  /** Buffered ahead when the wait ended (or now, while it runs). */
  bufferReached: number;
  target: number;
  outcome: PrebufferOutcome | null;
}

export interface BufferSample {
  /** Epoch ms. */
  t: number;
  ahead: number;
  /** Playback stalled (not held by the gate). */
  stalled: boolean;
  /** Held by the pre-buffer gate. */
  held: boolean;
}

/** About 120 s of samples at 4/s. */
export const MAX_SAMPLES = 480;

class PrebufferStore {
  targetSec = loadTarget();
  active: PrebufferWait | null = null;
  waits: PrebufferWait[] = [];
  samples: BufferSample[] = [];
  /** Latest buffered-ahead reading, for the panel. */
  ahead = 0;

  setTarget(v: number) {
    this.targetSec = clampTarget(v);
    try {
      localStorage.setItem(TARGET_KEY, String(this.targetSec));
    } catch {
      // storage unavailable
    }
  }

  sample(s: BufferSample) {
    this.ahead = s.ahead;
    this.samples.push(s);
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);
  }

  /** Total completed waits and their total time, in ms (plus the running one). */
  totals(now = Date.now()) {
    let ms = 0;
    for (const w of this.waits) ms += (w.endedAt ?? now) - w.startedAt;
    if (this.active) ms += now - this.active.startedAt;
    return { count: this.waits.length + (this.active ? 1 : 0), ms };
  }

  reset() {
    this.active = null;
    this.waits = [];
    this.samples = [];
    this.ahead = 0;
  }
}

function loadTarget(): number {
  try {
    const raw = localStorage.getItem(TARGET_KEY);
    if (raw !== null && raw !== '') return clampTarget(Number(raw));
  } catch {
    // storage unavailable
  }
  return DEFAULT_TARGET_SEC;
}

export const prebuffer = new PrebufferStore();
