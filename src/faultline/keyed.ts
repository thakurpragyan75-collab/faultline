/** Integer mixing and keyed randomness. Kernel code: no floats, no Math.random. */

/** Mix five uint32 values into one uint32. */
export function mix(a: number, b: number, c: number, d: number, e: number): number {
  let h = 0x811c9dc5;
  const parts = [a >>> 0, b >>> 0, c >>> 0, d >>> 0, e >>> 0];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] ?? 0;
    h ^= p & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (p >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (p >>> 16) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (p >>> 24) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Pure draw for one decision. Identity is `(seed, domain, a, b, c)`, never a
 * shared counter, so deleting one fault does not reshuffle unrelated draws.
 */
export function keyed(seed: number, domain: number, a: number, b: number, c: number): number {
  return mix(seed, domain, a, b, c);
}

/** Stable hash of a short ASCII string. */
export function strHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Decimal integer parse. Non-digits are skipped. No floating point. */
export function intOf(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i) - 48;
    if (c < 0 || c > 9) continue;
    n = n * 10 + c;
  }
  return n;
}

/** Population count of a small bitmask. */
export function popcount(v: number): number {
  let c = 0;
  let x = v >>> 0;
  while (x !== 0) {
    c += x & 1;
    x >>>= 1;
  }
  return c;
}
