import Hls from 'hls.js';
import { describe, expect, it } from 'vitest';

import { browserNodeMode } from './browserNode';
import { fragLoadConfigFor } from './loadPolicy';

describe('fragLoadConfigFor', () => {
  it('gateway mode keeps hls.js defaults', () => {
    expect(fragLoadConfigFor(null)).toEqual({});
    expect(fragLoadConfigFor(browserNodeMode({ protocol: 'https:', hostname: 'streamoverswarm.eth.limo' }))).toEqual(
      {},
    );
  });

  it.each([
    ['bzz:', 'abc'],
    ['https:', 'msrs.bzz.freedom.baby'],
    ['https:', 'streamoverswarm.ens.freedom.baby'],
  ])('browser-node mode (%s//%s) gives one long-lived request per segment', (protocol, hostname) => {
    const cfg = fragLoadConfigFor(browserNodeMode({ protocol, hostname }));
    const p = cfg.fragLoadPolicy!.default;
    expect(p.maxTimeToFirstByteMs).toBe(30_000);
    expect(p.maxLoadTimeMs).toBe(60_000);
    expect(p.timeoutRetry!.maxNumRetry).toBeLessThan(
      Hls.DefaultConfig.fragLoadPolicy.default.timeoutRetry!.maxNumRetry,
    );
    expect(p.maxTimeToFirstByteMs).toBeGreaterThan(Hls.DefaultConfig.fragLoadPolicy.default.maxTimeToFirstByteMs);
  });

  it('is accepted by hls.js and lands in its config', () => {
    const hls = new Hls(fragLoadConfigFor('bzz-scheme'));
    expect(hls.config.fragLoadPolicy.default.maxTimeToFirstByteMs).toBe(30_000);
    expect(hls.config.fragLoadPolicy.default.maxLoadTimeMs).toBe(60_000);
    hls.destroy();
    expect(new Hls(fragLoadConfigFor(null)).config.fragLoadPolicy.default.maxTimeToFirstByteMs).toBe(10_000);
  });
});
