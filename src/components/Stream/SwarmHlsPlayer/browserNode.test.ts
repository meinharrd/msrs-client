import { describe, expect, it } from 'vitest';

import {
  base36DecodeToHexChunk,
  base36EncodeHexChunk,
  browserNodeMode,
  refFromVirtualBzzHost,
  segmentUrlFor,
  virtualBzzOrigin,
} from './browserNode';

// Vectors from freedom-browser-android infra/redirector/test-vectors.json ("bzz").
const PLAIN = '8f1d385f2493d4bcd4d3b2c1e3c1b8f7d1a09876543210fedcba98765432abcd';
const PLAIN_LABEL = '3kescpgjpg23w0jk9ccszdtmgq3mcqnthwg1oxbfcnb6w68t71';
const ENC_TAIL = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const ENC_TAIL_LABEL = '10r2curot7aoi80l0gyf25bl7y111lpgrb8bzoi8f0c1uhmgf';
const LEADING_ZEROS = '000000002493d4bcd4d3b2c1e3c1b8f7d1a09876543210fedcba98765432abcd';
const LEADING_ZEROS_LABEL = '0000gmt7pg0m47sf3innkz4sz73gbzf2xzswf47xjt5q025';
const ALL_ZERO = '0'.repeat(64);

describe('Freedom Android virtual-origin labels', () => {
  it.each([
    [PLAIN, PLAIN_LABEL],
    [ENC_TAIL, ENC_TAIL_LABEL],
    [LEADING_ZEROS, LEADING_ZEROS_LABEL],
    [ALL_ZERO, '0'.repeat(32)],
  ])('encodes %s and decodes it back', (hex, label) => {
    expect(base36EncodeHexChunk(hex)).toBe(label);
    expect(base36DecodeToHexChunk(label)).toBe(hex);
  });

  it('builds one label for a plain ref and two for an encrypted one', () => {
    expect(virtualBzzOrigin(PLAIN)).toBe(`https://${PLAIN_LABEL}.bzz.freedom.baby`);
    expect(virtualBzzOrigin(PLAIN + ENC_TAIL)).toBe(`https://${PLAIN_LABEL}.${ENC_TAIL_LABEL}.bzz.freedom.baby`);
    expect(refFromVirtualBzzHost(`${PLAIN_LABEL}.${ENC_TAIL_LABEL}.bzz.freedom.baby`)).toBe(PLAIN + ENC_TAIL);
    expect(refFromVirtualBzzHost('swarm.example.org')).toBeNull();
  });
});

describe('browserNodeMode', () => {
  it('tells Freedom desktop, Freedom Android and an ordinary page apart', () => {
    expect(browserNodeMode({ protocol: 'bzz:', hostname: PLAIN })).toBe('bzz-scheme');
    expect(browserNodeMode({ protocol: 'https:', hostname: `${PLAIN_LABEL}.bzz.freedom.baby` })).toBe(
      'freedom-virtual-origin',
    );
    expect(browserNodeMode({ protocol: 'https:', hostname: 'streamoverswarm-eth.ens.freedom.baby' })).toBe(
      'freedom-virtual-origin',
    );
    expect(browserNodeMode({ protocol: 'https:', hostname: 'vibing.at' })).toBeNull();
    expect(browserNodeMode({ protocol: 'http:', hostname: `${PLAIN_LABEL}.bzz.freedom.baby` })).toBeNull();
  });

  it('addresses a segment per mode', () => {
    expect(segmentUrlFor(PLAIN, 'bzz-scheme')).toBe(`bzz://${PLAIN}/`);
    expect(segmentUrlFor(PLAIN, 'freedom-virtual-origin')).toBe(`https://${PLAIN_LABEL}.bzz.freedom.baby/`);
  });
});
