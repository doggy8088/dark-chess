import { describe, expect, it } from 'vitest'
import { CANNED_MESSAGES, cannedText } from '../shared/canned'

describe('canned quick-chat messages', () => {
  it('has unique ids', () => {
    const ids = CANNED_MESSAGES.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('round-trips every id through the server-side lookup', () => {
    for (const m of CANNED_MESSAGES) {
      expect(cannedText(m.id)).toBe(m.text)
    }
    expect(cannedText('no-such-id')).toBeNull()
  })

  it('keeps every text within the chat length limit', () => {
    for (const m of CANNED_MESSAGES) {
      expect(m.text.length).toBeGreaterThan(0)
      expect(m.text.length).toBeLessThanOrEqual(120)
    }
  })

  it('includes the requested phrases (36 original + 40 new)', () => {
    const texts = CANNED_MESSAGES.map((m) => m.text)
    expect(texts).toContain('乾～太倒楣了吧！')
    expect(texts).toContain('乾乾乾乾乾～')
    expect(texts).toContain('你認真？')
    expect(CANNED_MESSAGES.length).toBe(76)
  })
})