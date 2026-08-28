import { describe, expect, it } from 'vitest'
import { FUN_NAMES, randomFunName, resolveNickname } from '../shared/fun-names'

describe('fun default nicknames', () => {
  it('offers at least 30 unique, short names', () => {
    expect(FUN_NAMES.length).toBeGreaterThanOrEqual(30)
    expect(new Set(FUN_NAMES).size).toBe(FUN_NAMES.length)
    for (const name of FUN_NAMES) {
      expect(name.length).toBeGreaterThan(0)
      // The server truncates nicknames at 12 chars — stay under it.
      expect(name.length).toBeLessThanOrEqual(12)
      // No bare placeholders — fun names must actually be fun.
      expect(['玩家一', '玩家二', '觀眾']).not.toContain(name)
    }
  })

  it('picks names from the list', () => {
    for (let i = 0; i < 50; i++) {
      expect(FUN_NAMES).toContain(randomFunName())
    }
  })

  it('avoids repeating the given name when possible', () => {
    const first = FUN_NAMES[0]!
    for (let i = 0; i < 50; i++) {
      expect(randomFunName(first)).not.toBe(first)
    }
  })

  it('keeps customized names but replaces placeholders', () => {
    expect(resolveNickname('阿明')).toBe('阿明')
    expect(FUN_NAMES).toContain(resolveNickname('玩家一'))
    expect(FUN_NAMES).toContain(resolveNickname(''))
    expect(FUN_NAMES).toContain(resolveNickname(null))
  })
})