import type {
  FragmentLoaderContext,
  HlsConfig,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  LoaderStats,
} from 'hls.js';
import { describe, expect, it, vi } from 'vitest';

import {
  clampDepth,
  createPrefetchLoader,
  FragLike,
  fragmentAt,
  PrefetchController,
  PrefetchEvent,
  prefetchWindow,
} from './prefetchLoader';

const frags = (n: number, firstSn = 0, level = 0): FragLike[] =>
  Array.from({ length: n }, (_, i) => ({
    sn: firstSn + i,
    url: `https://seg/${level}/${firstSn + i}`,
    start: i * 2,
    duration: 2,
  }));

describe('prefetchWindow', () => {
  const list = frags(10, 100);
  it('returns the next depth fragments', () => {
    expect(prefetchWindow(list, 102, 3).map((f) => f.sn)).toEqual([103, 104, 105]);
  });
  it('stops at the end of the list', () => {
    expect(prefetchWindow(list, 107, 5).map((f) => f.sn)).toEqual([108, 109]);
    expect(prefetchWindow(list, 109, 3)).toEqual([]);
  });
  it('is empty for depth 0, an unknown sn, or no list', () => {
    expect(prefetchWindow(list, 102, 0)).toEqual([]);
    expect(prefetchWindow(list, 5, 3)).toEqual([]);
    expect(prefetchWindow(undefined, 102, 3)).toEqual([]);
  });
  it('stops at byte-range fragments', () => {
    const l = frags(5);
    l[2] = { ...l[2], byteRange: [0, 100] };
    expect(prefetchWindow(l, 0, 4).map((f) => f.sn)).toEqual([1]);
  });
  it('finds the fragment at a time', () => {
    expect(fragmentAt(list, 5.5)?.sn).toBe(102);
    expect(fragmentAt(list, 99)).toBeNull();
  });
  it('clamps depth to 0..8', () => {
    expect(clampDepth(-1)).toBe(0);
    expect(clampDepth(20)).toBe(8);
    expect(clampDepth(NaN)).toBe(3);
  });
});

// ---- A fake network: each fetch waits until the test responds or the signal aborts it ----

interface Call {
  url: string;
  signal: AbortSignal;
  respond: (bytes: number, status?: number) => void;
}

function fakeResponse(bytes: number, status: number) {
  return {
    ok: status < 400,
    status,
    statusText: '',
    headers: { get: (h: string) => (h === 'content-length' ? String(bytes) : null) },
    body: {
      cancel: async () => undefined,
      getReader() {
        let sent = false;
        return {
          read: async () =>
            sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: new Uint8Array(bytes) }),
          cancel: async () => undefined,
        };
      },
    },
  } as unknown as Response;
}

function setup(opts: { depth?: number; maxEntries?: number; maxBytes?: number; levels?: number } = {}) {
  const calls: Call[] = [];
  let t = 1000;
  const clock = {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
  const fetchImpl = (url: string, { signal }: { signal: AbortSignal }) =>
    new Promise<Response>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
      calls.push({ url, signal, respond: (bytes, status = 200) => resolve(fakeResponse(bytes, status)) });
    });
  const ctl = new PrefetchController({ ...opts, fetch: fetchImpl, now: clock.now });
  const lists = Array.from({ length: opts.levels ?? 2 }, (_, lvl) => frags(20, 0, lvl));
  ctl.setFragmentSource((lvl) => lists[lvl]);
  const events: PrefetchEvent[] = [];
  ctl.subscribe((e) => events.push(e));
  const call = (url: string) => {
    const c = calls.find((x) => x.url === url && !x.signal.aborted);
    if (!c) throw new Error(`no live fetch for ${url}`);
    return c;
  };
  return { ctl, calls, clock, events, call, lists };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const url = (sn: number, level = 0) => `https://seg/${level}/${sn}`;

function newStats(): LoaderStats {
  return {
    aborted: false,
    loaded: 0,
    retry: 0,
    total: 0,
    chunkCount: 0,
    bwEstimate: 0,
    loading: { start: 0, first: 0, end: 0 },
    parsing: { start: 0, end: 0 },
    buffering: { start: 0, first: 0, end: 0 },
  };
}

class FakeBase {
  stats = newStats();
  context = null;
  static loads: string[] = [];
  load(ctx: LoaderContext) {
    FakeBase.loads.push(ctx.url);
  }
  abort() {}
  destroy() {}
}

const loaderConfig = (ttfbMs = 10_000, loadMs = 60_000) =>
  ({
    loadPolicy: { maxTimeToFirstByteMs: ttfbMs, maxLoadTimeMs: loadMs, timeoutRetry: null, errorRetry: null },
    timeout: ttfbMs,
    maxRetry: 0,
    retryDelay: 0,
    maxRetryDelay: 0,
  } as unknown as LoaderConfiguration);

function fragContext(sn: number, level = 0, extra: Record<string, unknown> = {}) {
  return {
    url: url(sn, level),
    frag: { type: 'main', sn, level },
    responseType: 'arraybuffer',
    ...extra,
  } as unknown as FragmentLoaderContext;
}

function callbacks() {
  return {
    onSuccess: vi.fn(),
    onError: vi.fn(),
    onTimeout: vi.fn(),
    onAbort: vi.fn(),
  } satisfies Partial<LoaderCallbacks<LoaderContext>> as unknown as LoaderCallbacks<LoaderContext> & {
    onSuccess: ReturnType<typeof vi.fn>;
    onError: ReturnType<typeof vi.fn>;
    onTimeout: ReturnType<typeof vi.fn>;
    onAbort: ReturnType<typeof vi.fn>;
  };
}

function load(ctl: PrefetchController, sn: number, level = 0, cfg = loaderConfig()) {
  const Loader = createPrefetchLoader(ctl, FakeBase as never);
  const loader = new Loader({} as HlsConfig);
  const cb = callbacks();
  loader.load(fragContext(sn, level), cfg, cb);
  return { loader, cb };
}

describe('PrefetchController + loader', () => {
  it('fetches the requested fragment and the next depth fragments in parallel', () => {
    const { ctl, calls } = setup({ depth: 3 });
    load(ctl, 4);
    expect(calls.map((c) => c.url)).toEqual([url(4), url(5), url(6), url(7)]);
    expect(ctl.snapshot().inFlight).toBe(4);
  });

  it('serves a prefetched fragment from the cache, with real durations ending at delivery', async () => {
    const { ctl, call, clock, events } = setup({ depth: 2 });
    const first = load(ctl, 0);
    clock.advance(300);
    call(url(1)).respond(1000); // prefetch of sn 1: headers at +300, done at +300
    call(url(0)).respond(1000);
    await flush();
    expect(first.cb.onSuccess).toHaveBeenCalledTimes(1);
    expect(ctl.snapshot().cached).toBe(1);

    clock.advance(5000); // hls.js asks for sn 1 five seconds later
    const second = load(ctl, 1);
    await flush();
    expect(second.cb.onSuccess).toHaveBeenCalledTimes(1);
    const [resp, stats] = second.cb.onSuccess.mock.calls[0];
    expect(resp.data.byteLength).toBe(1000);
    expect(stats.loaded).toBe(1000);
    expect(stats.loading.end).toBe(clock.now()); // shifted to delivery
    expect(stats.loading.end - stats.loading.start).toBe(300); // real load time
    expect(events.some((e) => e.type === 'claim' && e.how === 'hit' && e.url === url(1))).toBe(true);
    expect(ctl.snapshot().hits).toBe(1);
  });

  it('joins a prefetch that is still running instead of fetching again', async () => {
    const { ctl, calls, call, clock } = setup({ depth: 2 });
    load(ctl, 0);
    clock.advance(100);
    const second = load(ctl, 1); // sn 1 is in flight as a prefetch
    expect(calls.filter((c) => c.url === url(1))).toHaveLength(1);
    expect(ctl.snapshot().joins).toBe(1);
    clock.advance(400);
    call(url(1)).respond(2000);
    await flush();
    const [, stats] = second.cb.onSuccess.mock.calls[0];
    expect(stats.loading.start).toBe(1000); // when the prefetch started, before hls.js asked
    expect(stats.loading.end).toBe(1500);
  });

  it('aborts prefetches outside the window after a seek, and keeps those inside', () => {
    const { ctl, call, calls } = setup({ depth: 3 });
    load(ctl, 0); // 0 + 1,2,3
    const s1 = call(url(1)).signal;
    const s3 = call(url(3)).signal;
    ctl.onSeek(6.5); // sn 3 → window [2, 6]
    expect(s1.aborted).toBe(true);
    expect(s3.aborted).toBe(false);
    // the fragment hls.js itself is loading (claimed) is never evicted
    expect(calls.find((c) => c.url === url(0))!.signal.aborted).toBe(false);
    load(ctl, 10); // seek far: hls.js asks for sn 10
    expect(s3.aborted).toBe(true);
  });

  it('evicts the other level on a level switch', () => {
    const { ctl, call } = setup({ depth: 2 });
    const { loader } = load(ctl, 0, 0);
    const s0 = call(url(0, 0)).signal;
    const s1 = call(url(1, 0)).signal;
    loader.abort();
    ctl.onLevelSwitch(1);
    expect(s1.aborted).toBe(true);
    expect(s0.aborted).toBe(true); // released by the abort, then evicted
  });

  it('keeps an aborted request running into the cache and serves it later', async () => {
    const { ctl, call } = setup({ depth: 1 });
    const a = load(ctl, 0);
    a.loader.abort(); // e.g. pause → stopLoad
    expect(a.cb.onAbort).toHaveBeenCalled();
    call(url(0)).respond(500);
    await flush();
    const b = load(ctl, 0);
    await flush();
    expect(b.cb.onSuccess).toHaveBeenCalledTimes(1);
    expect(a.cb.onSuccess).not.toHaveBeenCalled();
  });

  it('respects the cache cap in entries and bytes', async () => {
    const byCount = setup({ depth: 8, maxEntries: 2 });
    load(byCount.ctl, 0);
    expect(byCount.calls.map((c) => c.url)).toEqual([url(0), url(1), url(2)]);

    const byBytes = setup({ depth: 8, maxBytes: 2500 });
    const first = load(byBytes.ctl, 0);
    // Learn the segment size (1000) from the first fetches, then cache two of them.
    byBytes.call(url(0)).respond(1000);
    byBytes.call(url(1)).respond(1000);
    byBytes.call(url(2)).respond(1000);
    await flush();
    expect(first.cb.onSuccess).toHaveBeenCalled();
    const before = byBytes.calls.length;
    load(byBytes.ctl, 1); // hit; cache holds sn 2 (1000) + new ones only while under 2500 bytes
    const started = byBytes.calls.slice(before).map((c) => c.url);
    expect(started.length).toBeLessThanOrEqual(1);
  });

  it('times out a stuck fetch, aborting it so the retry starts afresh', async () => {
    const { ctl, calls } = setup({ depth: 1 });
    const { cb } = load(ctl, 0, 0, loaderConfig(20, 100));
    await new Promise((r) => setTimeout(r, 40));
    expect(cb.onTimeout).toHaveBeenCalledTimes(1);
    expect(calls[0].signal.aborted).toBe(true);
    load(ctl, 0);
    expect(calls.filter((c) => c.url === url(0))).toHaveLength(2);
  });

  it('reports HTTP errors to hls.js and does not cache them', async () => {
    const { ctl, call, calls } = setup({ depth: 1 });
    const { cb } = load(ctl, 0);
    call(url(1)).respond(0, 500); // the prefetch fails
    call(url(0)).respond(0, 404);
    await flush();
    expect(cb.onError).toHaveBeenCalledTimes(1);
    expect(cb.onError.mock.calls[0][0].code).toBe(404);
    load(ctl, 1); // failed prefetch is refetched
    expect(calls.filter((c) => c.url === url(1))).toHaveLength(2);
  });

  it('depth 0 hands every load to the base loader (old behaviour)', () => {
    const { ctl, calls } = setup({ depth: 0 });
    FakeBase.loads = [];
    load(ctl, 3);
    expect(FakeBase.loads).toEqual([url(3)]);
    expect(calls).toHaveLength(0);
  });

  it('lowering depth to 0 aborts outstanding prefetches', () => {
    const { ctl, call } = setup({ depth: 3 });
    load(ctl, 0);
    const s2 = call(url(2)).signal;
    ctl.depth = 0;
    expect(s2.aborted).toBe(true);
    expect(ctl.snapshot().wasted).toBeGreaterThan(0);
  });

  it('leaves byte-range and non-main loads to the base loader', () => {
    const { ctl, calls } = setup({ depth: 3 });
    FakeBase.loads = [];
    const Loader = createPrefetchLoader(ctl, FakeBase as never);
    new Loader({} as HlsConfig).load(fragContext(0, 0, { rangeEnd: 100 }), loaderConfig(), callbacks());
    new Loader({} as HlsConfig).load(
      {
        url: 'x',
        frag: { type: 'audio', sn: 0, level: 0 },
        responseType: 'arraybuffer',
      } as unknown as FragmentLoaderContext,
      loaderConfig(),
      callbacks(),
    );
    expect(FakeBase.loads).toHaveLength(2);
    expect(calls).toHaveLength(0);
  });
});
