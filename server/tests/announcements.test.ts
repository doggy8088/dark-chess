import { describe, expect, it } from 'vitest'
import { AnnouncementBoard, type AnnouncementPersistence } from '../announcements'

type Doc = { id: string; text: string; at: number; reached: number; acks: string[]; endedAt?: number | null }

function makePersistence(options: { saveDelayMs?: number } = {}) {
  // Simulates Firestore docs: save overwrites the whole document per id.
  const docs = new Map<string, Doc>()
  const persistence: AnnouncementPersistence = {
    saveAnnouncement: async (record) => {
      const doc: Doc = { id: record.id, text: record.text, at: record.at, reached: record.reached, acks: [...record.acks], endedAt: record.endedAt }
      if (options.saveDelayMs) await new Promise((resolve) => setTimeout(resolve, options.saveDelayMs))
      docs.set(record.id, doc)
    },
    loadAnnouncements: async () =>
      [...docs.values()]
        .sort((a, b) => b.at - a.at)
        .slice(0, 50)
        .map((record) => ({ ...record, acks: new Set(record.acks), endedAt: record.endedAt ?? null })),
    deleteAnnouncement: async (id) => {
      docs.delete(id)
    },
  }
  return { persistence, saved: docs }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('AnnouncementBoard', () => {
  it('posts an announcement that becomes current, with reach counts', () => {
    const board = new AnnouncementBoard()
    const record = board.post('維護公告：今晚 23:00 重啟伺服器', 7, 1_000)
    expect(board.current()?.id).toBe(record.id)
    expect(record.text).toBe('維護公告：今晚 23:00 重啟伺服器')
    expect(record.reached).toBe(7)
    const view = board.list()[0]!
    expect(view).toEqual({ id: record.id, text: record.text, at: 1_000, reached: 7, acks: 0, active: true, endedAt: null })
  })

  it('records unique read receipts per name', () => {
    const board = new AnnouncementBoard()
    const record = board.post('大家好', 5, 1_000)
    board.ack(record.id, '阿明')
    board.ack(record.id, '阿明')
    board.ack(record.id, '小美')
    board.ack('no-such-id', '路人')
    board.ack(record.id, '')
    expect(board.list()[0]?.acks).toBe(2)
  })

  it('replaces the active announcement when a new one is posted', () => {
    const board = new AnnouncementBoard()
    const first = board.post('第一則', 3, 1_000)
    const second = board.post('第二則', 4, 2_000)
    expect(board.current()?.id).toBe(second.id)
    expect(board.list().length).toBe(2)
    // The replaced one is marked as ended when the new one went out.
    expect(board.list().find((entry) => entry.id === first.id)).toMatchObject({ active: false, endedAt: 2_000 })
    // Acking the replaced one still counts in history.
    board.ack(first.id, '阿明')
    expect(board.list().find((entry) => entry.id === first.id)?.acks).toBe(1)
  })

  it('withdraws the active announcement but keeps its history', () => {
    const board = new AnnouncementBoard()
    const record = board.post('測試訊息', 3, 1_000)
    board.ack(record.id, '阿明')
    expect(board.withdraw('no-such-id', 2_000)).toBe(false)
    expect(board.withdraw(record.id, 2_000)).toBe(true)
    expect(board.current()).toBeNull()
    expect(board.list()).toEqual([{ id: record.id, text: '測試訊息', at: 1_000, reached: 3, acks: 1, active: false, endedAt: 2_000 }])
    // Already off display: a second withdraw is a no-op.
    expect(board.withdraw(record.id, 3_000)).toBe(false)
    // Only the one on display can be withdrawn, not a superseded one.
    const next = board.post('正式公告', 1, 4_000)
    expect(board.withdraw(record.id, 5_000)).toBe(false)
    expect(board.current()?.id).toBe(next.id)
  })

  it('deletes announcements from history, taking the active one down', () => {
    const board = new AnnouncementBoard()
    const older = board.post('舊公告', 2, 1_000)
    const active = board.post('測試訊息', 3, 2_000)
    expect(board.remove('no-such-id')).toBe(false)
    expect(board.remove(older.id)).toBe(true)
    expect(board.current()?.id).toBe(active.id)
    expect(board.remove(active.id)).toBe(true)
    expect(board.current()).toBeNull()
    expect(board.list()).toEqual([])
    // Acks for a deleted announcement are ignored.
    board.ack(active.id, '阿明')
    expect(board.list()).toEqual([])
  })

  it('persists posts and acks through the adapter', async () => {
    const { persistence, saved } = makePersistence()
    const board = new AnnouncementBoard(persistence)
    const record = board.post('公告 A', 2, 5_000)
    board.ack(record.id, '阿明')
    await flush()
    expect(saved.get(record.id)?.acks).toEqual(['阿明'])

    const restored = new AnnouncementBoard(persistence)
    await restored.init()
    expect(restored.current()?.text).toBe('公告 A')
    expect(restored.list()[0]?.acks).toBe(1)
  })

  it('keeps a withdrawn announcement off display after a restart', async () => {
    const { persistence } = makePersistence()
    const board = new AnnouncementBoard(persistence)
    const record = board.post('測試訊息', 2, 1_000)
    board.withdraw(record.id, 2_000)
    await flush()

    const restored = new AnnouncementBoard(persistence)
    await restored.init()
    expect(restored.current()).toBeNull()
    expect(restored.list()[0]).toMatchObject({ id: record.id, active: false, endedAt: 2_000 })
  })

  it('does not resurrect an older legacy announcement after deleting the newest', async () => {
    const { persistence, saved } = makePersistence()
    // Docs written before withdrawal existed carry no endedAt.
    saved.set('old', { id: 'old', text: '舊公告', at: 1_000, reached: 1, acks: [] })
    saved.set('test', { id: 'test', text: '測試訊息', at: 2_000, reached: 1, acks: [] })
    const board = new AnnouncementBoard(persistence)
    await board.init()
    expect(board.current()?.id).toBe('test')

    expect(board.remove('test', 3_000)).toBe(true)
    expect(board.current()).toBeNull()
    await flush()
    expect(saved.has('test')).toBe(false)
    expect(saved.get('old')?.endedAt).toBe(3_000)

    const restored = new AnnouncementBoard(persistence)
    await restored.init()
    expect(restored.current()).toBeNull()
    expect(restored.list().map((entry) => entry.id)).toEqual(['old'])
  })

  it('never lets a slow save land after the delete of the same announcement', async () => {
    const { persistence, saved } = makePersistence({ saveDelayMs: 20 })
    const board = new AnnouncementBoard(persistence)
    const record = board.post('測試訊息', 2, 1_000)
    board.ack(record.id, '阿明')
    board.remove(record.id)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(saved.has(record.id)).toBe(false)
  })

  it('survives a failing persistence layer', async () => {
    const persistence: AnnouncementPersistence = {
      saveAnnouncement: async () => {
        throw new Error('store down')
      },
      loadAnnouncements: async () => {
        throw new Error('store down')
      },
      deleteAnnouncement: async () => {
        throw new Error('store down')
      },
    }
    const board = new AnnouncementBoard(persistence)
    await board.init()
    const record = board.post('仍可發送', 1, 1_000)
    board.ack(record.id, '阿明')
    expect(board.list()[0]?.acks).toBe(1)
    expect(board.remove(record.id)).toBe(true)
    expect(board.current()).toBeNull()
  })
})
