/** Deterministic randomness for sample data: the same key always gives the same number. */
function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Uniform number in [0, 1) derived from the key. */
export const rand = (key: string) => {
  let t = (hash(key) + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export const between = (key: string, min: number, max: number) => min + rand(key) * (max - min);

/** One of the items, picked by the key. */
export const pick = <T>(key: string, items: readonly T[]): T => items[Math.floor(rand(key) * items.length)]!;
