import { randomUUID } from 'node:crypto'

/**
 * Server-wide announcements. One active announcement at a time (posting a new
 * one replaces the old); every delivery expects an explicit acknowledgement
 * so the admin can track who has read it. History is kept for the console.
 */
export interface AnnouncementRecord {
  id: string
  text: string
  at: number
  /** How many clients the announcement was delivered to. */
  reached: number
  acks: Set<string>
}

export interface AnnouncementPersistence {
  saveAnnouncement(record: AnnouncementRecord): Promise<void>
  loadAnnouncements(limit: number): Promise<AnnouncementRecord[]>
}

export interface AnnouncementView {
  id: string
  text: string
  at: number
  reached: number
  acks: number
}

const HISTORY_LIMIT = 50

export class AnnouncementBoard {
  private records: AnnouncementRecord[] = []
  private activeId: string | null = null

  constructor(private readonly persistence?: AnnouncementPersistence) {}

  /** Restores recent announcements after a restart (best-effort). */
  async init(): Promise<void> {
    if (!this.persistence) return
    try {
      const loaded = await this.persistence.loadAnnouncements(HISTORY_LIMIT)
      this.records = loaded.map((record) => ({ ...record, acks: new Set(record.acks) }))
      this.activeId = this.records[0]?.id ?? null
    } catch (error) {
      console.error('announcement restore failed', error)
    }
  }

  post(text: string, reached: number, now = Date.now()): AnnouncementRecord {
    const record: AnnouncementRecord = { id: randomUUID(), text, at: now, reached, acks: new Set() }
    this.records.unshift(record)
    if (this.records.length > HISTORY_LIMIT) this.records.length = HISTORY_LIMIT
    this.activeId = record.id
    this.persist(record)
    return record
  }

  current(): AnnouncementRecord | null {
    return this.records.find((record) => record.id === this.activeId) ?? null
  }

  /** Records a read receipt; unknown names are ignored. */
  ack(id: string, name: string): void {
    const record = this.records.find((entry) => entry.id === id)
    if (!record || !name) return
    if (record.acks.has(name)) return
    record.acks.add(name)
    this.persist(record)
  }

  list(): AnnouncementView[] {
    return this.records.map((record) => ({
      id: record.id,
      text: record.text,
      at: record.at,
      reached: record.reached,
      acks: record.acks.size,
    }))
  }

  private persist(record: AnnouncementRecord): void {
    if (!this.persistence) return
    void this.persistence.saveAnnouncement(record).catch((error: unknown) => {
      console.error('announcement persist failed', error)
    })
  }
}