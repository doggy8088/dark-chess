import { Firestore } from '@google-cloud/firestore'
import type { AnnouncementPersistence, AnnouncementRecord } from './announcements'
import type { HourPoint } from './metrics'
import type { MetricsPersistence } from './metrics'

/** Firestore-backed persistence for the admin console: announcement history
 *  and hourly metric rollups. Only instantiated when Firestore is enabled. */
export class FirestoreAdminStore implements AnnouncementPersistence, MetricsPersistence {
  private readonly db = new Firestore()
  private readonly announcements = this.db.collection('announcements')
  private readonly metricHours = this.db.collection('metrics_hours')

  async saveAnnouncement(record: AnnouncementRecord): Promise<void> {
    await this.announcements.doc(record.id).set({ ...record, acks: [...record.acks] })
  }

  async loadAnnouncements(limit: number): Promise<AnnouncementRecord[]> {
    const snapshot = await this.announcements.orderBy('at', 'desc').limit(limit).get()
    return snapshot.docs.map((doc) => {
      const data = doc.data() as { id?: string; text?: string; at?: number; reached?: number; acks?: unknown }
      return {
        id: typeof data.id === 'string' ? data.id : doc.id,
        text: typeof data.text === 'string' ? data.text : '',
        at: Number(data.at ?? 0),
        reached: Number(data.reached ?? 0),
        acks: Array.isArray(data.acks) ? new Set(data.acks.filter((name): name is string => typeof name === 'string')) : new Set(),
      }
    })
  }

  async saveHour(point: HourPoint): Promise<void> {
    await this.metricHours.doc(hourDocId(point.t)).set(point)
  }

  async loadHours(from: number, to: number): Promise<HourPoint[]> {
    const snapshot = await this.metricHours.where('t', '>=', from).where('t', '<=', to).get()
    return snapshot.docs.map((doc) => doc.data() as HourPoint)
  }
}

function hourDocId(t: number): string {
  return new Date(t).toISOString().slice(0, 13)
}