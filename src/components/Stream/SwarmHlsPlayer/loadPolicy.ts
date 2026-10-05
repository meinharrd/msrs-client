// hls.js fragment-loading timeouts per mode.
//
// Through a gateway, hls.js's defaults stand: 10 s to first byte, then a fresh request (up to 4 times).
// On the local node (Freedom, browserNodeMode() != null) a segment the node is still searching for would be
// re-requested every 10 s, and each re-request joins the node's queue again; the node retries internally anyway.
// So there a slow segment gets one long-lived request: 30 s to first byte, 60 s in all, and fewer timeout retries.

import type { HlsConfig, LoaderConfig } from 'hls.js';

import type { BrowserNodeMode } from './browserNode';

export const BROWSER_NODE_FRAG_LOAD_POLICY: LoaderConfig = {
  maxTimeToFirstByteMs: 30_000,
  maxLoadTimeMs: 60_000,
  timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
  // As hls.js's default: an HTTP error (e.g. 404 while the node can't find it) retries with back-off.
  errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
};

/** The hls.js config overrides for fragment loading in `mode` (none in gateway mode). */
export function fragLoadConfigFor(mode: BrowserNodeMode | null): Partial<Pick<HlsConfig, 'fragLoadPolicy'>> {
  if (mode === null) return {};
  return { fragLoadPolicy: { default: BROWSER_NODE_FRAG_LOAD_POLICY } };
}
