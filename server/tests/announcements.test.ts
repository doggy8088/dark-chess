import { describe, expect, it } from 'vitest'
import { AnnouncementBoard, type AnnouncementPersistence } from '../announcements'

function makePersistence() {
  // Simulates Firestore docs: save overwrites the whole document per id.
  const docs = new Map<string, { id: string; text: string; at: number; reached: number; acks: string[] }>()
  const persistence: AnnouncementPersistence = {
    saveAnnouncement: async (record) => {
      docs.set(record.id, { id: record.id, text: record.text, at: record.at, reached: record.reached, acks: [...record.acks] })
    },
    loadAnnouncements: async () =>
      [...docs.values()]
        .sort((a, b) => b.at - a.at)
        .slice(0, 50)
        .map((record) => ({ id: record.id, text: record.text, at: record.at, reached: record.reached, acks: new Set(record.acks) })),
  }
  return { persistence, saved: docs }
}

describe('AnnouncementBoard', () => {
  it('posts an announcement that becomes current, with reach counts', () => {
    const board = new AnnouncementBoard()
    const record = board.post('維護公告：今晚 23:00 重啟伺服器', 7, 1_000)
    expect(board.current()?.id).toBe(record.id)
    expect(record.text).toBe('維護公告：今晚 23:00 重啟伺服器')
    expect(record.reached).toBe(7)
    const view = board.list()[0]!
    expect(view).toEqual({ id: record.id, text: record.text, at: 1_000, reached: 7, acks: 0 })
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
    // Acking the replaced one still counts in history.
    board.ack(first.id, '阿明')
    expect(board.list().find((entry) => entry.id === first.id)?.acks).toBe(1)
  })

  it('persists posts and acks through the adapter', async () => {
    const { persistence, saved } = makePersistence()
    const board = new AnnouncementBoard(persistence)
    const record = board.post('公告 A', 2, 5_000)
    board.ack(record.id, '阿明')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(saved.get(record.id)?.acks).toEqual(['阿明'])

    const restored = new AnnouncementBoard(persistence)
    await restored.init()
    expect(restored.current()?.text).toBe('公告 A')
    expect(restored.list()[0]?.acks).toBe(1)
  })

  it('survives a failing persistence layer', async () => {
    const persistence: AnnouncementPersistence = {
      saveAnnouncement: async () => {
        throw new Error('store down')
      },
      loadAnnouncements: async () => {
        throw new Error('store down')
      },
    }
    const board = new AnnouncementBoard(persistence)
    await board.init()
    const record = board.post('仍可發送', 1, 1_000)
    board.ack(record.id, '阿明')
    expect(board.list()[0]?.acks).toBe(1)
  })
})