// Debug build only: applies prebufferDecision() to a <video> driven by hls.js. Returns a detach function.
//
// Playback is held with playbackRate = 0 rather than pause(): the element stays "playing", so hls.js keeps
// loading (the player stops loading on pause), its gap controller treats rate 0 as halted rather than stalled,
// and a real pause can only come from the user, which ends the wait without resuming.

import Hls, { ErrorData, ErrorDetails, Events } from 'hls.js';

import { debugLog } from './debugLog';
import { DEFAULT_TIMEOUT_MS, prebuffer, prebufferDecision, PrebufferOutcome, PrebufferReason } from './prebuffer';
import { bufferedAhead } from './stats';

const POLL_MS = 250;

export function attachPrebufferGate(hls: Hls, media: HTMLMediaElement, isLive: boolean): () => void {
  prebuffer.reset();
  let restoreRate = media.playbackRate > 0 ? media.playbackRate : 1;
  let started = false;
  let pausedByUser = false;
  let stalled = false;

  const ahead = () => bufferedAhead(media.buffered, media.currentTime);
  const mediaEnd = () => {
    if (!isLive) return Number.isFinite(media.duration) ? media.duration : null;
    const s = media.seekable;
    return s.length ? s.end(s.length - 1) : null;
  };

  const hold = () => {
    if (media.playbackRate !== 0) {
      restoreRate = media.playbackRate > 0 ? media.playbackRate : restoreRate;
      media.playbackRate = 0;
    }
  };

  const finish = (outcome: PrebufferOutcome) => {
    const w = prebuffer.active;
    if (!w) return;
    w.endedAt = Date.now();
    w.bufferReached = ahead();
    w.outcome = outcome;
    prebuffer.active = null;
    prebuffer.waits.push(w);
    if (outcome !== 'superseded') media.playbackRate = restoreRate;
    if (outcome !== 'superseded') started = true;
    debugLog.marker(
      `pre-buffer (${w.reason}) waited ${((w.endedAt - w.startedAt) / 1000).toFixed(
        1,
      )} s, reached ${w.bufferReached.toFixed(1)} / ${w.target} s → ${outcome}`,
    );
  };

  const decide = (userPaused = false) => {
    const w = prebuffer.active;
    if (!w) return;
    w.bufferReached = ahead();
    const d = prebufferDecision({
      targetSec: prebuffer.targetSec,
      bufferedAhead: w.bufferReached,
      currentTime: media.currentTime,
      mediaEnd: mediaEnd(),
      waitedMs: Date.now() - w.startedAt,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      userPaused,
    });
    if (d.hold) hold();
    else finish(d.outcome);
  };

  const begin = (reason: PrebufferReason) => {
    if (prebuffer.active) finish('superseded');
    if (!(prebuffer.targetSec > 0)) {
      media.playbackRate = media.playbackRate || restoreRate;
      if (reason === 'start') started = true;
      return;
    }
    prebuffer.active = {
      reason,
      startedAt: Date.now(),
      endedAt: null,
      at: media.currentTime,
      bufferReached: ahead(),
      target: prebuffer.targetSec,
      outcome: null,
    };
    debugLog.marker(
      `pre-buffer (${reason}) at ${media.currentTime.toFixed(1)} s: holding for ${
        prebuffer.targetSec
      } s, have ${ahead().toFixed(1)} s`,
    );
    decide();
  };

  const onPause = () => {
    if (media.ended) return;
    pausedByUser = true;
    if (prebuffer.active) decide(true);
  };
  const onPlay = () => {
    if (prebuffer.active) return hold();
    if (!started) return begin('start');
    if (pausedByUser) {
      pausedByUser = false;
      begin('play');
    }
  };
  const onSeeking = () => {
    // A seek while paused (by the user, or before autoplay) gates when playback starts.
    if (!media.paused) begin('seek');
  };
  const onStall = () => {
    stalled = true;
    if (!prebuffer.active && started && !media.paused && !media.seeking) begin('stall');
  };
  const onRateChange = () => {
    if (prebuffer.active && media.playbackRate !== 0) hold();
  };
  const onTimeUpdate = () => {
    if (!prebuffer.active && !media.paused && media.playbackRate > 0) stalled = false;
  };
  const onEnded = () => {
    if (prebuffer.active) finish('end');
  };
  const onHlsError = (_e: Events.ERROR, data: ErrorData) => {
    if (data.details === ErrorDetails.BUFFER_STALLED_ERROR) onStall();
  };

  let lastTime = media.currentTime;
  const poll = setInterval(() => {
    if (prebuffer.active) decide();
    if (media.currentTime !== lastTime && !media.seeking) stalled = false;
    lastTime = media.currentTime;
    prebuffer.sample({
      t: Date.now(),
      ahead: ahead(),
      stalled: stalled && !prebuffer.active,
      held: !!prebuffer.active,
    });
  }, POLL_MS);

  media.addEventListener('pause', onPause);
  media.addEventListener('play', onPlay);
  media.addEventListener('seeking', onSeeking);
  media.addEventListener('waiting', onStall);
  media.addEventListener('ratechange', onRateChange);
  media.addEventListener('loadstart', onRateChange);
  media.addEventListener('timeupdate', onTimeUpdate);
  media.addEventListener('ended', onEnded);
  hls.on(Events.ERROR, onHlsError);

  // Held from the start: attaching the media resets playbackRate, which onRateChange/loadstart re-assert.
  begin('start');

  return () => {
    clearInterval(poll);
    if (prebuffer.active) finish('superseded');
    media.playbackRate = restoreRate;
    media.removeEventListener('pause', onPause);
    media.removeEventListener('play', onPlay);
    media.removeEventListener('seeking', onSeeking);
    media.removeEventListener('waiting', onStall);
    media.removeEventListener('ratechange', onRateChange);
    media.removeEventListener('loadstart', onRateChange);
    media.removeEventListener('timeupdate', onTimeUpdate);
    media.removeEventListener('ended', onEnded);
    hls.off(Events.ERROR, onHlsError);
  };
}
