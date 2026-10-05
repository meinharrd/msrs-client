import { describe, expect, it, vi } from 'vitest';

import { ScrubEvent, ScrubSettle } from './scrubSettle';

function setup() {
  vi.useFakeTimers();
  const hooks = { onScrubStart: vi.fn(), onScrubSeek: vi.fn(), onSettle: vi.fn() };
  const s = new ScrubSettle(hooks, { settleMs: 300 });
  const events: ScrubEvent[] = [];
  s.subscribe((e) => events.push(e));
  return { s, hooks, events };
}

describe('ScrubSettle', () => {
  it('a single seek loads at once: nothing is stopped, nothing to settle', () => {
    const { s, hooks } = setup();
    s.seek();
    expect(s.state).toBe('armed');
    expect(hooks.onScrubStart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(s.state).toBe('idle');
    expect(hooks.onScrubStart).not.toHaveBeenCalled();
    expect(hooks.onSettle).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('a rapid sequence stops loading once, and loads once 300 ms after the last seek', () => {
    const { s, hooks, events } = setup();
    for (let i = 0; i < 81; i++) {
      s.seek();
      vi.advanceTimersByTime(12);
    }
    expect(s.state).toBe('scrubbing');
    expect(hooks.onScrubStart).toHaveBeenCalledTimes(1);
    expect(hooks.onScrubSeek).toHaveBeenCalledTimes(79);
    vi.advanceTimersByTime(287); // 299 ms after the last seek
    expect(hooks.onSettle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hooks.onSettle).toHaveBeenCalledTimes(1);
    expect(hooks.onSettle.mock.calls[0][0]).toBe(81);
    expect(s.state).toBe('idle');
    expect(events.filter((e) => e.type === 'settle')).toEqual([
      { type: 'settle', seeks: 81, durationMs: 81 * 12 + 288 },
    ]);
    vi.useRealTimers();
  });

  it('a pause in the drag shorter than 300 ms does not settle', () => {
    const { s, hooks } = setup();
    s.seek();
    s.seek();
    vi.advanceTimersByTime(250);
    s.seek();
    vi.advanceTimersByTime(250);
    expect(hooks.onSettle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(hooks.onSettle).toHaveBeenCalledWith(3, 550);
    vi.useRealTimers();
  });

  it('a seek after a settled scrub is a single seek again', () => {
    const { s, hooks } = setup();
    s.seek();
    s.seek();
    vi.advanceTimersByTime(300);
    expect(hooks.onSettle).toHaveBeenCalledTimes(1);
    s.seek();
    expect(s.state).toBe('armed');
    expect(hooks.onScrubStart).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300);
    expect(hooks.onSettle).toHaveBeenCalledTimes(1);
    // and a new drag is a new scrub
    s.seek();
    s.seek();
    expect(hooks.onScrubStart).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('two seeks 300 ms or more apart are two single seeks', () => {
    const { s, hooks } = setup();
    s.seek();
    vi.advanceTimersByTime(400);
    s.seek();
    expect(s.state).toBe('armed');
    expect(hooks.onScrubStart).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('destroy cancels a pending settle', () => {
    const { s, hooks } = setup();
    s.seek();
    s.seek();
    s.destroy();
    vi.advanceTimersByTime(1000);
    expect(hooks.onSettle).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
