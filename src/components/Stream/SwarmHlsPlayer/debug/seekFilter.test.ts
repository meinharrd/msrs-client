import { ErrorDetails, Events } from 'hls.js';
import { describe, expect, it } from 'vitest';

import { classifySeek, SeekInput, watchRealSeeks } from './seekFilter';

const base: SeekInput = {
  from: 100,
  to: 400,
  now: 10_000,
  lastInternalJumpAt: null,
  beforeFirstPlay: false,
  startPosition: -1,
};

describe('classifySeek', () => {
  it('counts a real jump', () => {
    expect(classifySeek(base)).toEqual({ real: true });
    expect(classifySeek({ ...base, to: 20 })).toEqual({ real: true }); // backwards
  });
  it('ignores jumps under 0.5 s (hls.js nudges, the 1 µs video-hole flush)', () => {
    expect(classifySeek({ ...base, to: 100.000001 })).toEqual({ real: false, reason: 'small' });
    expect(classifySeek({ ...base, to: 100.3 })).toEqual({ real: false, reason: 'small' });
  });
  it('ignores a jump right after hls.js reported a nudge or gap skip', () => {
    expect(classifySeek({ ...base, to: 102, lastInternalJumpAt: 9_900 })).toEqual({ real: false, reason: 'hls-jump' });
    expect(classifySeek({ ...base, to: 102, lastInternalJumpAt: 5_000 })).toEqual({ real: true });
  });
  it('ignores hls.js going to its start position before playback starts', () => {
    const v = classifySeek({ ...base, from: 0, to: 300.2, beforeFirstPlay: true, startPosition: 300 });
    expect(v).toEqual({ real: false, reason: 'start-position' });
    // the same target once playing is a user seek
    expect(classifySeek({ ...base, from: 0, to: 300.2, startPosition: 300 })).toEqual({ real: true });
    // a seek elsewhere before playback starts still counts
    expect(classifySeek({ ...base, from: 0, to: 900, beforeFirstPlay: true, startPosition: 300 })).toEqual({
      real: true,
    });
  });
});

class FakeMedia extends EventTarget {
  currentTime = 0;
  seeking = false;
  paused = false;
  playbackRate = 1;
  seek(t: number) {
    this.currentTime = t;
    this.seeking = true;
    this.dispatchEvent(new Event('seeking'));
    this.seeking = false;
    this.dispatchEvent(new Event('timeupdate'));
  }
  play(to: number) {
    this.currentTime = to;
    this.dispatchEvent(new Event('timeupdate'));
  }
}

function fakeHls() {
  const handlers = new Map<string, (e: string, d: unknown) => void>();
  return {
    startPosition: -1,
    on: (e: string, fn: (e: string, d: unknown) => void) => handlers.set(e, fn),
    off: (e: string) => handlers.delete(e),
    emit: (e: string, d: unknown) => handlers.get(e)?.(e, d),
  };
}

describe('watchRealSeeks', () => {
  it('counts one real seek among a storm of hls.js nudges, gap skips and pre-buffer rate toggles', () => {
    const media = new FakeMedia();
    const hls = fakeHls();
    const real: number[] = [];
    const ignored: string[] = [];
    watchRealSeeks(
      hls as never,
      media as unknown as HTMLMediaElement,
      (to) => real.push(to),
      (r) => ignored.push(r),
    );

    media.play(1);
    media.play(10);
    // video-hole flushes
    for (let i = 0; i < 30; i++) media.seek(media.currentTime + 0.000001);
    // the pre-buffer gate toggling playbackRate (no seeking at all)
    media.playbackRate = 0;
    media.dispatchEvent(new Event('ratechange'));
    media.playbackRate = 1;
    media.dispatchEvent(new Event('ratechange'));
    // a stall nudge and a gap skip, reported by hls.js just before the jump
    hls.emit(Events.ERROR, { details: ErrorDetails.BUFFER_NUDGE_ON_STALL });
    media.seek(10.2);
    hls.emit(Events.ERROR, { details: ErrorDetails.BUFFER_SEEK_OVER_HOLE });
    media.seek(12);
    // the user's seek
    media.seek(300);
    expect(real).toEqual([300]);
    expect(ignored.filter((r) => r === 'small').length).toBeGreaterThanOrEqual(31);
    expect(ignored).toContain('hls-jump');
  });

  it('still counts the steps of a user scrub', () => {
    const media = new FakeMedia();
    const hls = fakeHls();
    const real: number[] = [];
    watchRealSeeks(hls as never, media as unknown as HTMLMediaElement, (to) => real.push(to));
    media.play(1);
    media.play(5);
    media.seek(100);
    media.seek(200);
    media.seek(300);
    expect(real).toEqual([100, 200, 300]);
  });

  it('ignores the start-position seek but not a user seek before the first frame', () => {
    const media = new FakeMedia();
    const hls = fakeHls();
    hls.startPosition = 600;
    const real: number[] = [];
    watchRealSeeks(hls as never, media as unknown as HTMLMediaElement, (to) => real.push(to));
    media.seek(600.1);
    media.seek(1200);
    expect(real).toEqual([1200]);
  });
});
