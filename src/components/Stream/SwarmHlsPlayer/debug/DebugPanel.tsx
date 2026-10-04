import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { browserNodeMode } from '../browserNode';

import { debugLog, FragEntry, LogEntry, MAX_LOG_ENTRIES } from './debugLog';
import { bufferedAhead, median, shortRef, summarizeFrags, throughputMbps } from './stats';

import './DebugPanel.scss';

const MAX_ROWS = 300;
const SLOW_TTFB_MS = 2000;

interface DebugPanelProps {
  mediaRef: React.RefObject<HTMLMediaElement>;
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

function isErrorEntry(e: LogEntry) {
  if (e.kind === 'frag') return e.status === 'error' || e.status === 'aborted' || !!e.error;
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

export default function DebugPanel({ mediaRef }: DebugPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [height, setHeight] = useState(loadHeight);
  const startResize = useResizeHandle(setHeight);
  const [paused, setPaused] = useState(false);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [copyState, setCopyState] = useState('');
  const [tick, setTick] = useState({ version: debugLog.version, buffered: 0 });

  useEffect(() => {
    const id = setInterval(() => {
      const media = mediaRef.current;
      const buffered = media ? bufferedAhead(media.buffered, media.currentTime) : 0;
      setTick((prev) =>
        prev.version === debugLog.version && Math.abs(prev.buffered - buffered) < 0.05
          ? prev
          : { version: debugLog.version, buffered },
      );
    }, 500);
    return () => clearInterval(id);
  }, [mediaRef]);

  // Pause freezes what is shown; logging carries on underneath.
  const [frozen, setFrozen] = useState<LogEntry[] | null>(null);
  useEffect(() => {
    setFrozen(paused ? debugLog.entries.map((e) => ({ ...e })) : null);
  }, [paused]);

  const session = debugLog.session;
  const sessionId = session?.id ?? 0;

  const { rows, summary } = useMemo(() => {
    const all = frozen ?? debugLog.entries;
    const frags = all.filter((e): e is FragEntry => e.kind === 'frag' && e.session === sessionId);
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
              buffer <b>{tick.buffered.toFixed(1)}s</b> ahead
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
      <tr className={`msrs-debug__marker ${isErrorEntry(e) ? 'err' : ''}`}>
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

  const cls = e.status === 'error' ? 'err' : e.status === 'aborted' ? 'aborted' : isSlow(e) ? 'slow' : '';
  const start = e.requestStart ? `+${((e.requestStart - sessionStart) / 1000).toFixed(1)}s` : '-';
  const status =
    e.status === 'loading'
      ? 'loading…'
      : `${e.status}${e.httpStatus ? ` ${e.httpStatus}` : ''}${e.retries ? ` retry×${e.retries}` : ''}${
          e.attempt > 1 ? ` #${e.attempt}` : ''
        }${e.error ? ` ${e.error}` : ''}`;
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
