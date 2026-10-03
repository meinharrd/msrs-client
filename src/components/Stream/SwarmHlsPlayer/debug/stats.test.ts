import { describe, expect, it } from 'vitest';

import { bufferedAhead, classifySource, median, percentile, shortRef, summarizeFrags, throughputMbps } from './stats';

const REF = 'ab'.repeat(32);
const ENC_REF = 'cd'.repeat(64);

describe('percentile / median', () => {
  it('returns null for no values', () => {
    expect(median([])).toBeNull();
    expect(percentile([NaN], 90)).toBeNull();
  });

  it('handles a single value', () => {
    expect(median([42])).toBe(42);
    expect(percentile([42], 90)).toBe(42);
  });

  it('takes the middle of odd and even sets regardless of order', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('interpolates p90 between ranks', () => {
    const values = Array.from({ length: 10 }, (_, i) => (i + 1) * 100); // 100..1000
    expect(percentile(values, 90)).toBeCloseTo(910);
    expect(percentile(values, 0)).toBe(100);
    expect(percentile(values, 100)).toBe(1000);
  });
});

describe('throughputMbps', () => {
  it('converts bytes over milliseconds into Mbit/s', () => {
    expect(throughputMbps(1_000_000, 1000)).toBeCloseTo(8);
  });

  it('is null without bytes or time', () => {
    expect(throughputMbps(0, 100)).toBeNull();
    expect(throughputMbps(100, 0)).toBeNull();
    expect(throughputMbps(null, null)).toBeNull();
  });
});

describe('classifySource', () => {
  it('recognises a segment served by the local node over bzz://', () => {
    expect(classifySource(`bzz://${REF}/`)).toEqual({ kind: 'bzz', host: '', ref: REF });
  });

  it('keeps encrypted (128 hex) references whole', () => {
    expect(classifySource(`bzz://${ENC_REF}/`).ref).toBe(ENC_REF);
  });

  it('recognises a gateway /bytes/ URL and its host', () => {
    expect(classifySource(`https://swarm.beebridge.buzz/bytes/${REF.toUpperCase()}`)).toEqual({
      kind: 'gateway',
      host: 'swarm.beebridge.buzz',
      ref: REF,
    });
  });

  it('falls back to other for relative or odd URLs', () => {
    expect(classifySource('segment0.ts')).toEqual({ kind: 'other', host: '', ref: null });
  });

  it('shortens refs to 8 hex', () => {
    expect(shortRef(REF)).toBe('abababab');
    expect(shortRef(null)).toBe('-');
  });
});

describe('summarizeFrags', () => {
  it('counts states and aggregates timing over completed loads only', () => {
    const summary = summarizeFrags([
      { status: 'loaded', ttfbMs: 100, loadMs: 1000, bytes: 1_000_000 },
      { status: 'loaded', ttfbMs: 300, loadMs: 3000, bytes: 1_000_000 },
      { status: 'loaded', ttfbMs: 200, loadMs: 2000, bytes: 1_000_000 },
      { status: 'error', ttfbMs: 9999, loadMs: 9999, bytes: null },
      { status: 'aborted', ttfbMs: null, loadMs: null, bytes: null },
      { status: 'loading', ttfbMs: null, loadMs: null, bytes: null },
    ]);
    expect(summary).toMatchObject({ loaded: 3, failed: 1, aborted: 1, inFlight: 1, totalBytes: 3_000_000 });
    expect(summary.ttfbMedian).toBe(200);
    expect(summary.ttfbP90).toBeCloseTo(280);
    expect(summary.loadMedian).toBe(2000);
    expect(summary.avgMbps).toBeCloseTo(4); // 24 Mbit over 6 s
  });
});

describe('bufferedAhead', () => {
  const ranges = (pairs: [number, number][]) => ({
    length: pairs.length,
    start: (i: number) => pairs[i][0],
    end: (i: number) => pairs[i][1],
  });

  it('measures to the end of the range holding the playhead', () => {
    expect(
      bufferedAhead(
        ranges([
          [0, 10],
          [20, 40],
        ]),
        25,
      ),
    ).toBe(15);
  });

  it('is zero in a gap', () => {
    expect(bufferedAhead(ranges([[0, 10]]), 12)).toBe(0);
  });
});
