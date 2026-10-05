// Tell real seeks (a user scrub, a script setting currentTime) from the position changes hls.js makes itself.
//
// Every `seeking` event used to count as a seek, so the panel showed e.g. "seeks 79 · 77 superseded" after one or
// two real seeks. hls.js moves the playhead on its own: it nudges it by 1 µs to flush the pipeline when playback
// crosses a video hole, nudges it by 0.1 s steps on a stall (BUFFER_NUDGE_ON_STALL), skips buffer holes
// (BUFFER_SEEK_OVER_HOLE), and seeks to the start position when it starts. Each of those fires `seeking`.

import Hls, { ErrorData, ErrorDetails, Events } from 'hls.js';

/** Position changes smaller than this are hls.js nudges (or too small to matter), not seeks. */
export const MIN_SEEK_JUMP_SEC = 0.5;
/** A `seeking` this soon after hls.js reported a nudge or gap jump is that jump. */
export const INTERNAL_JUMP_WINDOW_MS = 1000;
/** Before playback starts, a seek this close to hls.js's start position is hls.js going there. */
export const START_POSITION_SLACK_SEC = 1;

export type SeekVerdict = { real: true } | { real: false; reason: 'small' | 'hls-jump' | 'start-position' };

export interface SeekInput {
  /** Playhead before the seek (last known position). */
  from: number;
  /** Seek target (currentTime when `seeking` fired). */
  to: number;
  now: number;
  /** When hls.js last reported BUFFER_NUDGE_ON_STALL / BUFFER_SEEK_OVER_HOLE, or null. */
  lastInternalJumpAt: number | null;
  /** Playback hasn't started yet. */
  beforeFirstPlay: boolean;
  /** hls.js's start position (startLoad / config.startPosition), or null / negative when unset. */
  startPosition: number | null;
}

export function classifySeek(i: SeekInput): SeekVerdict {
  if (!(Math.abs(i.to - i.from) >= MIN_SEEK_JUMP_SEC)) return { real: false, reason: 'small' };
  if (
    i.lastInternalJumpAt !== null &&
    i.now - i.lastInternalJumpAt >= 0 &&
    i.now - i.lastInternalJumpAt <= INTERNAL_JUMP_WINDOW_MS
  ) {
    return { real: false, reason: 'hls-jump' };
  }
  if (
    i.beforeFirstPlay &&
    i.startPosition !== null &&
    i.startPosition >= 0 &&
    Math.abs(i.to - i.startPosition) <= START_POSITION_SLACK_SEC
  ) {
    return { real: false, reason: 'start-position' };
  }
  return { real: true };
}

/**
 * Call `onSeek(to, from)` for real seeks only; `onIgnored` gets the rest. Returns a detach function.
 * `from` is the last position playback reported (timeupdate) or the previous seek's target.
 */
export function watchRealSeeks(
  hls: Pick<Hls, 'on' | 'off' | 'startPosition'>,
  media: HTMLMediaElement,
  onSeek: (to: number, from: number) => void,
  onIgnored?: (reason: string, to: number, from: number) => void,
): () => void {
  let lastTime = media.currentTime;
  let lastInternalJumpAt: number | null = null;
  let played = false;

  const onError = (_e: Events.ERROR, data: ErrorData) => {
    if (data.details === ErrorDetails.BUFFER_NUDGE_ON_STALL || data.details === ErrorDetails.BUFFER_SEEK_OVER_HOLE) {
      lastInternalJumpAt = Date.now();
    }
  };
  const onTimeUpdate = () => {
    if (!media.seeking) {
      if (media.currentTime > lastTime && !media.paused && media.playbackRate > 0) played = true;
      lastTime = media.currentTime;
    }
  };
  const onSeeking = () => {
    const to = media.currentTime;
    const from = lastTime;
    let startPosition: number | null = null;
    try {
      startPosition = hls.startPosition;
    } catch {
      // not started
    }
    const v = classifySeek({ from, to, now: Date.now(), lastInternalJumpAt, beforeFirstPlay: !played, startPosition });
    if (v.real) {
      lastTime = to;
      onSeek(to, from);
    } else {
      // Follow hls.js's own moves too, so the next real seek measures from where playback really is.
      lastTime = to;
      // One reported jump explains one `seeking`; a user seek right after it still counts.
      if (v.reason === 'hls-jump') lastInternalJumpAt = null;
      onIgnored?.(v.reason, to, from);
    }
  };

  hls.on(Events.ERROR, onError);
  media.addEventListener('timeupdate', onTimeUpdate);
  media.addEventListener('seeking', onSeeking);
  return () => {
    hls.off(Events.ERROR, onError);
    media.removeEventListener('timeupdate', onTimeUpdate);
    media.removeEventListener('seeking', onSeeking);
  };
}
