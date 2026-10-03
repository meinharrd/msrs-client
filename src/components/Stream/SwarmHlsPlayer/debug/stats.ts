// Pure helpers for the debug panel: classification of segment URLs and the summary maths.

import { refFromVirtualBzzHost } from '../browserNode';

export type SourceKind = 'bzz' | 'gateway' | 'other';

export interface SourceInfo {
  kind: SourceKind;
  /** Gateway host for https URLs, empty for bzz. */
  host: string;
  /** Full Swarm reference found in the URL, if any. */
  ref: string | null;
}

const BZZ_REF = /^bzz:\/\/([0-9a-f]{64}(?:[0-9a-f]{64})?)/i;
const BYTES_REF = /\/(?:bytes|bzz)\/([0-9a-f]{64}(?:[0-9a-f]{64})?)/i;

/** Tell a segment served by the browser's own node (`bzz://<ref>/`) from one fetched off a gateway. */
export function classifySource(url: string): SourceInfo {
  const bzz = BZZ_REF.exec(url);
  if (bzz) return { kind: 'bzz', host: '', ref: bzz[1].toLowerCase() };

  const bytes = BYTES_REF.exec(url);
  const ref = bytes ? bytes[1].toLowerCase() : null;
  try {
    const parsed = new URL(url);
    const virtualRef = refFromVirtualBzzHost(parsed.hostname);
    if (virtualRef) return { kind: 'bzz', host: 'freedom virtual origin', ref: virtualRef };
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return { kind: 'gateway', host: parsed.host, ref };
    }
  } catch {
    // not an absolute URL
  }
  return { kind: 'other', host: '', ref };
}

export function shortRef(ref: string | null | undefined): string {
  return ref ? ref.slice(0, 8) : '-';
}

/** Linear-interpolated percentile (p in 0..100) of the finite values; null when there are none. */
export function percentile(values: number[], p: number): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (Math.min(Math.max(p, 0), 100) / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

export function median(values: number[]): number | null {
  return percentile(values, 50);
}

/** Mbit/s for `bytes` moved in `ms`; null when either is missing or zero. */
export function throughputMbps(bytes: number | null | undefined, ms: number | null | undefined): number | null {
  if (!bytes || !ms || ms <= 0) return null;
  return (bytes * 8) / (ms * 1000);
}

export type FragStatus = 'loading' | 'loaded' | 'error' | 'aborted';

/** The subset of a segment row the summary needs. */
export interface FragSample {
  status: FragStatus;
  ttfbMs: number | null;
  loadMs: number | null;
  bytes: number | null;
}

export interface FragSummary {
  loaded: number;
  failed: number;
  aborted: number;
  inFlight: number;
  ttfbMedian: number | null;
  ttfbP90: number | null;
  loadMedian: number | null;
  loadP90: number | null;
  /** Aggregate throughput: all bytes over all load time of completed segments. */
  avgMbps: number | null;
  totalBytes: number;
}

export function summarizeFrags(frags: FragSample[]): FragSummary {
  const done = frags.filter((f) => f.status === 'loaded');
  const ttfb = done.map((f) => f.ttfbMs).filter((v): v is number => v !== null);
  const load = done.map((f) => f.loadMs).filter((v): v is number => v !== null);
  let totalBytes = 0;
  let totalMs = 0;
  for (const f of done) {
    if (f.bytes && f.loadMs && f.loadMs > 0) {
      totalBytes += f.bytes;
      totalMs += f.loadMs;
    }
  }
  return {
    loaded: done.length,
    failed: frags.filter((f) => f.status === 'error').length,
    aborted: frags.filter((f) => f.status === 'aborted').length,
    inFlight: frags.filter((f) => f.status === 'loading').length,
    ttfbMedian: median(ttfb),
    ttfbP90: percentile(ttfb, 90),
    loadMedian: median(load),
    loadP90: percentile(load, 90),
    avgMbps: throughputMbps(totalBytes, totalMs),
    totalBytes,
  };
}

/** Seconds of media buffered ahead of `time`, from a TimeRanges-like object. */
export function bufferedAhead(
  buffered: { length: number; start(i: number): number; end(i: number): number },
  time: number,
) {
  for (let i = 0; i < buffered.length; i++) {
    if (time >= buffered.start(i) - 0.5 && time <= buffered.end(i)) {
      return Math.max(0, buffered.end(i) - time);
    }
  }
  return 0;
}
