import { Firestore } from '@google-cloud/firestore'
import type { AnnouncementPersistence, AnnouncementRecord } from './announcements'
import type { HourPoint } from './metrics'
import type { MetricsPersistence } from './metrics'
import type { IpAlert, IpHourPoint, IpMonitorPersistence } from './ip-monitor'

/** Firestore-backed persistence for the admin console: announcement history,
 *  hourly metric rollups, and per-IP traffic / block data. */
export class FirestoreAdminStore implements AnnouncementPersistence, MetricsPersistence, IpMonitorPersistence {
  private readonly db = new Firestore()
  private readonly announcements = this.db.collection('announcements')
  private readonly metricHours = this.db.collection('metrics_hours')
  private readonly ipHours = this.db.collection('ip_hours')
  private readonly ipBlocks = this.db.collection('ip_blocks')
  private readonly ipAlerts = this.db.collection('ip_alerts')

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

  // ------------------------------------------------------------ IP 監控資料

  async saveIpBlock(block: { ip: string; blockedAt: number; expiresAt: number | null; blockedBy: string }): Promise<void> {
    await this.ipBlocks.doc(block.ip).set(block)
  }

  async deleteIpBlock(ip: string): Promise<void> {
    await this.ipBlocks.doc(ip).delete()
  }

  async loadIpBlocks(): Promise<Array<{ ip: string; blockedAt: number; expiresAt: number | null; blockedBy: string }>> {
    const snapshot = await this.ipBlocks.get()
    return snapshot.docs
      .map((doc) => {
        const data = doc.data() as { ip?: string; blockedAt?: number; expiresAt?: number | null; blockedBy?: string }
        return {
          ip: typeof data.ip === 'string' ? data.ip : doc.id,
          blockedAt: Number(data.blockedAt ?? 0),
          expiresAt: data.expiresAt === null || data.expiresAt === undefined ? null : Number(data.expiresAt),
          blockedBy: typeof data.blockedBy === 'string' ? data.blockedBy : '',
        }
      })
  }

  async saveIpHour(point: IpHourPoint): Promise<void> {
    await this.ipHours.doc(ipHourDocId(point.ip, point.t)).set(point)
  }

  async loadIpHours(from: number, to: number): Promise<IpHourPoint[]> {
    const snapshot = await this.ipHours.where('t', '>=', from).where('t', '<=', to).get()
    return snapshot.docs.map((doc) => doc.data() as IpHourPoint)
  }

  async saveIpAlert(alert: IpAlert): Promise<void> {
    await this.ipAlerts.doc(alert.id).set(alert)
  }

  async loadIpAlerts(limit: number): Promise<IpAlert[]> {
    const snapshot = await this.ipAlerts.orderBy('at', 'desc').limit(limit).get()
    return snapshot.docs.map((doc) => doc.data() as IpAlert)
  }

  async deleteIpDataOlderThan(cutoff: number): Promise<void> {
    await this.deleteOldDocs(this.ipHours.where('t', '<', cutoff))
    await this.deleteOldDocs(this.ipAlerts.where('at', '<', cutoff))
  }

  private async deleteOldDocs(query: FirebaseFirestore.Query): Promise<void> {
    const snapshot = await query.limit(300).get()
    if (snapshot.empty) return
    const batch = this.db.batch()
    for (const doc of snapshot.docs) batch.delete(doc.ref)
    await batch.commit()
  }
}

function hourDocId(t: number): string {
  return new Date(t).toISOString().slice(0, 13)
}

function ipHourDocId(ip: string, t: number): string {
  return `${ip}_${new Date(t).toISOString().slice(0, 13)}`
}