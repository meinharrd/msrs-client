// Wires hls.js and <video> events into the debug log. Returns a detach function.

import Hls, { ErrorData, ErrorDetails, Events, Fragment, LoaderStats } from 'hls.js';

import { debugLog, FragEntry, toEpoch } from './debugLog';

const fragKey = (frag: Fragment) => `${frag.type}:${frag.level}:${frag.sn}`;

function applyStats(entry: FragEntry, stats: LoaderStats | undefined) {
  if (!stats) return;
  const { start, first, end } = stats.loading;
  entry.requestStart = start ? toEpoch(start) : null;
  entry.firstByte = first ? toEpoch(first) : null;
  entry.end = end ? toEpoch(end) : null;
  entry.ttfbMs = start && first ? first - start : null;
  entry.loadMs = start && end ? end - start : null;
  entry.bytes = stats.loaded || stats.total || null;
  entry.retries = stats.retry;
  entry.aborted = entry.aborted || stats.aborted;
}

export function attachHlsDebug(hls: Hls, media: HTMLMediaElement, sourceUrl: string): () => void {
  const session = debugLog.startSession(sourceUrl);
  const open = new Map<string, { entry: FragEntry; frag: Fragment }>();

  // hls.js aborts loads silently on seek, pause (stopLoad) and level switches; close those rows.
  const sweep = () => {
    for (const [key, { entry, frag }] of open) {
      if (frag.stats.aborted) {
        applyStats(entry, frag.stats);
        entry.status = 'aborted';
        entry.aborted = true;
        open.delete(key);
        debugLog.touch();
      }
    }
  };
  const sweepTimer = setInterval(sweep, 1000);
  const attempts = new Map<string, number>();

  const onFragLoading = (_e: Events.FRAG_LOADING, { frag }: { frag: Fragment }) => {
    sweep();
    const key = fragKey(frag);
    const previous = open.get(key);
    if (previous) {
      previous.entry.status = 'aborted';
      previous.entry.aborted = true;
      previous.entry.error = 'superseded by a new request';
    }
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    if (attempts.size > 5000) attempts.clear();
    const entry = debugLog.addFrag({
      at: Date.now(),
      sn: frag.sn,
      level: frag.level,
      fragType: String(frag.type),
      duration: frag.duration,
      url: frag.url,
      attempt,
      status: 'loading',
      requestStart: null,
      firstByte: null,
      end: null,
      ttfbMs: null,
      loadMs: null,
      bytes: null,
      retries: 0,
      aborted: false,
      httpStatus: null,
      error: null,
    });
    open.set(key, { entry, frag });
  };

  const finish = (frag: Fragment, update: (entry: FragEntry) => void) => {
    const key = fragKey(frag);
    const entry = open.get(key)?.entry;
    if (!entry) return;
    update(entry);
    if (entry.status !== 'loading') open.delete(key);
    debugLog.touch();
  };

  const onFragLoaded = (_e: Events.FRAG_LOADED, { frag }: { frag: Fragment }) =>
    finish(frag, (entry) => {
      applyStats(entry, frag.stats);
      entry.status = 'loaded';
    });

  const onEmergencyAbort = (_e: Events.FRAG_LOAD_EMERGENCY_ABORTED, data: { frag: Fragment; stats: LoaderStats }) =>
    finish(data.frag, (entry) => {
      applyStats(entry, data.stats ?? data.frag.stats);
      entry.status = 'aborted';
      entry.aborted = true;
    });

  const endStall = () => {
    if (session.stallStartedAt !== null) {
      session.stallTotalMs += Date.now() - session.stallStartedAt;
      session.stallStartedAt = null;
      debugLog.touch();
    }
  };

  const onError = (_e: Events.ERROR, data: ErrorData) => {
    if (data.details === ErrorDetails.BUFFER_STALLED_ERROR) {
      if (session.stallStartedAt === null) {
        session.stalls++;
        session.stallStartedAt = Date.now();
        debugLog.marker(`stall at ${media.currentTime.toFixed(1)}s`);
      }
      return;
    }
    if (data.frag) {
      finish(data.frag, (entry) => {
        applyStats(entry, data.frag!.stats);
        entry.httpStatus = data.response?.code ?? null;
        entry.error = `${data.details}${data.fatal ? ' (fatal)' : ''}${
          data.error?.message ? `: ${data.error.message}` : ''
        }`;
        // Loader timeouts and network errors end the attempt; other frag errors (parsing) keep their timing.
        entry.status = entry.aborted ? 'aborted' : 'error';
      });
    } else if (data.fatal || data.type === 'networkError') {
      debugLog.marker(`hls error ${data.details}${data.fatal ? ' (fatal)' : ''}`);
    }
  };

  const onLevelSwitched = (_e: Events.LEVEL_SWITCHED, { level }: { level: number }) => {
    session.currentLevel = level;
    debugLog.touch();
  };

  const onManifestParsed = () => {
    session.levels = hls.levels.map((l) => ({ height: l.height, bitrate: l.bitrate }));
    debugLog.touch();
  };

  const onPlaying = () => {
    // The pre-buffer gate holds playback at playbackRate 0; "playing" then is not a frame on screen yet.
    if (media.paused || media.playbackRate === 0) return;
    if (session.firstPlayingAt === null) {
      session.firstPlayingAt = Date.now();
      debugLog.marker(`first playing after ${session.firstPlayingAt - session.startedAt} ms`);
    }
    endStall();
  };

  let lastTime = 0;

  // Seek markers: "seek → T" when it starts, "seek played after N ms" once playback moves again.
  const endSeek = () => {
    if (session.seekStartedAt === null || media.paused || media.seeking) return;
    const ms = Date.now() - session.seekStartedAt;
    session.seekLatenciesMs.push(ms);
    debugLog.marker(`seek to ${session.seekTarget?.toFixed(1)}s played after ${ms} ms`);
    session.seekStartedAt = null;
    session.seekTarget = null;
  };

  const onSeeking = () => {
    if (session.seekStartedAt !== null) {
      session.seeksSuperseded++;
      debugLog.marker(
        `seek to ${session.seekTarget?.toFixed(1)}s superseded after ${Date.now() - session.seekStartedAt} ms`,
      );
    }
    session.seeks++;
    session.seekStartedAt = Date.now();
    session.seekTarget = media.currentTime;
    debugLog.marker(`seek → ${media.currentTime.toFixed(1)}s (from ${lastTime.toFixed(1)}s)`);
  };

  const onTimeUpdate = () => {
    if (session.stallStartedAt !== null && media.currentTime > lastTime + 0.1) endStall();
    if (session.seekStartedAt !== null && session.seekTarget !== null && media.currentTime > session.seekTarget + 0.1) {
      endSeek();
    }
    lastTime = media.currentTime;
  };

  hls.on(Events.FRAG_LOADING, onFragLoading);
  hls.on(Events.FRAG_LOADED, onFragLoaded);
  hls.on(Events.FRAG_LOAD_EMERGENCY_ABORTED, onEmergencyAbort);
  hls.on(Events.ERROR, onError);
  hls.on(Events.LEVEL_SWITCHED, onLevelSwitched);
  hls.on(Events.MANIFEST_PARSED, onManifestParsed);
  media.addEventListener('playing', onPlaying);
  media.addEventListener('ratechange', onPlaying);
  media.addEventListener('timeupdate', onTimeUpdate);
  media.addEventListener('seeking', onSeeking);
  // Lets scripted runs (Playwright) read the log and hook hls.js events. Debug builds only.
  (window as unknown as { __msrsDebug?: unknown }).__msrsDebug = { hls, media, log: debugLog };

  return () => {
    clearInterval(sweepTimer);
    endStall();
    hls.off(Events.FRAG_LOADING, onFragLoading);
    hls.off(Events.FRAG_LOADED, onFragLoaded);
    hls.off(Events.FRAG_LOAD_EMERGENCY_ABORTED, onEmergencyAbort);
    hls.off(Events.ERROR, onError);
    hls.off(Events.LEVEL_SWITCHED, onLevelSwitched);
    hls.off(Events.MANIFEST_PARSED, onManifestParsed);
    media.removeEventListener('playing', onPlaying);
    media.removeEventListener('ratechange', onPlaying);
    media.removeEventListener('timeupdate', onTimeUpdate);
    media.removeEventListener('seeking', onSeeking);
    // Requests still open when the player goes away will never complete.
    for (const { entry } of open.values()) {
      entry.status = 'aborted';
      entry.aborted = true;
      entry.error = 'player destroyed';
    }
    open.clear();
    debugLog.touch();
  };
}
