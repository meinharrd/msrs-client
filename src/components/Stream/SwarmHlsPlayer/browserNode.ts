// Which browser-node mode the page runs in, and how a segment reference is addressed in it.
//
// Freedom desktop serves Swarm pages on its own `bzz:` scheme, so a segment is `bzz://<ref>/`.
// Freedom Android serves them from virtual https origins it intercepts, `https://<label>.bzz.freedom.baby/`,
// where the label is the reference in base36 (one label per 64-hex chunk, most significant first). That
// encoding must match Freedom Android's VirtualOrigin.kt and its redirector's test vectors.

export type BrowserNodeMode = 'bzz-scheme' | 'freedom-virtual-origin';

const VIRTUAL_SUFFIXES = ['.bzz.freedom.baby', '.ens.freedom.baby'];
const BZZ_VIRTUAL_SUFFIX = '.bzz.freedom.baby';
const CHUNK_HEX = 64;

export function browserNodeMode(
  loc: Pick<Location, 'protocol' | 'hostname'> | undefined = typeof window !== 'undefined'
    ? window.location
    : undefined,
): BrowserNodeMode | null {
  if (!loc) return null;
  if (loc.protocol === 'bzz:') return 'bzz-scheme';
  const host = loc.hostname.toLowerCase();
  if (loc.protocol === 'https:' && VIRTUAL_SUFFIXES.some((s) => host.endsWith(s))) return 'freedom-virtual-origin';
  return null;
}

/** 64-hex chunk → base36 label; leading zero bytes become leading '0' characters (multibase convention). */
export function base36EncodeHexChunk(hexChunk: string): string {
  let leadingZeroBytes = 0;
  let i = 0;
  while (i + 1 < hexChunk.length && hexChunk[i] === '0' && hexChunk[i + 1] === '0') {
    leadingZeroBytes++;
    i += 2;
  }
  const n = BigInt('0x' + hexChunk);
  const body = n === 0n ? '' : n.toString(36);
  return '0'.repeat(leadingZeroBytes) + body;
}

/** base36 label → 64-hex chunk, or null if it doesn't decode. The inverse of base36EncodeHexChunk. */
export function base36DecodeToHexChunk(label: string): string | null {
  if (!/^[0-9a-z]+$/.test(label)) return null;
  let zeros = 0;
  while (zeros < label.length && label[zeros] === '0') zeros++;
  let n = 0n;
  for (const ch of label.slice(zeros)) n = n * 36n + BigInt(parseInt(ch, 36));
  const hex = n === 0n ? '' : n.toString(16);
  if (zeros * 2 + hex.length > CHUNK_HEX) return null;
  return '0'.repeat(CHUNK_HEX - hex.length) + hex;
}

/** `https://<label>[.<label>].bzz.freedom.baby` for a 64- or 128-hex reference. */
export function virtualBzzOrigin(ref: string): string {
  const hex = ref.toLowerCase();
  const labels = [];
  for (let i = 0; i < hex.length; i += CHUNK_HEX) labels.push(base36EncodeHexChunk(hex.slice(i, i + CHUNK_HEX)));
  return `https://${labels.join('.')}${BZZ_VIRTUAL_SUFFIX}`;
}

/** The reference a `*.bzz.freedom.baby` host stands for, or null. */
export function refFromVirtualBzzHost(host: string): string | null {
  const h = host.toLowerCase();
  if (!h.endsWith(BZZ_VIRTUAL_SUFFIX)) return null;
  const labels = h.slice(0, -BZZ_VIRTUAL_SUFFIX.length).split('.');
  if (labels.length < 1 || labels.length > 2) return null;
  const chunks = labels.map(base36DecodeToHexChunk);
  return chunks.every((c) => c !== null) ? chunks.join('') : null;
}

/** Where a segment with reference `ref` is loaded from in `mode`. */
export function segmentUrlFor(ref: string, mode: BrowserNodeMode): string {
  return mode === 'bzz-scheme' ? `bzz://${ref.toLowerCase()}/` : `${virtualBzzOrigin(ref)}/`;
}
