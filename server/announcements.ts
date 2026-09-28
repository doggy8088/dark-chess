import { randomUUID } from 'node:crypto'

/**
 * Server-wide announcements. One active announcement at a time (posting a new
 * one replaces the old); every delivery expects an explicit acknowledgement
 * so the admin can track who has read it. History is kept for the console,
 * and the admin can withdraw the active one or delete any entry.
 */
export interface AnnouncementRecord {
  id: string
  text: string
  at: number
  /** How many clients the announcement was delivered to. */
  reached: number
  acks: Set<string>
  /** When it stopped being on display (withdrawn, or superseded by a newer
   *  one); null while it is still showing. */
  endedAt: number | null
}

export interface AnnouncementPersistence {
  saveAnnouncement(record: AnnouncementRecord): Promise<void>
  loadAnnouncements(limit: number): Promise<AnnouncementRecord[]>
  deleteAnnouncement(id: string): Promise<void>
}

export interface AnnouncementView {
  id: string
  text: string
  at: number
  reached: number
  acks: number
  /** Still on display — new visitors are shown it on arrival. */
  active: boolean
  endedAt: number | null
}

const HISTORY_LIMIT = 50

export class AnnouncementBoard {
  private records: AnnouncementRecord[] = []
  /** Invariant: either null or the id of records[0] (only the newest can show). */
  private activeId: string | null = null
  /** Per-id write chains so a late save can never resurrect a deleted doc. */
  private readonly writes = new Map<string, Promise<void>>()

  constructor(private readonly persistence?: AnnouncementPersistence) {}

  /** Restores recent announcements after a restart (best-effort). */
  async init(): Promise<void> {
    if (!this.persistence) return
    try {
      const loaded = await this.persistence.loadAnnouncements(HISTORY_LIMIT)
      this.records = loaded.map((record) => ({ ...record, acks: new Set(record.acks), endedAt: record.endedAt ?? null }))
      const newest = this.records[0]
      this.activeId = newest && newest.endedAt === null ? newest.id : null
    } catch (error) {
      console.error('announcement restore failed', error)
    }
  }

  post(text: string, reached: number, now = Date.now()): AnnouncementRecord {
    const previous = this.current()
    if (previous) {
      previous.endedAt = now
      this.persist(previous)
    }
    const record: AnnouncementRecord = { id: randomUUID(), text, at: now, reached, acks: new Set(), endedAt: null }
    this.records.unshift(record)
    if (this.records.length > HISTORY_LIMIT) this.records.length = HISTORY_LIMIT
    this.activeId = record.id
    this.persist(record)
    return record
  }

  current(): AnnouncementRecord | null {
    return this.records.find((record) => record.id === this.activeId) ?? null
  }

  /** Takes the active announcement off display; its history and read
   *  receipts stay. Returns false when `id` is not the one on display. */
  withdraw(id: string, now = Date.now()): boolean {
    const record = this.current()
    if (!record || record.id !== id) return false
    record.endedAt = now
    this.activeId = null
    this.persist(record)
    return true
  }

  /** Deletes an announcement from history and storage (taking it off display
   *  if it was showing). Returns false for an unknown id. */
  remove(id: string, now = Date.now()): boolean {
    const index = this.records.findIndex((record) => record.id === id)
    if (index < 0) return false
    this.records.splice(index, 1)
    if (this.activeId === id) this.activeId = null
    // init() treats the newest record as active unless it has ended. Records
    // saved before endedAt existed never ended explicitly, so close the new
    // newest one out — otherwise it would resurface after a restart.
    const newest = this.records[0]
    if (newest && this.activeId === null && newest.endedAt === null) {
      newest.endedAt = now
      this.persist(newest)
    }
    this.write(id, (persistence) => persistence.deleteAnnouncement(id))
    return true
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
      active: record.id === this.activeId,
      endedAt: record.endedAt,
    }))
  }

  private persist(record: AnnouncementRecord): void {
    this.write(record.id, (persistence) => persistence.saveAnnouncement(record))
  }

  private write(id: string, op: (persistence: AnnouncementPersistence) => Promise<void>): void {
    const persistence = this.persistence
    if (!persistence) return
    const next = (this.writes.get(id) ?? Promise.resolve())
      .then(() => op(persistence))
      .catch((error: unknown) => {
        console.error('announcement persist failed', error)
      })
    this.writes.set(id, next)
    void next.then(() => {
      if (this.writes.get(id) === next) this.writes.delete(id)
    })
  }
}
