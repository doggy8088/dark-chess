import { describe, it, expect } from 'vitest'

describe('Chinese stroke collation for room members', () => {
  it('sorts names by Traditional Chinese stroke count', () => {
    const strokeCollator = new Intl.Collator('zh-Hant-TW-u-co-stroke', { numeric: true, sensitivity: 'base' })
    const names = ['張三', '王小明', '丁大同', '李四', '林大明', '乙', '一']
    const sorted = [...names].sort((a, b) => strokeCollator.compare(a, b))

    // 一 (1), 乙 (1), 丁 (2), 王 (4), 李 (7), 林 (8), 張 (11)
    expect(sorted).toEqual(['一', '乙', '丁大同', '王小明', '李四', '林大明', '張三'])
  })

  it('handles alphanumeric and Chinese mixed names stably', () => {
    const strokeCollator = new Intl.Collator('zh-Hant-TW-u-co-stroke', { numeric: true, sensitivity: 'base' })
    const names = ['Will', 'Alice', '王小明', '123', '丁大同']
    const sorted = [...names].sort((a, b) => strokeCollator.compare(a, b))
    expect(sorted.length).toBe(5)
  })
})
