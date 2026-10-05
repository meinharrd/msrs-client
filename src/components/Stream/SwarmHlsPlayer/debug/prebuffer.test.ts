import { describe, expect, it } from 'vitest';

import {
  bufferBarMax,
  bufferLevel,
  clampTarget,
  DEFAULT_TIMEOUT_MS,
  prebufferDecision,
  PrebufferInput,
  shouldStartWait,
} from './prebuffer';

const base: PrebufferInput = {
  targetSec: 6,
  bufferedAhead: 0,
  currentTime: 0,
  mediaEnd: 600,
  waitedMs: 0,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  userPaused: false,
};

describe('prebufferDecision', () => {
  it('start: holds with an empty buffer, releases once the target is buffered', () => {
    expect(prebufferDecision(base)).toEqual({ hold: true });
    expect(prebufferDecision({ ...base, bufferedAhead: 5.9 })).toEqual({ hold: true });
    expect(prebufferDecision({ ...base, bufferedAhead: 6 })).toEqual({ hold: false, outcome: 'target' });
  });

  it('seek: holds at the new position until the target is buffered there', () => {
    const seek = { ...base, currentTime: 312.4, bufferedAhead: 2.1, waitedMs: 1500 };
    expect(prebufferDecision(seek)).toEqual({ hold: true });
    expect(prebufferDecision({ ...seek, bufferedAhead: 7.5 })).toEqual({ hold: false, outcome: 'target' });
  });

  it('stall: holds mid-play while the buffer refills', () => {
    const stall = { ...base, currentTime: 140, bufferedAhead: 0.2, waitedMs: 4000 };
    expect(prebufferDecision(stall)).toEqual({ hold: true });
    expect(shouldStartWait(stall)).toBe(true);
    expect(shouldStartWait({ ...stall, bufferedAhead: 10 })).toBe(false);
  });

  it('user pause: never holds (so never auto-resumes), even with a short buffer', () => {
    expect(prebufferDecision({ ...base, userPaused: true })).toEqual({ hold: false, outcome: 'user-paused' });
    expect(shouldStartWait({ ...base, userPaused: true })).toBe(false);
  });

  it('end of media: releases when the buffer reaches the end of a VOD', () => {
    const nearEnd = { ...base, currentTime: 597, bufferedAhead: 2.8 };
    expect(prebufferDecision(nearEnd)).toEqual({ hold: false, outcome: 'end' });
    expect(prebufferDecision({ ...nearEnd, bufferedAhead: 1 })).toEqual({ hold: true });
  });

  it('live: caps the wait at the live edge', () => {
    const live = { ...base, currentTime: 1000, mediaEnd: 1004, bufferedAhead: 3.8 };
    expect(prebufferDecision(live)).toEqual({ hold: false, outcome: 'end' });
    expect(prebufferDecision({ ...live, bufferedAhead: 1 })).toEqual({ hold: true });
  });

  it('unknown end: does not release early', () => {
    expect(prebufferDecision({ ...base, mediaEnd: null })).toEqual({ hold: true });
    expect(prebufferDecision({ ...base, mediaEnd: NaN })).toEqual({ hold: true });
    expect(prebufferDecision({ ...base, mediaEnd: Infinity })).toEqual({ hold: true });
  });

  it('timeout: plays anyway after the hard cap', () => {
    expect(prebufferDecision({ ...base, waitedMs: DEFAULT_TIMEOUT_MS - 1 })).toEqual({ hold: true });
    expect(prebufferDecision({ ...base, waitedMs: DEFAULT_TIMEOUT_MS })).toEqual({ hold: false, outcome: 'timeout' });
  });

  it('target 0 switches it off', () => {
    expect(prebufferDecision({ ...base, targetSec: 0 })).toEqual({ hold: false, outcome: 'off' });
    expect(shouldStartWait({ ...base, targetSec: 0 })).toBe(false);
  });

  it('user pause wins over everything else', () => {
    expect(prebufferDecision({ ...base, userPaused: true, waitedMs: 1e9, bufferedAhead: 99 }).hold).toBe(false);
    expect(prebufferDecision({ ...base, userPaused: true, waitedMs: 1e9 })).toEqual({
      hold: false,
      outcome: 'user-paused',
    });
  });
});

describe('panel helpers', () => {
  it('clamps the target to 0..20 whole seconds', () => {
    expect(clampTarget(-3)).toBe(0);
    expect(clampTarget(6.4)).toBe(6);
    expect(clampTarget(99)).toBe(20);
    expect(clampTarget(NaN)).toBe(6);
  });

  it('scales the bar to max(target × 2, 20 s)', () => {
    expect(bufferBarMax(6)).toBe(20);
    expect(bufferBarMax(15)).toBe(30);
  });

  it('colours the buffer: red under 2 s, amber under target, green at/above', () => {
    expect(bufferLevel(1.9, 6)).toBe('low');
    expect(bufferLevel(2, 6)).toBe('under-target');
    expect(bufferLevel(6, 6)).toBe('ok');
    expect(bufferLevel(3, 0)).toBe('ok');
  });
});
