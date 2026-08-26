/**
 * Cryptographically secure, unbiased shuffling.
 * Uses crypto.getRandomValues with rejection sampling (no modulo bias).
 */

/** Returns a uniformly distributed integer in [0, maxExclusive). */
export function secureRandomInt(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 0x100000000) {
    throw new RangeError(`secureRandomInt: invalid bound ${maxExclusive}`)
  }
  if (maxExclusive === 1) return 0
  const range = 0x100000000 // 2^32
  const limit = range - (range % maxExclusive)
  const buf = new Uint32Array(1)
  for (;;) {
    crypto.getRandomValues(buf)
    const value = buf[0]!
    if (value < limit) return value % maxExclusive
  }
}

/** Unbiased Fisher-Yates shuffle. Returns a new array; the input is not mutated. */
export function fisherYatesShuffle<T>(items: readonly T[]): T[] {
  const result = items.slice()
  for (let i = result.length - 1; i > 0; i--) {
    const j = secureRandomInt(i + 1)
    const tmp = result[i]!
    result[i] = result[j]!
    result[j] = tmp
  }
  return result
}

/** Convenience wrapper matching the rule-engine API surface. */
export function shufflePieces<T>(pieces: readonly T[]): T[] {
  return fisherYatesShuffle(pieces)
}
