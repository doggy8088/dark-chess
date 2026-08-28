import { monitorEventLoopDelay } from 'node:perf_hooks'

/**
 * Server load metrics. Minute-resolution buckets live in memory (72h);
 * hour rollups additionally persist via an optional store so hourly and
 * daily trends survive deploys. Day keys follow Asia/Taipei (UTC+8).
 */

export interface GaugeSample {
  players: number
  spectators: number
  lobby: number
  roomsPlaying: number
  roomsWaiting: number
}

export interface MinuteBucket {
  t: number
  http: number
  wsMsg: number
  connPeak: number
  connAvg: number
  playersPeak: number
  spectatorsPeak: number
  lobbyPeak: number
  roomsPlayingPeak: number
  roomsWaitingPeak: number
  lagP95: number
  lagMax: number
  /** CPU 使用率（單一 vCPU 的百分比，0–100）。 */
  cpuAvg: number
  cpuPeak: number
  rssPeak: number
  heapPeak: number
}

export interface HourPoint {
  t: number
  samples: number
  http: number
  wsMsg: number
  connPeak: number
  connSum: number
  playersPeak: number
  spectatorsPeak: number
  lobbyPeak: number
  roomsPlayingPeak: number
  roomsWaitingPeak: number
  lagP95Max: number
  lagMax: number
  /** 小時內 CPU 峰值與各分鐘平均值的總和（小時平均 = cpuSum / samples）。 */
  cpuPeak: number
  cpuSum: number
  rssPeak: number
  heapPeak: number
}

export interface MetricsPersistence {
  saveHour(point: HourPoint): Promise<void>
  loadHours(from: number, to: number): Promise<HourPoint[]>
}

export interface LiveSnapshot extends GaugeSample {
  lagMs: number
  /** 即時 CPU 使用率（0–100，單一 vCPU）。 */
  cpuPct: number
  rssMb: number
  heapMb: number
  uptimeSec: number
}

const MINUTE_RETENTION_MS = 72 * 60 * 60 * 1000
const HOUR_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000

function minuteStart(t: number): number {
  return Math.floor(t / 60_000) * 60_000
}

function hourStart(t: number): number {
  return Math.floor(t / 3_600_000) * 3_600_000
}

export function dayKey(t: number): string {
  return new Date(t + TAIPEI_OFFSET_MS).toISOString().slice(0, 10)
}

function percentile95(samples: number[]): number {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)
  return sorted[index] ?? 0
}

interface PartialMinute {
  t: number
  http: number
  wsMsg: number
  lagSamples: number[]
  gauges: GaugeSample[]
  rssPeak: number
  heapPeak: number
  cpuSum: number
  cpuPeak: number
  cpuSamples: number
}

export class Metrics {
  private readonly minutes = new Map<number, MinuteBucket>()
  private readonly hours = new Map<number, HourPoint>()
  private current: PartialMinute
  private lastUpsert = 0
  private delayMonitor: ReturnType<typeof monitorEventLoopDelay> | null = null
  private samplerTimer: ReturnType<typeof setInterval> | null = null
  private collectTimer: ReturnType<typeof setInterval> | null = null
  private lastLagMs = 0
  private lastCpuPct = 0
  private lastCpuSample: { usage: NodeJS.CpuUsage; at: number } | null = null

  constructor(
    private readonly opts: {
      now?: () => number
      gauge?: () => GaugeSample
      persistence?: {
        saveHour(point: HourPoint): Promise<void>
        loadHours(from: number, to: number): Promise<HourPoint[]>
      }
    } = {},
  ) {
    this.current = this.newPartial(opts.now?.() ?? Date.now())
    if (typeof monitorEventLoopDelay === 'function') {
      this.delayMonitor = monitorEventLoopDelay({ resolution: 20 })
      this.delayMonitor.enable()
    }
  }

  // -------------------------------------------------------------- recording

  recordHttp(): void {
    this.current.http++
  }

  recordWsMessage(): void {
    this.current.wsMsg++
  }

  // ----------------------------------------------------------------- cycles

  /** Starts the lag sampler and the per-minute collection timer. */
  start(collectIntervalMs = 60_000, sampleIntervalMs = 5_000): void {
    if (this.collectTimer) return
    this.samplerTimer = setInterval(() => this.sample(), sampleIntervalMs)
    this.samplerTimer.unref?.()
    this.collectTimer = setInterval(() => this.collect(), collectIntervalMs)
    this.collectTimer.unref?.()
  }

  stop(): void {
    if (this.samplerTimer) clearInterval(this.samplerTimer)
    if (this.collectTimer) clearInterval(this.collectTimer)
    this.samplerTimer = null
    this.collectTimer = null
    this.delayMonitor?.disable()
  }

  private newPartial(t: number): PartialMinute {
    return { t: minuteStart(t), http: 0, wsMsg: 0, lagSamples: [], gauges: [], rssPeak: 0, heapPeak: 0, cpuSum: 0, cpuPeak: 0, cpuSamples: 0 }
  }

  /** Takes one gauge + memory + CPU + lag sample into the current minute. */
  sample(): void {
    const now = this.opts.now?.() ?? Date.now()
    if (minuteStart(now) !== this.current.t) this.collect(now)
    const gauge = this.opts.gauge?.() ?? { players: 0, spectators: 0, lobby: 0, roomsPlaying: 0, roomsWaiting: 0 }
    this.current.gauges.push(gauge)
    const memory = process.memoryUsage()
    this.current.rssPeak = Math.max(this.current.rssPeak, memory.rss)
    this.current.heapPeak = Math.max(this.current.heapPeak, memory.heapUsed)
    this.sampleCpu()
    this.recordLag()
  }

  /** CPU 使用率：兩次取樣間的 CPU 時間 ÷ 真實經過時間（單一 vCPU 為 100%）。 */
  private sampleCpu(): void {
    const usage = process.cpuUsage()
    const realNow = Date.now()
    if (this.lastCpuSample) {
      const wallMs = Math.max(1, realNow - this.lastCpuSample.at)
      const cpuUsec =
        usage.user - this.lastCpuSample.usage.user + (usage.system - this.lastCpuSample.usage.system)
      this.lastCpuPct = Math.min(100, Math.max(0, (cpuUsec / (wallMs * 1000)) * 100))
      this.current.cpuSum += this.lastCpuPct
      this.current.cpuPeak = Math.max(this.current.cpuPeak, this.lastCpuPct)
      this.current.cpuSamples++
    }
    this.lastCpuSample = { usage, at: realNow }
  }

  private recordLag(): void {
    if (!this.delayMonitor) return
    const meanNs = this.delayMonitor.mean
    if (Number.isFinite(meanNs) && meanNs > 0) {
      const lagMs = meanNs / 1_000_000
      this.lastLagMs = lagMs
      this.current.lagSamples.push(lagMs)
    }
    this.delayMonitor.reset()
  }

  /** Closes the current minute bucket and rolls it up into hours. */
  collect(nowOverride?: number): void {
    const now = nowOverride ?? this.opts.now?.() ?? Date.now()
    const bucketStart = minuteStart(now)
    const partial = this.current
    if (bucketStart !== partial.t) {
      const gauges = partial.gauges
      const connValues = gauges.map((g) => g.players + g.spectators + g.lobby)
      const bucket: MinuteBucket = {
        t: partial.t,
        http: partial.http,
        wsMsg: partial.wsMsg,
        connPeak: connValues.length > 0 ? Math.max(...connValues) : 0,
        connAvg: connValues.length > 0 ? connValues.reduce((sum, v) => sum + v, 0) / connValues.length : 0,
        playersPeak: gauges.length > 0 ? Math.max(...gauges.map((g) => g.players)) : 0,
        spectatorsPeak: gauges.length > 0 ? Math.max(...gauges.map((g) => g.spectators)) : 0,
        lobbyPeak: gauges.length > 0 ? Math.max(...gauges.map((g) => g.lobby)) : 0,
        roomsPlayingPeak: gauges.length > 0 ? Math.max(...gauges.map((g) => g.roomsPlaying)) : 0,
        roomsWaitingPeak: gauges.length > 0 ? Math.max(...gauges.map((g) => g.roomsWaiting)) : 0,
        lagP95: percentile95(partial.lagSamples),
        lagMax: partial.lagSamples.length > 0 ? Math.max(...partial.lagSamples) : 0,
        cpuAvg: partial.cpuSamples > 0 ? partial.cpuSum / partial.cpuSamples : 0,
        cpuPeak: partial.cpuPeak,
        rssPeak: partial.rssPeak,
        heapPeak: partial.heapPeak,
      }
      this.minutes.set(bucket.t, bucket)
      this.rollupHour(bucket.t)
      const cutoff = now - MINUTE_RETENTION_MS
      for (const key of this.minutes.keys()) {
        if (key < cutoff) this.minutes.delete(key)
      }
      this.current = this.newPartial(now)
    } else {
      // Same-minute collection: fold counters into the upsert path only.
      this.rollupHour(bucketStart)
    }
    this.maybeUpsertHour(now)
  }

  private rollupHour(minuteStartMs: number): void {
    const hour = hourStart(minuteStartMs)
    const buckets = [...this.minutes.values()].filter((bucket) => bucket.t >= hour && bucket.t < hour + 3_600_000)
    if (buckets.length === 0) return
    const point: HourPoint = {
      t: hour,
      samples: buckets.length,
      http: buckets.reduce((sum, b) => sum + b.http, 0),
      wsMsg: buckets.reduce((sum, b) => sum + b.wsMsg, 0),
      connPeak: Math.max(...buckets.map((b) => b.connPeak)),
      connSum: buckets.reduce((sum, b) => sum + b.connAvg, 0),
      playersPeak: Math.max(...buckets.map((b) => b.playersPeak)),
      spectatorsPeak: Math.max(...buckets.map((b) => b.spectatorsPeak)),
      lobbyPeak: Math.max(...buckets.map((b) => b.lobbyPeak)),
      roomsPlayingPeak: Math.max(...buckets.map((b) => b.roomsPlayingPeak)),
      roomsWaitingPeak: Math.max(...buckets.map((b) => b.roomsWaitingPeak)),
      lagP95Max: Math.max(...buckets.map((b) => b.lagP95)),
      lagMax: Math.max(...buckets.map((b) => b.lagMax)),
      cpuPeak: Math.max(...buckets.map((b) => b.cpuPeak)),
      cpuSum: buckets.reduce((sum, b) => sum + b.cpuAvg, 0),
      rssPeak: Math.max(...buckets.map((b) => b.rssPeak)),
      heapPeak: Math.max(...buckets.map((b) => b.heapPeak)),
    }
    const existing = this.hours.get(hour)
    this.hours.set(hour, point)
    if (this.opts.persistence && (!existing || existing.http !== point.http || existing.connPeak !== point.connPeak || existing.samples !== point.samples)) {
      void this.opts.persistence.saveHour(point).catch((error: unknown) => {
        console.error('metrics hour persist failed', error)
      })
    }
    const cutoff = hourStart(this.opts.now?.() ?? Date.now()) - HOUR_RETENTION_MS
    for (const key of this.hours.keys()) {
      if (key < cutoff) this.hours.delete(key)
    }
  }

  private maybeUpsertHour(now: number): void {
    // Keep the in-progress hour fresh for the dashboard without hammering the store.
    if (now - this.lastUpsert < 5 * 60_000) return
    this.lastUpsert = now
    this.rollupHour(minuteStart(now))
  }

  // ----------------------------------------------------------------- query

  live(): LiveSnapshot {
    const gauge = this.opts.gauge?.() ?? { players: 0, spectators: 0, lobby: 0, roomsPlaying: 0, roomsWaiting: 0 }
    const memory = process.memoryUsage()
    return {
      ...gauge,
      lagMs: Math.round(this.lastLagMs * 10) / 10,
      cpuPct: Math.round(this.lastCpuPct * 10) / 10,
      rssMb: Math.round((memory.rss / 1_048_576) * 10) / 10,
      heapMb: Math.round((memory.heapUsed / 1_048_576) * 10) / 10,
      uptimeSec: Math.round(process.uptime()),
    }
  }

  seriesMinute(from: number, to: number): MinuteBucket[] {
    return [...this.minutes.values()].filter((bucket) => bucket.t >= from && bucket.t <= to).sort((a, b) => a.t - b.t)
  }

  async seriesHour(from: number, to: number): Promise<HourPoint[]> {
    const map = new Map<number, HourPoint>()
    for (const [t, point] of this.hours) {
      if (t >= from && t <= to) map.set(t, point)
    }
    if (this.opts.persistence) {
      try {
        const stored = await this.opts.persistence.loadHours(from, to)
        for (const point of stored) {
          const existing = map.get(point.t)
          if (!existing || point.samples > existing.samples) map.set(point.t, point)
        }
      } catch (error) {
        console.error('metrics hour load failed', error)
      }
    }
    return [...map.values()].sort((a, b) => a.t - b.t)
  }

  async seriesDay(from: number, to: number): Promise<Array<HourPoint & { day: string }>> {
    const hours = await this.seriesHour(from, to)
    const byDay = new Map<string, HourPoint & { day: string }>()
    for (const point of hours) {
      const day = dayKey(point.t)
      const acc = byDay.get(day) ?? {
        day,
        t: point.t,
        samples: 0,
        http: 0,
        wsMsg: 0,
        connPeak: 0,
        connSum: 0,
        playersPeak: 0,
        spectatorsPeak: 0,
        lobbyPeak: 0,
        roomsPlayingPeak: 0,
        roomsWaitingPeak: 0,
        lagP95Max: 0,
        lagMax: 0,
        cpuPeak: 0,
        cpuSum: 0,
        rssPeak: 0,
        heapPeak: 0,
      }
      acc.samples += point.samples
      acc.http += point.http
      acc.wsMsg += point.wsMsg
      acc.connPeak = Math.max(acc.connPeak, point.connPeak)
      acc.connSum += point.connSum
      acc.playersPeak = Math.max(acc.playersPeak, point.playersPeak)
      acc.spectatorsPeak = Math.max(acc.spectatorsPeak, point.spectatorsPeak)
      acc.lobbyPeak = Math.max(acc.lobbyPeak, point.lobbyPeak)
      acc.roomsPlayingPeak = Math.max(acc.roomsPlayingPeak, point.roomsPlayingPeak)
      acc.roomsWaitingPeak = Math.max(acc.roomsWaitingPeak, point.roomsWaitingPeak)
      acc.lagP95Max = Math.max(acc.lagP95Max, point.lagP95Max)
      acc.lagMax = Math.max(acc.lagMax, point.lagMax)
      acc.cpuPeak = Math.max(acc.cpuPeak, point.cpuPeak)
      acc.cpuSum += point.cpuSum
      acc.rssPeak = Math.max(acc.rssPeak, point.rssPeak)
      acc.heapPeak = Math.max(acc.heapPeak, point.heapPeak)
      byDay.set(day, acc)
    }
    return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
  }
}