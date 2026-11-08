// Fast word lookup for a rack of letters.
//
// Every word gets a 26-bit mask of the letters it uses. A rack can only spell
// a word whose mask is a subset of the rack's mask, which rejects almost the
// whole list with one AND before counting any letters. Words are kept sorted
// by reward (best first) so the first spellable word is the best one.

export const LETTER_VALUE: Record<string, number> = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8,
  K: 5, L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1,
  U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10,
};

// Same integer maths as the server: base * num / denom, rounded down.
export function lengthMult(len: number): [number, number] {
  if (len <= 3) return [1, 1];
  if (len === 4) return [3, 2];
  if (len === 5) return [2, 1];
  if (len === 6) return [5, 2];
  return [3, 1];
}

export function wordReward(word: string): number {
  let base = 0;
  for (const c of word) base += LETTER_VALUE[c] ?? 0;
  const [n, d] = lengthMult(word.length);
  return Math.floor((base * n) / d);
}

export type Rack = Map<string, number>;

export interface WordIndex {
  words: string[]; // sorted by reward desc, then length desc
  masks: Int32Array;
  rewards: Int32Array;
}

const A = 65;

function maskOf(word: string): number {
  let m = 0;
  for (let i = 0; i < word.length; i++) m |= 1 << (word.charCodeAt(i) - A);
  return m;
}

const cache = new WeakMap<string[], WordIndex>();

export function buildIndex(dictionary: string[]): WordIndex {
  const hit = cache.get(dictionary);
  if (hit) return hit;
  const items: { w: string; r: number }[] = [];
  for (const raw of dictionary) {
    const w = raw.trim().toUpperCase();
    if (w.length < 2 || !/^[A-Z]+$/.test(w)) continue;
    items.push({ w, r: wordReward(w) });
  }
  items.sort((a, b) => b.r - a.r || b.w.length - a.w.length);
  const idx: WordIndex = {
    words: items.map((i) => i.w),
    masks: Int32Array.from(items, (i) => maskOf(i.w)),
    rewards: Int32Array.from(items, (i) => i.r),
  };
  cache.set(dictionary, idx);
  return idx;
}

function rackArrays(rack: Rack): { counts: Int32Array; mask: number; total: number } {
  const counts = new Int32Array(26);
  let mask = 0;
  let total = 0;
  for (const [c, n] of rack) {
    if (n <= 0) continue;
    const s = c.charCodeAt(0) - A;
    if (s < 0 || s >= 26) continue;
    counts[s] += n;
    mask |= 1 << s;
    total += n;
  }
  return { counts, mask, total };
}

const scratch = new Int32Array(26);

function spellable(word: string, counts: Int32Array): boolean {
  scratch.fill(0);
  for (let i = 0; i < word.length; i++) {
    const s = word.charCodeAt(i) - A;
    if (++scratch[s] > counts[s]) return false;
  }
  return true;
}

/** Up to `limit` spellable words, best reward first. */
export function candidates(
  idx: WordIndex,
  rack: Rack,
  limit: number,
  minLen = 2,
): string[] {
  const { counts, mask, total } = rackArrays(rack);
  const out: string[] = [];
  if (total < minLen) return out;
  const notMask = ~mask;
  const { words, masks } = idx;
  for (let i = 0; i < words.length && out.length < limit; i++) {
    if (masks[i] & notMask) continue;
    const w = words[i];
    if (w.length > total || w.length < minLen) continue;
    if (spellable(w, counts)) out.push(w);
  }
  return out;
}

export function bestWord(idx: WordIndex, rack: Rack, minLen = 2): string | null {
  return candidates(idx, rack, 1, minLen)[0] ?? null;
}

export function without(rack: Rack, word: string): Rack {
  const r = new Map(rack);
  for (const c of word) {
    const n = (r.get(c) ?? 0) - 1;
    if (n <= 0) r.delete(c);
    else r.set(c, n);
  }
  return r;
}

export function withLetter(rack: Rack, letter: string): Rack {
  const r = new Map(rack);
  r.set(letter, (r.get(letter) ?? 0) + 1);
  return r;
}

export function rackSize(rack: Rack): number {
  let n = 0;
  for (const v of rack.values()) n += v;
  return n;
}

/**
 * What the rack is worth if cashed out right now: greedily play the best
 * word, then the best word from what's left, up to `maxWords` words.
 */
export function cashOutValue(idx: WordIndex, rack: Rack, maxWords = 3): number {
  let r = rack;
  let total = 0;
  for (let k = 0; k < maxWords; k++) {
    const w = bestWord(idx, r);
    if (!w) break;
    total += wordReward(w);
    r = without(r, w);
  }
  return total;
}
