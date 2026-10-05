import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { InputLoading } from '@/components/InputLoading/InputLoading';

import { browserNodeMode } from '../browserNode';
import { MAX_PREFETCH_DEPTH } from '../prefetchLoader';

import { debugLog, FragEntry, LogEntry, MAX_LOG_ENTRIES } from './debugLog';
import { debugMediaRef } from './mediaRegistry';
import { bufferBarMax, bufferLevel, BufferSample, MAX_TARGET_SEC, prebuffer } from './prebuffer';
import { prefetchSettings } from './prefetchSettings';
import { bufferedAhead, median, shortRef, summarizeFrags, throughputMbps } from './stats';

import './DebugPanel.scss';

const MAX_ROWS = 300;
const SLOW_TTFB_MS = 2000;

interface DebugPanelProps {
  /** Defaults to the media element the player registered (debugMediaRef). */
  mediaRef?: { current: HTMLMediaElement | null };
}

const clock = (ms: number) => {
  const d = new Date(ms);
  return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};
const fmtMs = (v: number | null | undefined) => (v === null || v === undefined ? '-' : `${Math.round(v)}`);
const fmtSec = (v: number | null | undefined) => (v === null || v === undefined ? '-' : `${(v / 1000).toFixed(2)}s`);
const fmtBytes = (v: number | null | undefined) =>
  !v ? '-' : v >= 1024 * 1024 ? `${(v / 1024 / 1024).toFixed(2)}M` : `${(v / 1024).toFixed(0)}k`;
const fmtMbps = (v: number | null | undefined) => (v === null || v === undefined ? '-' : v.toFixed(2));

function isSlow(f: FragEntry) {
  return (f.ttfbMs ?? 0) > SLOW_TTFB_MS || (f.loadMs !== null && f.duration > 0 && f.loadMs > f.duration * 1000);
}

const isPrebufferMarker = (e: LogEntry) => e.kind === 'marker' && e.text.startsWith('pre-buffer');

function isErrorEntry(e: LogEntry) {
  if (isPrebufferMarker(e)) return false;
  if (e.kind === 'frag') {
    // Prefetches cancelled by a seek or level switch are expected, not errors.
    if (e.fragType === 'prefetch' && e.status === 'aborted') return false;
    return e.status === 'error' || e.status === 'aborted' || !!e.error;
  }
  if (e.kind === 'manifest') return !!e.error || (e.status !== null && e.status >= 400);
  return /error|stall/i.test(e.text);
}

function exportJson() {
  return JSON.stringify(debugLog.toJSON(), null, 2);
}

async function copyLog() {
  const text = exportJson();
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

function downloadLog() {
  const blob = new Blob([exportJson()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `msrs-debug-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const HEIGHT_KEY = 'msrs-debug-height';
const DEFAULT_HEIGHT = 260;
const MIN_HEIGHT = 90;

function clampHeight(px: number): number {
  const max = Math.round(window.innerHeight * 0.9);
  return Math.min(Math.max(Math.round(px), MIN_HEIGHT), max);
}

function loadHeight(): number {
  const saved = Number(localStorage.getItem(HEIGHT_KEY));
  return clampHeight(Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_HEIGHT);
}

/** Drag the panel's top edge to resize it (mouse and touch); the height is kept across reloads. */
function useResizeHandle(setHeight: (px: number) => void) {
  return useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      const onMove = (ev: PointerEvent) => setHeight(clampHeight(window.innerHeight - ev.clientY));
      const onUp = (ev: PointerEvent) => {
        target.releasePointerCapture(ev.pointerId);
        target.removeEventListener('pointermove', onMove);
        target.removeEventListener('pointerup', onUp);
        target.removeEventListener('pointercancel', onUp);
        localStorage.setItem(HEIGHT_KEY, String(clampHeight(window.innerHeight - ev.clientY)));
      };
      target.addEventListener('pointermove', onMove);
      target.addEventListener('pointerup', onUp);
      target.addEventListener('pointercancel', onUp);
    },
    [setHeight],
  );
}

export default function DebugPanel({ mediaRef = debugMediaRef }: DebugPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [height, setHeight] = useState(loadHeight);
  const startResize = useResizeHandle(setHeight);
  const [paused, setPaused] = useState(false);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [copyState, setCopyState] = useState('');
  const [target, setTarget] = useState(prebuffer.targetSec);
  const [depth, setDepth] = useState(prefetchSettings.depth);
  // Re-render the summary when the log changes, and once a second for the running timers.
  const [tick, setTick] = useState({ version: debugLog.version, second: 0 });

  useEffect(() => {
    if (collapsed) return;
    const id = setInterval(() => {
      const second = Math.floor(Date.now() / 1000);
      setTick((prev) =>
        prev.version === debugLog.version && prev.second === second ? prev : { version: debugLog.version, second },
      );
    }, 500);
    return () => clearInterval(id);
  }, [collapsed]);

  // Pause freezes what is shown; logging carries on underneath.
  const [frozen, setFrozen] = useState<LogEntry[] | null>(null);
  useEffect(() => {
    setFrozen(paused ? debugLog.entries.map((e) => ({ ...e })) : null);
  }, [paused]);

  const session = debugLog.session;
  const sessionId = session?.id ?? 0;

  const { rows, summary } = useMemo(() => {
    const all = frozen ?? debugLog.entries;
    // Background prefetch rows are shown, but the summary is over what hls.js asked for (no double counting).
    const frags = all.filter(
      (e): e is FragEntry => e.kind === 'frag' && e.session === sessionId && e.fragType !== 'prefetch',
    );
    const visible = (errorsOnly ? all.filter(isErrorEntry) : all).slice(-MAX_ROWS).reverse();
    return { rows: visible, summary: summarizeFrags(frags) };
    // tick.version drives recomputation while the log mutates in place
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick.version, frozen, errorsOnly, sessionId]);

  const level = session && session.currentLevel >= 0 ? session.levels[session.currentLevel] : undefined;
  const stallMs = (session?.stallTotalMs ?? 0) + (session?.stallStartedAt ? Date.now() - session.stallStartedAt : 0);
  const ttffPlayer = session?.firstPlayingAt ? session.firstPlayingAt - session.startedAt : null;
  const ttffPage = session?.firstPlayingAt ? session.firstPlayingAt - performance.timeOrigin : null;
  const commit = import.meta.env.VITE_GIT_COMMIT ?? 'unknown';
  const nodeMode = browserNodeMode();
  const mode =
    nodeMode === 'bzz-scheme'
      ? 'bzz:// (local node)'
      : nodeMode === 'freedom-virtual-origin'
      ? 'local node (Freedom Android virtual origin)'
      : 'gateway https';

  const prebufTotals = prebuffer.totals();
  const activeWait = prebuffer.active;

  const onTarget = (v: number) => {
    prebuffer.setTarget(v);
    setTarget(prebuffer.targetSec);
  };

  const onDepth = (v: number) => {
    prefetchSettings.setDepth(v);
    setDepth(prefetchSettings.depth);
  };
  const pf = prefetchSettings.current?.snapshot();

  const onCopy = async () => {
    setCopyState((await copyLog()) ? 'copied' : 'copy failed');
    setTimeout(() => setCopyState(''), 2000);
  };

  return createPortal(
    <div
      className={`msrs-debug ${collapsed ? 'msrs-debug--collapsed' : ''}`}
      style={collapsed ? undefined : { height }}
      data-testid="msrs-debug-panel"
    >
      {!collapsed && (
        <div
          className="msrs-debug__resize"
          onPointerDown={startResize}
          role="separator"
          aria-orientation="horizontal"
          title="Drag to resize"
        />
      )}
      <div className="msrs-debug__bar">
        <BufferReadout mediaRef={mediaRef} target={target} />
        <span className="msrs-debug__badge">DEBUG BUILD</span>
        <span className="msrs-debug__commit">{commit}</span>
        <span>
          mode <b>{mode}</b> · page <b>{window.location.protocol}</b>
        </span>
        <span className="msrs-debug__spacer" />
        <button onClick={() => setCollapsed((c) => !c)}>{collapsed ? 'Show ▲' : 'Hide ▼'}</button>
      </div>

      {!collapsed && (
        <>
          <div className="msrs-debug__summary">
            <span>
              segs <b>{summary.loaded}</b> ok · <b className={summary.failed ? 'bad' : ''}>{summary.failed}</b> failed ·{' '}
              {summary.aborted} aborted · <b>{summary.inFlight}</b> in flight
            </span>
            <span data-testid="msrs-debug-prefetch">
              prefetch <b>{depth ? `+${depth}` : 'off'}</b>
              {pf ? (
                <>
                  {' '}
                  · net in flight <b>{pf.inFlight}</b> · cache <b>{pf.cached}</b> / {fmtBytes(pf.cachedBytes)} · hits{' '}
                  <b>{pf.hits}</b> joins <b>{pf.joins}</b> misses {pf.misses}
                  {pf.wasted ? ` · ${pf.wasted} unused (cancelled or dropped)` : ''}
                </>
              ) : null}
            </span>
            <span>
              TTFB med/p90 <b>{fmtMs(summary.ttfbMedian)}</b>/<b>{fmtMs(summary.ttfbP90)}</b> ms
            </span>
            <span>
              load med/p90 <b>{fmtMs(summary.loadMedian)}</b>/<b>{fmtMs(summary.loadP90)}</b> ms
            </span>
            <span>
              avg <b>{fmtMbps(summary.avgMbps)}</b> Mbit/s · {fmtBytes(summary.totalBytes)}
            </span>
            <span>
              pre-buffer waits <b>{prebufTotals.count}</b> / <b>{fmtSec(prebufTotals.ms)}</b>
              {activeWait ? ` · holding (${activeWait.reason}) ${fmtSec(Date.now() - activeWait.startedAt)}` : ''}
            </span>
            <span>
              stalls <b className={session?.stalls ? 'bad' : ''}>{session?.stalls ?? 0}</b> / {fmtSec(stallMs)}
            </span>
            <span>
              seeks <b>{session?.seeks ?? 0}</b> · to playing med/max{' '}
              <b>{fmtMs(median(session?.seekLatenciesMs ?? []))}</b>/
              <b>{session?.seekLatenciesMs.length ? fmtMs(Math.max(...session.seekLatenciesMs)) : '-'}</b> ms
              {session?.seekStartedAt ? ` · seeking ${fmtSec(Date.now() - session.seekStartedAt)}` : ''}
              {session?.seeksSuperseded ? ` · ${session.seeksSuperseded} superseded` : ''}
              {session?.seeksIgnored ? ` · ${session.seeksIgnored} hls.js moves not counted` : ''}
            </span>
            <span>
              level <b>{session?.currentLevel ?? '-'}</b>
              {level?.height ? ` ${level.height}p` : ''}
              {level?.bitrate ? ` ${(level.bitrate / 1e6).toFixed(2)}Mbps` : ''}
            </span>
            <span>
              first frame <b>{fmtSec(ttffPlayer)}</b> player · {fmtSec(ttffPage)} page
            </span>
          </div>

          <div className="msrs-debug__controls">
            <button onClick={() => setPaused((p) => !p)} className={paused ? 'on' : ''}>
              {paused ? 'Resume' : 'Pause'}
            </button>
            <button onClick={() => debugLog.clear()}>Clear</button>
            <button onClick={onCopy}>Copy log</button>
            <button onClick={downloadLog}>Download log</button>
            <label title="Hold playback until this much is buffered ahead (start, seek, stall). 0 = off.">
              pre-buffer
              <input
                className="msrs-debug__target"
                type="number"
                min={0}
                max={MAX_TARGET_SEC}
                step={1}
                value={target}
                onChange={(e) => onTarget(Number(e.target.value))}
              />
              s
            </label>
            <label title="Segments fetched ahead, in parallel with the one hls.js loads. 0 = off (hls.js alone).">
              prefetch
              <input
                className="msrs-debug__target"
                type="number"
                min={0}
                max={MAX_PREFETCH_DEPTH}
                step={1}
                value={depth}
                onChange={(e) => onDepth(Number(e.target.value))}
                data-testid="msrs-debug-prefetch-depth"
              />
            </label>
            <label>
              <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} /> errors
              only
            </label>
            <span className="msrs-debug__note">
              {copyState || `${debugLog.entries.length} entries (cap ${MAX_LOG_ENTRIES}), showing ${rows.length}`}
            </span>
          </div>

          <div className="msrs-debug__table-wrap">
            <table className="msrs-debug__table">
              <thead>
                <tr>
                  <th>time</th>
                  <th>what</th>
                  <th>sn/idx</th>
                  <th>lvl</th>
                  <th>ref / path</th>
                  <th>source</th>
                  <th>start</th>
                  <th>TTFB</th>
                  <th>load</th>
                  <th>bytes</th>
                  <th>Mbit/s</th>
                  <th>status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <Row key={e.id} entry={e} sessionStart={session?.startedAt ?? 0} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}

function Row({ entry: e, sessionStart }: { entry: LogEntry; sessionStart: number }) {
  if (e.kind === 'marker') {
    return (
      <tr className={`msrs-debug__marker ${isErrorEntry(e) ? 'err' : ''} ${isPrebufferMarker(e) ? 'prebuf' : ''}`}>
        <td>{clock(e.at)}</td>
        <td colSpan={11}>— {e.text}</td>
      </tr>
    );
  }

  if (e.kind === 'manifest') {
    const failed = isErrorEntry(e);
    return (
      <tr className={`msrs-debug__manifest ${failed ? 'err' : ''}`} title={e.url}>
        <td>{clock(e.at)}</td>
        <td>playlist</td>
        <td>{e.index ?? '-'}</td>
        <td>-</td>
        <td className="mono">{shortPath(e.path)}</td>
        <td>{hostOf(e.url)}</td>
        <td>-</td>
        <td>-</td>
        <td>{fmtMs(e.durationMs)}</td>
        <td>{fmtBytes(e.bytes)}</td>
        <td>-</td>
        <td>
          {e.status ?? 'ERR'}
          {e.changed === null ? '' : e.changed ? ' changed' : ' same'}
          {e.error ? ` ${e.error}` : ''}
        </td>
      </tr>
    );
  }

  const isPrefetch = e.fragType === 'prefetch';
  const cls = `${e.status === 'error' ? 'err' : e.status === 'aborted' ? 'aborted' : isSlow(e) ? 'slow' : ''}${
    isPrefetch ? ' prefetch' : e.via ? ' cached' : ''
  }`;
  const start = e.requestStart ? `+${((e.requestStart - sessionStart) / 1000).toFixed(1)}s` : '-';
  const status =
    e.status === 'loading'
      ? 'loading…'
      : `${e.status}${e.httpStatus ? ` ${e.httpStatus}` : ''}${e.retries ? ` retry×${e.retries}` : ''}${
          e.attempt > 1 ? ` #${e.attempt}` : ''
        }${e.error ? ` ${e.error}` : ''}${e.via && !isPrefetch ? ` (${e.via})` : ''}${
          isPrefetch && e.via === 'prefetch (used)' ? ' → used' : ''
        }`;
  return (
    <tr className={`msrs-debug__frag ${cls}`} title={e.url}>
      <td>{clock(e.at)}</td>
      <td>{e.fragType === 'main' ? 'seg' : e.fragType}</td>
      <td>{e.sn}</td>
      <td>{e.level}</td>
      <td className="mono">{shortRef(e.ref)}</td>
      <td>
        {e.source === 'bzz'
          ? e.host
            ? 'local (virtual)'
            : 'bzz://'
          : e.source === 'gateway'
          ? `https ${e.host}`
          : 'other'}
      </td>
      <td>{start}</td>
      <td>{fmtMs(e.ttfbMs)}</td>
      <td>{fmtMs(e.loadMs)}</td>
      <td>{fmtBytes(e.bytes)}</td>
      <td>{fmtMbps(throughputMbps(e.bytes, e.loadMs))}</td>
      <td>{status}</td>
    </tr>
  );
}

function shortPath(path: string) {
  const [kind, owner, id] = path.split('/');
  return `${kind}/${(owner ?? '').slice(0, 6)}…/${(id ?? '').slice(0, 8)}…`;
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return '-';
  }
}

const SAMPLE_MS = 250;
const SPARK_WINDOW_MS = 120_000;
const SPARK_W = 120;
const SPARK_H = 26;

/**
 * The number that matters most on a slow node: seconds buffered ahead, a bar against the pre-buffer target,
 * and a sparkline of the last two minutes. Lives in the header row, so it shows when collapsed too.
 */
function BufferReadout({ mediaRef, target }: { mediaRef: { current: HTMLMediaElement | null }; target: number }) {
  const [, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((n) => n + 1), SAMPLE_MS);
    return () => clearInterval(id);
  }, []);

  const media = mediaRef.current;
  // Read live rather than from the last sample, so a seek shows its empty buffer at once.
  const ahead = media ? bufferedAhead(media.buffered, media.currentTime) : prebuffer.ahead;
  const max = bufferBarMax(target);
  const lvl = bufferLevel(ahead, target);
  const active = prebuffer.active;

  return (
    <div className={`msrs-debug__buf lvl-${lvl}`} data-testid="msrs-debug-buffer">
      <span className="msrs-debug__buf-num">
        Buffer <b>{ahead.toFixed(1)}</b> s
      </span>
      <div
        className="msrs-debug__buf-bar"
        title={`buffered ahead ${ahead.toFixed(1)} s · target ${target} s · scale ${max} s`}
      >
        <div className="msrs-debug__buf-fill" style={{ width: `${Math.min(ahead / max, 1) * 100}%` }} />
        {target > 0 && <div className="msrs-debug__buf-target" style={{ left: `${(target / max) * 100}%` }} />}
        <span className="msrs-debug__buf-scale">{max}s</span>
      </div>
      <Sparkline samples={prebuffer.samples} max={max} target={target} />
      {!media && <span className="msrs-debug__note">no player on this page</span>}
      {active && media && (
        <span className="msrs-debug__holding" data-testid="msrs-prebuffer-holding">
          holding ({active.reason}) {ahead.toFixed(1)}/{active.target} s
        </span>
      )}
      {active && media && <HoldSpinner media={media} />}
    </div>
  );
}

function Sparkline({ samples, max, target }: { samples: BufferSample[]; max: number; target: number }) {
  const now = Date.now();
  const from = now - SPARK_WINDOW_MS;
  const x = (t: number) => ((t - from) / SPARK_WINDOW_MS) * SPARK_W;
  const y = (v: number) => SPARK_H - (Math.min(v, max) / max) * (SPARK_H - 2) - 1;
  const recent = samples.filter((s) => s.t >= from);
  const line = recent.map((s, i) => `${i ? 'L' : 'M'}${x(s.t).toFixed(1)},${y(s.ahead).toFixed(1)}`).join('');
  const step = (SAMPLE_MS / SPARK_WINDOW_MS) * SPARK_W + 0.2;
  return (
    <svg
      className="msrs-debug__spark"
      width={SPARK_W}
      height={SPARK_H}
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      aria-label="buffer ahead, last 2 minutes (red: stalled, amber: pre-buffering)"
    >
      <title>buffer ahead, last 2 min · red = stalled · amber = held by pre-buffer</title>
      {recent.map((s) =>
        s.stalled || s.held ? (
          <rect key={s.t} x={x(s.t)} y={0} width={step} height={SPARK_H} className={s.stalled ? 'stall' : 'held'} />
        ) : null,
      )}
      {target > 0 && <line x1={0} x2={SPARK_W} y1={y(target)} y2={y(target)} className="target" />}
      <path d={line} className="line" />
    </svg>
  );
}

/** While pre-buffering holds playback, show the player's usual loading spinner over the video (no text). */
function HoldSpinner({ media }: { media: HTMLMediaElement }) {
  const r = media.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  return createPortal(
    <div
      className="msrs-hold-spinner"
      style={{ left: r.left + r.width / 2, top: r.top + r.height / 2 }}
      data-testid="msrs-prebuffer-spinner"
    >
      <InputLoading />
    </div>,
    document.body,
  );
}
