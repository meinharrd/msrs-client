// In-memory log behind the debug panel. Nothing here touches the DOM; the panel polls `version`.

import { classifySource, FragStatus, SourceKind } from './stats';

/** True only in builds made with VITE_DEBUG_PANEL=true (see `pnpm build:debug`). */
export const DEBUG_PANEL_ENABLED = import.meta.env.VITE_DEBUG_PANEL === 'true';

export const MAX_LOG_ENTRIES = 2000;

/** performance.now() timestamps → epoch milliseconds. */
export const toEpoch = (perfMs: number) => performance.timeOrigin + perfMs;

export interface FragEntry {
  kind: 'frag';
  id: number;
  session: number;
  /** Epoch ms when FRAG_LOADING fired. */
  at: number;
  sn: number | string;
  level: number;
  fragType: string;
  duration: number;
  url: string;
  ref: string | null;
  source: SourceKind;
  host: string;
  attempt: number;
  status: FragStatus;
  /** Epoch ms of stats.loading.start / first / end. */
  requestStart: number | null;
  firstByte: number | null;
  end: number | null;
  ttfbMs: number | null;
  loadMs: number | null;
  bytes: number | null;
  retries: number;
  aborted: boolean;
  httpStatus: number | null;
  error: string | null;
}

export interface ManifestEntry {
  kind: 'manifest';
  id: number;
  session: number;
  at: number;
  path: string;
  url: string;
  index: string | null;
  durationMs: number | null;
  status: number | null;
  bytes: number | null;
  changed: boolean | null;
  error: string | null;
}

export interface MarkerEntry {
  kind: 'marker';
  id: number;
  session: number;
  at: number;
  text: string;
}

export type LogEntry = FragEntry | ManifestEntry | MarkerEntry;

export interface SessionState {
  id: number;
  /** Epoch ms when the player (hls instance) was created. */
  startedAt: number;
  firstPlayingAt: number | null;
  stalls: number;
  stallTotalMs: number;
  stallStartedAt: number | null;
  currentLevel: number;
  levels: { height?: number; bitrate?: number }[];
  url: string;
}

class DebugLog {
  entries: LogEntry[] = [];
  version = 0;
  session: SessionState | null = null;
  private nextId = 1;
  private sessionCounter = 0;

  private push(entry: LogEntry) {
    this.entries.push(entry);
    if (this.entries.length > MAX_LOG_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_LOG_ENTRIES);
    }
    this.touch();
  }

  touch() {
    this.version++;
  }

  newId() {
    return this.nextId++;
  }

  startSession(url: string): SessionState {
    this.session = {
      id: ++this.sessionCounter,
      startedAt: Date.now(),
      firstPlayingAt: null,
      stalls: 0,
      stallTotalMs: 0,
      stallStartedAt: null,
      currentLevel: -1,
      levels: [],
      url,
    };
    this.marker(`player start: ${url}`);
    return this.session;
  }

  marker(text: string) {
    this.push({ kind: 'marker', id: this.newId(), session: this.session?.id ?? 0, at: Date.now(), text });
  }

  addFrag(fields: Omit<FragEntry, 'kind' | 'id' | 'session' | 'source' | 'host' | 'ref'>): FragEntry {
    const src = classifySource(fields.url);
    const entry: FragEntry = {
      kind: 'frag',
      id: this.newId(),
      session: this.session?.id ?? 0,
      source: src.kind,
      host: src.host,
      ref: src.ref,
      ...fields,
    };
    this.push(entry);
    return entry;
  }

  addManifest(fields: Omit<ManifestEntry, 'kind' | 'id' | 'session'>): ManifestEntry {
    const entry: ManifestEntry = { kind: 'manifest', id: this.newId(), session: this.session?.id ?? 0, ...fields };
    this.push(entry);
    return entry;
  }

  clear() {
    this.entries = [];
    if (this.session) {
      this.session.stalls = 0;
      this.session.stallTotalMs = 0;
    }
    this.touch();
  }

  /** Full-detail export for "Copy log" / "Download log". */
  toJSON() {
    const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);
    return {
      exportedAt: new Date().toISOString(),
      build: {
        commit: import.meta.env.VITE_GIT_COMMIT ?? 'unknown',
        debug: DEBUG_PANEL_ENABLED,
      },
      page: {
        href: typeof window !== 'undefined' ? window.location.href : '',
        protocol: typeof window !== 'undefined' ? window.location.protocol : '',
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
        timeOrigin: iso(performance.timeOrigin),
      },
      session: this.session
        ? {
            ...this.session,
            startedAtIso: iso(this.session.startedAt),
            firstPlayingAtIso: iso(this.session.firstPlayingAt),
          }
        : null,
      maxEntries: MAX_LOG_ENTRIES,
      entries: this.entries.map((e) => ({
        ...e,
        atIso: iso(e.at),
        ...(e.kind === 'frag'
          ? { requestStartIso: iso(e.requestStart), firstByteIso: iso(e.firstByte), endIso: iso(e.end) }
          : {}),
      })),
    };
  }
}

export const debugLog = new DebugLog();

// ---- Playlist instrumentation, called from ManifestFetcher (no-ops unless the debug build is on) ----

const manifestEntryByResponse = new WeakMap<Response, ManifestEntry>();

/** Record one playlist request made by ManifestFetcher.fetchResource. */
export function traceManifestFetch(
  url: string,
  path: string,
  startedAt: number,
  result: { response?: Response; error?: unknown; index?: string | null },
) {
  if (!DEBUG_PANEL_ENABLED) return;
  try {
    const { response, error } = result;
    const headerIndex = response?.headers?.get?.('Swarm-Feed-Index') ?? null;
    const entry = debugLog.addManifest({
      at: Date.now(),
      path,
      url,
      index: result.index ?? (headerIndex ? BigInt(`0x${headerIndex}`).toString() : null),
      durationMs: performance.now() - startedAt,
      status: response ? response.status : null,
      bytes: null,
      changed: null,
      error: error ? (error instanceof Error ? error.message : String(error)) : null,
    });
    if (response) manifestEntryByResponse.set(response, entry);
  } catch {
    // never let instrumentation break playback
  }
}

/** Fill in size and whether the stored playlist changed once the body has been applied. */
export function traceManifestApplied(response: Response, manifest: string, changed: boolean) {
  if (!DEBUG_PANEL_ENABLED) return;
  const entry = manifestEntryByResponse.get(response);
  if (!entry) return;
  entry.bytes = manifest.length;
  entry.changed = changed;
  debugLog.touch();
}
