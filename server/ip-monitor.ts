import { randomUUID } from 'node:crypto'

/**
 * Per-IP traffic tracking, anomaly alerting, and blocking for the admin
 * console. Designed for humans to judge abuse: minute counters feed alerts
 * against configurable thresholds, hourly buckets keep 7 days of history,
 * and the block list supports timed or permanent bans.
 *
 * Memory bounds: IPs unseen for IP_RETENTION_MS are pruned; alert history is
 * capped. Firestore persistence (via IpMonitorPersistence) keeps history and
 * blocks across deploys.
 */

/** 流量歷史保留上限（7 天）。 */
export const IP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** 異常閥值（每個 IP）：超過即產生告警，供人類判斷是否為攻擊。 */
export const IP_ALERT_HTTP_PER_MIN = Number(process.env.IP_ALERT_HTTP_PER_MIN ?? 120)
export const IP_ALERT_WS_PER_MIN = Number(process.env.IP_ALERT_WS_PER_MIN ?? 600)
export const IP_ALERT_CONN_PER_MIN = Number(process.env.IP_ALERT_CONN_PER_MIN ?? 10)
export const IP_ALERT_HTTP_PER_HOUR = Number(process.env.IP_ALERT_HTTP_PER_HOUR ?? 2_000)

export type IpAlertType = 'http-flood' | 'ws-flood' | 'conn-storm' | 'http-hourly'

export interface IpAlert {
  id: string
  ip: string
  type: IpAlertType
  detail: string
  at: number
}

export interface IpBlock {
  ip: string
  blockedAt: number
  /** Epoch ms when the block lifts; null = 永久. */
  expiresAt: number | null
  blockedBy: string
}

export interface IpHourPoint {
  ip: string
  t: number
  http: number
  wsMsg: number
  connEvents: number
}

export interface IpMonitorPersistence {
  saveIpBlock(block: { ip: string; blockedAt: number; expiresAt: number | null; blockedBy: string }): Promise<void>
  deleteIpBlock(ip: string): Promise<void>
  loadIpBlocks(): Promise<Array<{ ip: string; blockedAt: number; expiresAt: number | null; blockedBy: string }>>
  saveIpHour(point: IpHourPoint): Promise<void>
  loadIpHours(from: number, to: number): Promise<IpHourPoint[]>
  saveIpAlert(alert: IpAlert): Promise<void>
  loadIpAlerts(limit: number): Promise<IpAlert[]>
  deleteIpDataOlderThan(cutoff: number): Promise<void>
}

export type IpBlockDuration = '5m' | '30m' | '1h' | '6h' | '24h' | '7d' | 'permanent'

export const IP_BLOCK_DURATIONS: Record<Exclude<IpBlockDuration, 'permanent'>, number> = {
  '5m': 5 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
}

export function isIpBlockDuration(value: unknown): value is IpBlockDuration {
  return typeof value === 'string' && (value === 'permanent' || value in IP_BLOCK_DURATIONS)
}

/** 寬鬆的 IP 格式檢查（IPv4 / 縮寫 IPv6），阻擋明顯亂輸入。 */
export function looksLikeIp(value: string): boolean {
  const v = value.trim()
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(v)) return v.split('.').every((part) => Number(part) <= 255)
  return /^[0-9a-fA-F:]{2,45}$/.test(v) && v.includes(':')
}

const ALERT_HISTORY_LIMIT = 200
const MAX_TRACKED_IPS = 5_000

interface IpRecord {
  ip: string
  firstSeen: number
  lastSeen: number
  http: number
  wsMsg: number
  connEvents: number
  currentMinute: { t: number; http: number; wsMsg: number; conns: number }
  hours: Map<number, { http: number; wsMsg: number; connEvents: number }>
}

export interface IpTopRow {
  ip: string
  http: number
  wsMsg: number
  connEvents: number
  concurrent: number
  firstSeen: number
  lastSeen: number
  blocked: boolean
  blockExpiresAt: number | null
}

export class IpMonitor {
  private readonly records = new Map<string, IpRecord>()
  private readonly concurrent = new Map<string, number>()
  private readonly blocks = new Map<string, { ip: string; blockedAt: number; expiresAt: number | null; blockedBy: string }>()
  private alerts: IpAlert[] = []
  private lastPersistAt = 0
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly persistence?: IpMonitorPersistence) {}

  /** 載入既有封鎖名單與警示（重啟後還原）。 */
  async init(): Promise<void> {
    if (!this.persistence) return
    try {
      const now = Date.now()
      for (const block of await this.persistence.loadIpBlocks()) {
        if (block.expiresAt !== null && block.expiresAt <= now) {
          void this.persistence.deleteIpBlock(block.ip).catch(() => undefined)
          continue
        }
        this.blocks.set(block.ip, block)
      }
      this.alerts = (await this.persistence.loadIpAlerts(ALERT_HISTORY_LIMIT)).sort((a, b) => b.at - a.at)
      void this.persistence.deleteIpDataOlderThan(now - IP_RETENTION_MS).catch(() => undefined)
    } catch (error) {
      console.error('ip monitor restore failed', error)
    }
  }

  start(collectIntervalMs = 60_000): void {
    if (this.timer) return
    this.timer = setInterval(() => this.collect(), collectIntervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // -------------------------------------------------------------- recording

  private record(ip: string, kind: 'http' | 'wsMsg' | 'conns', now: number): void {
    const t = Math.floor(now / 60_000) * 60_000
    let record = this.records.get(ip)
    if (!record) {
      if (this.records.size >= MAX_TRACKED_IPS) this.prune(now, true)
      record = { ip, firstSeen: now, lastSeen: now, http: 0, wsMsg: 0, connEvents: 0, currentMinute: { t, http: 0, wsMsg: 0, conns: 0 }, hours: new Map() }
      this.records.set(ip, record)
    }
    record.lastSeen = now
    if (record.currentMinute.t !== t) {
      // 上一分鐘已完整：先評估告警再彙整。
      this.evaluateAlerts(record, record.currentMinute)
      this.foldMinute(record)
      record.currentMinute = { t, http: 0, wsMsg: 0, conns: 0 }
    }
    record.currentMinute[kind]++
    if (kind !== 'conns') record[kind]++
  }

  recordHttp(ip: string, now = Date.now()): void {
    this.record(ip, 'http', now)
  }

  recordWsMessage(ip: string, now = Date.now()): void {
    this.record(ip, 'wsMsg', now)
  }

  recordWsConnect(ip: string, now = Date.now()): void {
    this.concurrent.set(ip, (this.concurrent.get(ip) ?? 0) + 1)
    this.record(ip, 'conns', now)
    const record = this.records.get(ip)
    if (record) record.connEvents++
  }

  recordWsDisconnect(ip: string): void {
    const current = this.concurrent.get(ip) ?? 0
    if (current <= 1) this.concurrent.delete(ip)
    else this.concurrent.set(ip, current - 1)
  }

  concurrentOf(ip: string): number {
    return this.concurrent.get(ip) ?? 0
  }

  // -------------------------------------------------- minute fold + alerts

  private foldMinute(record: IpRecord): void {
    const minute = record.currentMinute
    const hour = Math.floor(minute.t / 3_600_000) * 3_600_000
    const bucket = record.hours.get(hour) ?? { http: 0, wsMsg: 0, connEvents: 0 }
    bucket.http += minute.http
    bucket.wsMsg += minute.wsMsg
    bucket.connEvents += minute.conns
    record.hours.set(hour, bucket)
    const cutoff = minute.t - IP_RETENTION_MS
    for (const key of record.hours.keys()) {
      if (key < cutoff) record.hours.delete(key)
    }
  }

  /** 每分鐘彙整 + 依閥值產生告警（即時監控）。 */
  collect(now = Date.now()): void {
    for (const record of this.records.values()) {
      if (record.currentMinute.t !== Math.floor(now / 60_000) * 60_000) {
        this.evaluateAlerts(record, record.currentMinute)
        this.foldMinute(record)
        record.currentMinute = { t: Math.floor(now / 60_000) * 60_000, http: 0, wsMsg: 0, conns: 0 }
      }
      if (now - record.lastSeen > IP_RETENTION_MS) this.records.delete(record.ip)
    }
    this.prune(now)
    void this.persistHourly(now)
  }

  private prune(now: number, force = false): void {
    if (!force && this.records.size < MAX_TRACKED_IPS) return
    const cutoff = now - IP_RETENTION_MS
    for (const [ip, record] of this.records) {
      if (record.lastSeen < cutoff) this.records.delete(ip)
    }
    for (const [ip, block] of this.blocks) {
      if (block.expiresAt !== null && block.expiresAt <= now) {
        this.blocks.delete(ip)
        void this.persistence?.deleteIpBlock(ip).catch(() => undefined)
      }
    }
    this.alerts = this.alerts.filter((alert) => alert.at >= cutoff)
  }

  private evaluateAlerts(record: IpRecord, minute: { t: number; http: number; wsMsg: number; conns: number }): void {
    if (minute.http > IP_ALERT_HTTP_PER_MIN) {
      this.pushAlert(record.ip, 'http-flood', `單分鐘 HTTP 請求 ${minute.http} 次（閥值 ${IP_ALERT_HTTP_PER_MIN}）`, minute.t)
    }
    if (minute.wsMsg > IP_ALERT_WS_PER_MIN) {
      this.pushAlert(record.ip, 'ws-flood', `單分鐘 WS 訊息 ${minute.wsMsg} 則（閥值 ${IP_ALERT_WS_PER_MIN}）`, minute.t)
    }
    if (minute.conns > IP_ALERT_CONN_PER_MIN) {
      this.pushAlert(record.ip, 'conn-storm', `單分鐘建立 ${minute.conns} 條 WS 連線（閥值 ${IP_ALERT_CONN_PER_MIN}）`, minute.t)
    }
    const hour = Math.floor(minute.t / 3_600_000) * 3_600_000
    const bucket = record.hours.get(hour)
    if (bucket && bucket.http > IP_ALERT_HTTP_PER_HOUR) {
      this.pushAlert(record.ip, 'http-hourly', `單小時 HTTP 請求 ${bucket.http} 次（閥值 ${IP_ALERT_HTTP_PER_HOUR}）`, minute.t)
    }
  }

  private pushAlert(ip: string, type: IpAlertType, detail: string, at: number): void {
    // 同一 IP + 同一類型的告警，5 分鐘內只記一筆，避免洗爆告警列表。
    const recent = this.alerts.find((alert) => alert.ip === ip && alert.type === type && at - alert.at < 5 * 60_000)
    if (recent) return
    const alert: IpAlert = { id: randomUUID(), ip, type, detail, at }
    this.alerts.unshift(alert)
    if (this.alerts.length > ALERT_HISTORY_LIMIT) this.alerts.length = ALERT_HISTORY_LIMIT
    this.persistence?.saveIpAlert(alert).catch((error: unknown) => {
      console.error('ip alert persist failed', error)
    })
  }

  private persistHourly(now: number): void {
    if (!this.persistence || now - this.lastPersistAt < 5 * 60_000) return
    this.lastPersistAt = now
    for (const record of this.records.values()) {
      for (const [hour, bucket] of record.hours) {
        // 只寫最近兩個小時桶：更早的桶在它們仍是「當下」時就寫過了。
        if (hour >= now - 2 * 3_600_000) {
          this.persistence
            .saveIpHour({ ip: record.ip, t: hour, ...bucket })
            .catch((error: unknown) => console.error('ip hour persist failed', error))
        }
      }
    }
    void this.persistence.deleteIpDataOlderThan(now - IP_RETENTION_MS).catch(() => undefined)
  }

  // ----------------------------------------------------------------- query

  top(rangeMs: number, now = Date.now(), limit = 10): IpTopRow[] {
    const from = now - rangeMs
    const rows: IpTopRow[] = []
    for (const record of this.records.values()) {
      let http = 0
      let wsMsg = 0
      let connEvents = 0
      for (const [hour, bucket] of record.hours) {
        if (hour >= from && hour <= now) {
          http += bucket.http
          wsMsg += bucket.wsMsg
          connEvents += bucket.connEvents
        }
      }
      // 視窗內若包含本分鐘，也把進行中的計數算進去。
      if (record.currentMinute.t >= from) {
        http += record.currentMinute.http
        wsMsg += record.currentMinute.wsMsg
        connEvents += record.currentMinute.conns
      }
      if (http === 0 && wsMsg === 0 && connEvents === 0) continue
      const block = this.blocks.get(record.ip)
      rows.push({
        ip: record.ip,
        http,
        wsMsg,
        connEvents,
        concurrent: this.concurrentOf(record.ip),
        firstSeen: record.firstSeen,
        lastSeen: record.lastSeen,
        blocked: Boolean(block),
        blockExpiresAt: block?.expiresAt ?? null,
      })
    }
    rows.sort((a, b) => b.http + b.wsMsg - (a.http + a.wsMsg))
    return rows.slice(0, limit)
  }

  listAlerts(): IpAlert[] {
    return this.alerts
  }

  thresholds(): Record<string, number> {
    return {
      httpPerMin: IP_ALERT_HTTP_PER_MIN,
      wsPerMin: IP_ALERT_WS_PER_MIN,
      connPerMin: IP_ALERT_CONN_PER_MIN,
      httpPerHour: IP_ALERT_HTTP_PER_HOUR,
      retentionDays: 7,
    }
  }

  // ---------------------------------------------------------------- blocks

  isBlocked(ip: string, now = Date.now()): boolean {
    const block = this.blocks.get(ip)
    if (!block) return false
    if (block.expiresAt !== null && block.expiresAt <= now) {
      this.blocks.delete(ip)
      void this.persistence?.deleteIpBlock(ip).catch(() => undefined)
      return false
    }
    return true
  }

  block(ip: string, duration: IpBlockDuration, blockedBy: string, now = Date.now()): { ip: string; blockedAt: number; expiresAt: number | null } {
    const expiresAt = duration === 'permanent' ? null : now + IP_BLOCK_DURATIONS[duration]
    const block = { ip, blockedAt: now, expiresAt, blockedBy }
    this.blocks.set(ip, block)
    this.persistence?.saveIpBlock(block).catch((error: unknown) => {
      console.error('ip block persist failed', error)
    })
    return block
  }

  unblock(ip: string): boolean {
    const existed = this.blocks.delete(ip)
    if (existed) this.persistence?.deleteIpBlock(ip).catch(() => undefined)
    return existed
  }

  listBlocks(now = Date.now()): Array<{ ip: string; blockedAt: number; expiresAt: number | null; blockedBy: string }> {
    const blocks: Array<{ ip: string; blockedAt: number; expiresAt: number | null; blockedBy: string }> = []
    for (const [ip, block] of this.blocks) {
      if (block.expiresAt !== null && block.expiresAt <= now) {
        this.blocks.delete(ip)
        void this.persistence?.deleteIpBlock(ip).catch(() => undefined)
        continue
      }
      blocks.push(block)
    }
    return blocks.sort((a, b) => b.blockedAt - a.blockedAt)
  }

  /** 測試與除錯用。 */
  hasRecord(ip: string): boolean {
    return this.records.has(ip)
  }
}