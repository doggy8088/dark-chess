import { describe, expect, it } from 'vitest'
import { Metrics, dayKey, type GaugeSample, type HourPoint, type MetricsPersistence } from '../metrics'

function makeGauge(overrides: Partial<GaugeSample> = {}): () => GaugeSample {
  return () => ({ players: 0, spectators: 0, lobby: 0, roomsPlaying: 0, roomsWaiting: 0, ...overrides })
}

describe('Metrics', () => {
  it('closes a minute bucket with counters and gauge peaks', () => {
    let now = 1_700_000_000_000 // aligned to the hour
    const metrics = new Metrics({ now: () => now, gauge: makeGauge({ players: 2, spectators: 1, lobby: 3, roomsPlaying: 2, roomsWaiting: 1 }) })
    metrics.recordHttp()
    metrics.recordHttp()
    metrics.recordWsMessage()
    metrics.recordWsMessage()
    metrics.recordWsMessage()
    metrics.sample()
    metrics.sample()

    now += 60_000
    metrics.collect(now)

    const buckets = metrics.seriesMinute(0, now)
    expect(buckets.length).toBe(1)
    const bucket = buckets[0]!
    expect(bucket.http).toBe(2)
    expect(bucket.wsMsg).toBe(3)
    expect(bucket.connPeak).toBe(6) // 2 players + 1 spectator + 3 lobby
    expect(bucket.playersPeak).toBe(2)
    expect(bucket.roomsPlayingPeak).toBe(2)
    expect(bucket.rssPeak).toBeGreaterThan(0)
  })

  it('rolls minutes up into hour points and persists them', async () => {
    const saved: HourPoint[] = []
    const persistence: MetricsPersistence = {
      saveHour: async (point) => {
        saved.push(point)
      },
      loadHours: async () => saved,
    }
    // 10:59:00 → one bucket inside hour H; 11:01 → closes hour H.
    let now = 1_700_000_000_000 // 2023-11-14 10:53:20 UTC
    now = now - (now % 600_000) + 3_540_000 // 10:59:00
    const metrics = new Metrics({ now: () => now, gauge: makeGauge({ players: 4, roomsPlaying: 3 }), persistence })
    metrics.recordWsMessage()
    metrics.sample()
    now += 120_000 // 11:01
    metrics.collect(now)

    expect(saved.length).toBe(1)
    expect(saved[0]?.wsMsg).toBe(1)
    expect(saved[0]?.playersPeak).toBe(4)
    expect(saved[0]?.samples).toBe(1)

    const hours = await metrics.seriesHour(saved[0]!.t, saved[0]!.t)
    expect(hours.length).toBe(1)
  })

  it('aggregates daily points with Taipei day keys', async () => {
    const hours = new Map<number, HourPoint>()
    // 2023-11-14 17:00 UTC = 2023-11-15 01:00 Taipei → day key 2023-11-15.
    const taipeiLateNight = Date.UTC(2023, 10, 14, 17, 0, 0)
    const taipeiEvening = Date.UTC(2023, 10, 14, 12, 0, 0) // 20:00 Taipei, same day
    hours.set(taipeiLateNight, {
      t: taipeiLateNight,
      samples: 60,
      http: 120,
      wsMsg: 600,
      connPeak: 8,
      connSum: 240,
      playersPeak: 6,
      spectatorsPeak: 2,
      lobbyPeak: 2,
      roomsPlayingPeak: 3,
      roomsWaitingPeak: 1,
      lagP95Max: 5,
      lagMax: 9,
      cpuPeak: 42.5,
      cpuSum: 1_200,
      rssPeak: 300_000_000,
      heapPeak: 100_000_000,
    })
    hours.set(taipeiEvening, {
      t: taipeiEvening,
      samples: 60,
      http: 80,
      wsMsg: 400,
      connPeak: 5,
      connSum: 180,
      playersPeak: 4,
      spectatorsPeak: 1,
      lobbyPeak: 1,
      roomsPlayingPeak: 2,
      roomsWaitingPeak: 0,
      lagP95Max: 4,
      lagMax: 6,
      cpuPeak: 18.2,
      cpuSum: 600,
      rssPeak: 250_000_000,
      heapPeak: 90_000_000,
    })
    const persistence: MetricsPersistence = {
      saveHour: async () => undefined,
      loadHours: async (from, to) => [...hours.values()].filter((point) => point.t >= from && point.t <= to),
    }
    const metrics = new Metrics({ persistence })
    const days = await metrics.seriesDay(taipeiEvening - 1, taipeiLateNight + 1)
    // 20:00 Taipei on 11-14 and 01:00 Taipei on 11-15 are different days.
    expect(days.length).toBe(2)
    const evening = days.find((entry) => entry.day === '2023-11-14')
    const lateNight = days.find((entry) => entry.day === '2023-11-15')
    expect(evening?.http).toBe(80)
    expect(evening?.wsMsg).toBe(400)
    expect(evening?.connPeak).toBe(5)
    expect(evening?.cpuPeak).toBe(18.2)
    expect(lateNight?.http).toBe(120)
    expect(lateNight?.wsMsg).toBe(600)
    expect(lateNight?.connPeak).toBe(8)
    expect(lateNight?.cpuPeak).toBe(42.5)
  })

  it('reports a live snapshot from the gauge provider', () => {
    const metrics = new Metrics({ gauge: makeGauge({ players: 2, spectators: 3, lobby: 1, roomsPlaying: 2, roomsWaiting: 1 }) })
    metrics.sample()
    metrics.sample()
    const live = metrics.live()
    expect(live.players).toBe(2)
    expect(live.spectators).toBe(3)
    expect(live.roomsPlaying).toBe(2)
    expect(live.roomsWaiting).toBe(1)
    expect(live.rssMb).toBeGreaterThan(0)
    // CPU 取樣過兩次後應有數值，且介於 0–100。
    expect(live.cpuPct).toBeGreaterThanOrEqual(0)
    expect(live.cpuPct).toBeLessThanOrEqual(100)
  })

  it('dayKey follows Asia/Taipei (UTC+8)', () => {
    expect(dayKey(Date.UTC(2023, 10, 14, 16, 0, 0))).toBe('2023-11-15')
    expect(dayKey(Date.UTC(2023, 10, 14, 15, 59, 0))).toBe('2023-11-14')
  })
})