// Settle-then-load while the user scrubs.
//
// Dragging the seek bar fires a `seeking` event every few ms (81 in ~1 s on Android). hls.js starts loading the
// target fragment for each one and aborts it on the next, and the prefetcher adds its window on top: hundreds of
// requests in a second, which a node that doesn't cancel retrievals on disconnect keeps queued for tens of seconds.
//
// A single seek (a tap on the bar, a keyboard jump) loads at once, as before. A second seek within SCRUB_SETTLE_MS of
// the previous one makes it a scrub: loading stops (hls.stopLoad() and the prefetcher's work is aborted) and resumes
// with hls.startLoad(currentTime) only once no seek came for SCRUB_SETTLE_MS.
//
//   idle --seek--> armed (loading normally) --seek within settleMs--> scrubbing (stopped) --quiet settleMs--> idle
//                  armed --quiet settleMs--> idle                     scrubbing --seek--> scrubbing (timer re-armed)

export const SCRUB_SETTLE_MS = 300;

export type ScrubState = 'idle' | 'armed' | 'scrubbing';

export interface ScrubSettleHooks {
  /** A second seek in quick succession: stop loading. Called once per scrub. */
  onScrubStart: () => void;
  /** Every further seek of a scrub (loading is already stopped; abort anything that started anyway). */
  onScrubSeek?: () => void;
  /** No seek for settleMs after a scrub: load from where the playhead is. */
  onSettle: (seeks: number, durationMs: number) => void;
}

export type ScrubEvent =
  | { type: 'seek'; state: ScrubState; seeks: number }
  | { type: 'settle'; seeks: number; durationMs: number };

export interface ScrubSettleOptions {
  settleMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class ScrubSettle {
  private _state: ScrubState = 'idle';
  private seeks = 0;
  private startedAt = 0;
  private timer: unknown = null;
  private readonly listeners = new Set<(e: ScrubEvent) => void>();
  private readonly settleMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly hooks: ScrubSettleHooks, opts: ScrubSettleOptions = {}) {
    this.settleMs = opts.settleMs ?? SCRUB_SETTLE_MS;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get state(): ScrubState {
    return this._state;
  }

  /** Seeks so far in the current single seek / scrub (0 when idle). */
  get seekCount(): number {
    return this._state === 'idle' ? 0 : this.seeks;
  }

  /** After each seek (with the state it put the machine in) and on settle. For the debug panel. */
  subscribe(fn: (e: ScrubEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: ScrubEvent) {
    for (const fn of this.listeners) fn(e);
  }

  /** A real seek (not one of hls.js's own playhead moves). */
  seek() {
    if (this._state === 'idle') {
      this._state = 'armed';
      this.seeks = 1;
      this.startedAt = this.now();
    } else if (this._state === 'armed') {
      this._state = 'scrubbing';
      this.seeks++;
      this.hooks.onScrubStart();
    } else {
      this.seeks++;
      this.hooks.onScrubSeek?.();
    }
    this.arm();
    this.emit({ type: 'seek', state: this._state, seeks: this.seeks });
  }

  destroy() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this._state = 'idle';
    this.listeners.clear();
  }

  private arm() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => this.quiet(), this.settleMs);
  }

  private quiet() {
    this.timer = null;
    const wasScrubbing = this._state === 'scrubbing';
    const seeks = this.seeks;
    this._state = 'idle';
    this.seeks = 0;
    if (!wasScrubbing) return;
    const durationMs = this.now() - this.startedAt;
    this.hooks.onSettle(seeks, durationMs);
    this.emit({ type: 'settle', seeks, durationMs });
  }
}
