// Parallel segment prefetch for hls.js.
//
// hls.js loads media fragments strictly one at a time. On a Swarm node where one request runs at a few Mbit/s but
// several requests run side by side, that leaves most of the node's capacity unused and the buffer drains. This
// module gives hls.js a fragment loader (`fLoader`) that, when hls.js asks for fragment N of a level, also starts
// fetching N+1..N+depth of that level into an in-memory cache keyed by URL. When hls.js then asks for one of those,
// it is served from the cache, or joins the fetch that is already running.
//
// - depth 0 turns it off: every load goes to the wrapped base loader unchanged (the old behaviour).
// - The cache is capped (entries and bytes), and work outside the current window is aborted (seek, level switch),
//   so a node that cancels retrievals on client disconnect stops spending effort on it.
// - Stats handed to hls.js carry the real per-request durations (TTFB, load time, bytes), so its ABR and the debug
//   panel see real numbers. For a fragment that finished before hls.js asked for it, the timestamps are shifted to end
//   at delivery, so ABR doesn't count time spent waiting in the cache as download time.
//
// Nothing here depends on the debug panel; `subscribe()` is the hook it logs through.

import type Hls from 'hls.js';
import type {
  Fragment,
  FragmentLoaderConstructor,
  FragmentLoaderContext,
  HlsConfig,
  LevelSwitchingData,
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  LoaderStats,
} from 'hls.js';
import { Events } from 'hls.js';

export const DEFAULT_PREFETCH_DEPTH = 3;
export const MAX_PREFETCH_DEPTH = 8;
export const DEFAULT_MAX_ENTRIES = 8;
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/** The part of an hls.js Fragment the window needs. */
export interface FragLike {
  sn: number | 'initSegment';
  url: string;
  start: number;
  duration: number;
  byteRange?: number[];
}

export function clampDepth(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_PREFETCH_DEPTH;
  return Math.min(Math.max(Math.round(v), 0), MAX_PREFETCH_DEPTH);
}

function indexOfSn(fragments: readonly FragLike[], sn: number): number {
  if (fragments.length === 0) return -1;
  const first = fragments[0].sn;
  if (typeof first === 'number') {
    const guess = sn - first;
    if (guess >= 0 && guess < fragments.length && fragments[guess].sn === sn) return guess;
  }
  return fragments.findIndex((f) => f.sn === sn);
}

/** The fragments after `sn` that should be prefetched: up to `depth` of them, stopping at the end of the list. */
export function prefetchWindow<F extends FragLike>(
  fragments: readonly F[] | undefined,
  sn: number,
  depth: number,
): F[] {
  if (!fragments || depth <= 0) return [];
  const i = indexOfSn(fragments, sn);
  if (i < 0) return [];
  const out: F[] = [];
  for (let j = i + 1; j < fragments.length && out.length < depth; j++) {
    const f = fragments[j];
    // Byte-range fragments share a URL; the cache is keyed by URL, so they are left to hls.js.
    if (typeof f.sn !== 'number' || (f.byteRange && f.byteRange.length)) break;
    out.push(f);
  }
  return out;
}

/** The fragment covering media time `t`, or null. */
export function fragmentAt<F extends FragLike>(fragments: readonly F[] | undefined, t: number): F | null {
  if (!fragments) return null;
  for (const f of fragments) {
    if (typeof f.sn === 'number' && t >= f.start && t < f.start + f.duration) return f;
  }
  return null;
}

export type ClaimKind = 'hit' | 'join' | 'miss';
export type FetchOutcome = 'loaded' | 'error' | 'aborted';

export type PrefetchEvent =
  | {
      type: 'fetch-start';
      url: string;
      sn: number;
      level: number;
      /** Started ahead of hls.js asking for it. */
      speculative: boolean;
      /** performance.now() ms. */
      at: number;
    }
  | {
      type: 'fetch-end';
      url: string;
      sn: number;
      level: number;
      speculative: boolean;
      outcome: FetchOutcome;
      /** Why it was aborted: 'seek', 'level-switch', 'window', 'timeout', 'depth', 'destroy'. */
      reason: string | null;
      startedAt: number;
      firstAt: number | null;
      endAt: number;
      bytes: number;
      httpStatus: number | null;
      error: string | null;
    }
  | { type: 'claim'; url: string; sn: number; level: number; how: ClaimKind };

export interface PrefetchSnapshot {
  depth: number;
  /** Fetches running now (hls.js's own plus prefetches). */
  inFlight: number;
  /** Finished fragments waiting in the cache. */
  cached: number;
  cachedBytes: number;
  hits: number;
  joins: number;
  misses: number;
  /** Prefetches aborted or dropped before hls.js used them. */
  wasted: number;
}

type EntryState = 'loading' | 'done' | 'error';

export interface Entry {
  url: string;
  sn: number;
  level: number;
  speculative: boolean;
  state: EntryState;
  controller: AbortController;
  startedAt: number;
  firstAt: number | null;
  endAt: number | null;
  loaded: number;
  total: number;
  data: ArrayBuffer | null;
  code: number;
  error: { code: number; text: string } | null;
  /** A loader currently waits on this entry. */
  claimed: boolean;
  listeners: Set<() => void>;
}

export type FetchImpl = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export interface PrefetchOptions {
  depth?: number;
  maxEntries?: number;
  maxBytes?: number;
  fetch?: FetchImpl;
  /** Clock in ms, same base as hls.js stats (performance.now()). */
  now?: () => number;
}

class AbortError extends Error {}

export class PrefetchController {
  maxEntries: number;
  maxBytes: number;
  private _depth: number;
  private readonly fetchImpl: FetchImpl;
  readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(e: PrefetchEvent) => void>();
  private getFragments: (level: number) => readonly FragLike[] | undefined = () => undefined;
  private last: { level: number; sn: number } | null = null;
  private avgBytes = 0;
  private counts = { hits: 0, joins: 0, misses: 0, wasted: 0 };

  constructor(opts: PrefetchOptions = {}) {
    this._depth = clampDepth(opts.depth ?? DEFAULT_PREFETCH_DEPTH);
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? (() => performance.now());
  }

  get depth() {
    return this._depth;
  }

  set depth(v: number) {
    this._depth = clampDepth(v);
    if (this._depth === 0) this.evictWhere(() => true, 'depth');
    else if (this.last) this.evictOutside(this.last.level, this.last.sn, this.last.sn + this._depth, 'depth');
  }

  /** Where the fragment lists come from: an hls.js instance's levels. */
  attach(hls: { levels: { details?: { fragments: readonly FragLike[] } }[] }) {
    this.setFragmentSource((level) => hls.levels[level]?.details?.fragments);
  }

  setFragmentSource(fn: (level: number) => readonly FragLike[] | undefined) {
    this.getFragments = fn;
  }

  subscribe(fn: (e: PrefetchEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: PrefetchEvent) {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        // a listener must not break loading
      }
    }
  }

  /** Whether a load goes through the prefetcher (else to the base loader). */
  handles(context: LoaderContext): boolean {
    if (this._depth <= 0) return false;
    const frag = (context as { frag?: Fragment }).frag;
    if (!frag || frag.type !== 'main' || typeof frag.sn !== 'number') return false;
    if ((context as { part?: unknown }).part) return false;
    if (context.rangeEnd || context.rangeStart) return false;
    return context.responseType === 'arraybuffer';
  }

  snapshot(): PrefetchSnapshot {
    let inFlight = 0;
    let cached = 0;
    let cachedBytes = 0;
    for (const e of this.entries.values()) {
      if (e.state === 'loading') inFlight++;
      if (e.state === 'done') {
        cached++;
        cachedBytes += e.loaded;
      }
    }
    return { depth: this._depth, inFlight, cached, cachedBytes, ...this.counts };
  }

  /** hls.js asks for fragment `sn` of `level`: hand back the entry serving it, and fill the window behind it. */
  claim(url: string, sn: number, level: number): { entry: Entry; how: ClaimKind } {
    this.last = { level, sn };
    this.evictOutside(level, sn, sn + this._depth, 'window', url);
    let entry = this.entries.get(url);
    let how: ClaimKind;
    if (entry && entry.state === 'done') {
      how = 'hit';
      this.counts.hits++;
    } else if (entry && entry.state === 'loading') {
      how = 'join';
      this.counts.joins++;
    } else {
      if (entry) this.entries.delete(url);
      how = 'miss';
      this.counts.misses++;
      entry = this.start(url, sn, level, false);
    }
    entry.claimed = true;
    this.emit({ type: 'claim', url, sn, level, how });
    this.fill(level, sn);
    return { entry, how };
  }

  /** The loader is done with the entry (delivered to hls.js): it leaves the cache. */
  consume(entry: Entry) {
    if (this.entries.get(entry.url) === entry) this.entries.delete(entry.url);
  }

  /** The loader let go of the entry without using it (hls.js aborted). It stays in the cache if it is still wanted. */
  release(entry: Entry) {
    entry.claimed = false;
  }

  /** Drop an entry, aborting its fetch (e.g. it timed out, so a retry starts afresh). */
  drop(entry: Entry, reason: string) {
    this.remove(entry, reason);
  }

  /**
   * The playhead moved to `time`; hls.js will next load from `loadFrom` (the end of the buffer there, which is
   * `time` itself when nothing is buffered). Abort what lies outside the new window.
   */
  onSeek(loadFrom: number) {
    if (!this.last) return;
    const { level } = this.last;
    const frag = fragmentAt(this.getFragments(level), loadFrom);
    if (!frag || typeof frag.sn !== 'number') {
      this.evictWhere((e) => !e.claimed, 'seek');
      return;
    }
    // One fragment of slack before: hls.js may back-track to the fragment before for a keyframe.
    this.evictOutside(level, frag.sn - 1, frag.sn + this._depth, 'seek');
  }

  onLevelSwitch(level: number) {
    this.evictWhere((e) => e.level !== level && !e.claimed, 'level-switch');
  }

  destroy() {
    for (const e of [...this.entries.values()]) this.remove(e, 'destroy');
    this.listeners.clear();
  }

  private evictOutside(level: number, lo: number, hi: number, reason: string, keepUrl?: string) {
    this.evictWhere((e) => e.url !== keepUrl && !e.claimed && (e.level !== level || e.sn < lo || e.sn > hi), reason);
  }

  private evictWhere(pred: (e: Entry) => boolean, reason: string) {
    for (const e of [...this.entries.values()]) if (pred(e)) this.remove(e, reason);
  }

  private remove(e: Entry, reason: string) {
    if (this.entries.get(e.url) === e) this.entries.delete(e.url);
    if (e.state === 'loading') {
      e.state = 'error';
      e.error = { code: 0, text: `aborted (${reason})` };
      e.endAt = this.now();
      e.controller.abort();
      if (e.speculative && !e.claimed) this.counts.wasted++;
      this.emitEnd(e, 'aborted', reason);
      this.notify(e);
    } else if (e.state === 'done' && !e.claimed) {
      this.counts.wasted++;
      e.data = null;
    }
  }

  private room(): boolean {
    let count = 0;
    let bytes = 0;
    for (const e of this.entries.values()) {
      if (e.claimed) continue;
      count++;
      bytes += e.state === 'done' ? e.loaded : Math.max(e.loaded, e.total, this.avgBytes);
    }
    return count < this.maxEntries && bytes + this.avgBytes <= this.maxBytes;
  }

  private fill(level: number, sn: number) {
    for (const f of prefetchWindow(this.getFragments(level), sn, this._depth)) {
      if (this.entries.has(f.url)) continue;
      if (!this.room()) break;
      this.start(f.url, f.sn as number, level, true);
    }
  }

  private start(url: string, sn: number, level: number, speculative: boolean): Entry {
    const e: Entry = {
      url,
      sn,
      level,
      speculative,
      state: 'loading',
      controller: new AbortController(),
      startedAt: this.now(),
      firstAt: null,
      endAt: null,
      loaded: 0,
      total: 0,
      data: null,
      code: 0,
      error: null,
      claimed: false,
      listeners: new Set(),
    };
    this.entries.set(url, e);
    this.emit({ type: 'fetch-start', url, sn, level, speculative, at: e.startedAt });
    void this.run(e);
    return e;
  }

  private async run(e: Entry) {
    try {
      const res = await this.fetchImpl(e.url, { signal: e.controller.signal });
      if (e.state !== 'loading') throw new AbortError();
      e.firstAt = Math.max(this.now(), e.startedAt);
      e.code = res.status;
      if (!res.ok) {
        res.body?.cancel().catch(() => undefined);
        throw Object.assign(new Error(res.statusText || `HTTP ${res.status}`), { code: res.status });
      }
      e.total = Number(res.headers.get('content-length')) || 0;
      this.notify(e);
      let data: ArrayBuffer;
      const reader = res.body?.getReader();
      if (reader) {
        const chunks: Uint8Array[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (e.state !== 'loading') {
            reader.cancel().catch(() => undefined);
            throw new AbortError();
          }
          if (done) break;
          chunks.push(value);
          e.loaded += value.byteLength;
          this.notify(e);
        }
        const buf = new Uint8Array(e.loaded);
        let off = 0;
        for (const c of chunks) {
          buf.set(c, off);
          off += c.byteLength;
        }
        data = buf.buffer as ArrayBuffer;
      } else {
        data = await res.arrayBuffer();
        if (e.state !== 'loading') throw new AbortError();
        e.loaded = data.byteLength;
      }
      e.data = data;
      e.total = e.loaded;
      e.endAt = Math.max(this.now(), e.firstAt);
      e.state = 'done';
      this.avgBytes = this.avgBytes ? this.avgBytes * 0.7 + e.loaded * 0.3 : e.loaded;
      this.emitEnd(e, 'loaded', null);
      this.notify(e);
    } catch (err) {
      if (e.state !== 'loading') return; // aborted: remove() already reported it
      e.state = 'error';
      e.endAt = this.now();
      const code = (err as { code?: number }).code ?? 0;
      e.error = { code: typeof code === 'number' ? code : 0, text: err instanceof Error ? err.message : String(err) };
      if (e.speculative && !e.claimed) this.counts.wasted++;
      this.emitEnd(e, 'error', null);
      // A failed prefetch isn't kept: hls.js asking for it starts a fresh fetch.
      if (!e.claimed && this.entries.get(e.url) === e) this.entries.delete(e.url);
      this.notify(e);
    }
  }

  private emitEnd(e: Entry, outcome: FetchOutcome, reason: string | null) {
    this.emit({
      type: 'fetch-end',
      url: e.url,
      sn: e.sn,
      level: e.level,
      speculative: e.speculative,
      outcome,
      reason,
      startedAt: e.startedAt,
      firstAt: e.firstAt,
      endAt: e.endAt ?? this.now(),
      bytes: e.loaded,
      httpStatus: e.code || null,
      error: e.error?.text ?? null,
    });
  }

  private notify(e: Entry) {
    for (const fn of [...e.listeners]) fn();
  }
}

type LoaderClass = new (config: HlsConfig) => Loader<LoaderContext>;

/**
 * An hls.js loader class (for `fLoader`) bound to `controller`. Loads the prefetcher doesn't handle (depth 0,
 * init segments, byte ranges, parts, other fragment types) go to `Base` unchanged.
 */
export function createPrefetchLoader(controller: PrefetchController, Base: LoaderClass): FragmentLoaderConstructor {
  return class PrefetchLoader implements Loader<FragmentLoaderContext> {
    private readonly base: Loader<LoaderContext>;
    stats: LoaderStats;
    context: FragmentLoaderContext | null = null;
    private delegated = false;
    private entry: Entry | null = null;
    private callbacks: LoaderCallbacks<FragmentLoaderContext> | null = null;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private onEntry: (() => void) | null = null;
    private done = false;

    constructor(config: HlsConfig) {
      this.base = new Base(config);
      // hls.js reads `frag.stats = loader.stats` before load(); keep that one object either way.
      this.stats = this.base.stats;
    }

    load(
      context: FragmentLoaderContext,
      config: LoaderConfiguration,
      callbacks: LoaderCallbacks<FragmentLoaderContext>,
    ) {
      if (!controller.handles(context)) {
        this.delegated = true;
        this.base.load(context, config, callbacks as unknown as LoaderCallbacks<LoaderContext>);
        return;
      }
      if (this.stats.loading.start) throw new Error('Loader can only be used once.');
      this.context = context;
      this.callbacks = callbacks;
      const frag = context.frag;
      const claimedAt = controller.now();
      this.stats.loading.start = claimedAt;
      const { entry } = controller.claim(context.url, frag.sn as number, frag.level);
      this.entry = entry;

      const { maxTimeToFirstByteMs, maxLoadTimeMs } = config.loadPolicy;
      const armTimer = (ms: number) => {
        clearTimeout(this.timer);
        if (!Number.isFinite(ms)) return;
        this.timer = setTimeout(() => {
          if (this.done) return;
          this.finish();
          this.stats.aborted = true;
          controller.drop(entry, 'timeout');
          callbacks.onTimeout(this.stats, context, null);
        }, Math.max(0, ms));
      };
      let armedForBody = false;
      const update = () => {
        if (this.done) return;
        const s = this.stats;
        s.loaded = entry.loaded;
        s.total = entry.total;
        if (entry.state === 'loading') {
          // Joined a fetch already running: its real start is the request's start.
          s.loading.start = Math.min(entry.startedAt, claimedAt);
          if (entry.firstAt !== null) {
            s.loading.first = entry.firstAt;
            if (!armedForBody) {
              armedForBody = true;
              armTimer(maxLoadTimeMs - (controller.now() - claimedAt));
            }
          }
          return;
        }
        if (entry.state === 'done' && entry.data && entry.endAt !== null) {
          const deliveredAt = controller.now();
          const shift = Math.max(0, deliveredAt - entry.endAt);
          s.loading.start = entry.startedAt + shift;
          s.loading.first = (entry.firstAt ?? entry.startedAt) + shift;
          s.loading.end = entry.endAt + shift;
          s.loaded = s.total = entry.loaded;
          const data = entry.data;
          entry.data = null;
          this.finish();
          controller.consume(entry);
          const response = { url: context.url, data, code: entry.code || 200 };
          callbacks.onProgress?.(s, context, data, null);
          callbacks.onSuccess(response, s, context, null);
          return;
        }
        // error (or aborted under us)
        s.loading.end = controller.now();
        if (!s.loading.first) s.loading.first = s.loading.end;
        this.finish();
        controller.consume(entry);
        callbacks.onError(entry.error ?? { code: 0, text: 'fetch failed' }, context, null, s);
      };
      this.onEntry = update;
      entry.listeners.add(update);
      armTimer(
        entry.firstAt !== null
          ? maxLoadTimeMs
          : Number.isFinite(maxTimeToFirstByteMs) && maxTimeToFirstByteMs
          ? maxTimeToFirstByteMs
          : maxLoadTimeMs,
      );
      if (entry.firstAt !== null) armedForBody = true;
      // Deliver a cache hit (or apply the state of a joined fetch) asynchronously, as a network load would.
      queueMicrotask(update);
    }

    private finish() {
      this.done = true;
      clearTimeout(this.timer);
      if (this.entry && this.onEntry) this.entry.listeners.delete(this.onEntry);
      this.onEntry = null;
    }

    abort() {
      if (this.delegated) return this.base.abort();
      if (this.done || !this.entry) return;
      this.finish();
      this.stats.aborted = true;
      controller.release(this.entry);
      if (this.context) this.callbacks?.onAbort?.(this.stats, this.context, null);
    }

    destroy() {
      if (this.delegated) return this.base.destroy();
      if (!this.done && this.entry) {
        this.finish();
        controller.release(this.entry);
      }
      this.callbacks = null;
      this.context = null;
      this.base.destroy();
    }

    getCacheAge(): number | null {
      return this.delegated ? this.base.getCacheAge?.() ?? null : null;
    }

    getResponseHeader(name: string): string | null {
      return this.delegated ? this.base.getResponseHeader?.(name) ?? null : null;
    }
  };
}

/**
 * Wire a controller to an hls.js instance and its media element: fragment lists from the levels, eviction on seek
 * (towards where loading resumes, the end of the buffer at the new position) and on level switch. Returns a detach
 * function; call `controller.destroy()` when the player goes away.
 */
export function attachPrefetch(controller: PrefetchController, hls: Hls, media: HTMLMediaElement): () => void {
  controller.attach(hls);
  const onSeeking = () => {
    const t = media.currentTime;
    let loadFrom = t;
    const b = media.buffered;
    for (let i = 0; i < b.length; i++) {
      if (t >= b.start(i) - 0.5 && t <= b.end(i)) loadFrom = b.end(i);
    }
    controller.onSeek(loadFrom);
  };
  const onLevelSwitching = (_e: Events.LEVEL_SWITCHING, d: LevelSwitchingData) => controller.onLevelSwitch(d.level);
  media.addEventListener('seeking', onSeeking);
  hls.on(Events.LEVEL_SWITCHING, onLevelSwitching);
  return () => {
    media.removeEventListener('seeking', onSeeking);
    hls.off(Events.LEVEL_SWITCHING, onLevelSwitching);
  };
}
