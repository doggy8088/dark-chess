import { describe, expect, it } from 'vitest'
import {
  IpMonitor,
  IP_ALERT_CONN_PER_MIN,
  IP_ALERT_HTTP_PER_MIN,
  looksLikeIp,
  type IpHourPoint,
  type IpMonitorPersistence,
} from '../ip-monitor'

function makePersistence() {
  const savedBlocks = new Map<string, { ip: string; blockedAt: number; expiresAt: number | null; blockedBy: string }>()
  const savedHours = new Map<string, IpHourPoint>()
  const persistence: IpMonitorPersistence = {
    saveIpBlock: async (block) => {
      savedBlocks.set(block.ip, block)
    },
    deleteIpBlock: async (ip) => {
      savedBlocks.delete(ip)
    },
    loadIpBlocks: async () => [...savedBlocks.values()],
    saveIpHour: async (point) => {
      savedHours.set(`${point.ip}_${point.t}`, point)
    },
    loadIpHours: async () => [...savedHours.values()],
    saveIpAlert: async () => undefined,
    loadIpAlerts: async () => [],
    deleteIpDataOlderThan: async () => undefined,
  }
  return { persistence, savedBlocks, savedHours }
}

describe('IpMonitor recording', () => {
  it('accumulates http and ws counters and folds into hourly buckets', () => {
    const monitor = new IpMonitor()
    let now = 1_700_000_000_000
    for (let i = 0; i < 5; i++) {
      monitor.recordHttp('1.2.3.4', now)
    }
    monitor.recordWsMessage('1.2.3.4', now)
    // 新分鐘：上一分鐘被摺疊進小時桶。
    now += 60_000
    monitor.recordHttp('1.2.3.4', now)
    expect(monitor.hasRecord('1.2.3.4')).toBe(true)
    const top = monitor.top(3_600_000, now)
    expect(top.length).toBe(1)
    expect(top[0]?.http).toBe(6) // 5 + 1
    expect(top[0]?.wsMsg).toBe(1)
  })

  it('raises an http-flood alert when a minute exceeds the threshold', () => {
    const monitor = new IpMonitor()
    let now = 1_700_000_000_000
    // 超過閥值（> 120）才告警：記錄閥值 + 1 次。
    for (let i = 0; i <= IP_ALERT_HTTP_PER_MIN; i++) {
      monitor.recordHttp('2.3.4.5', now)
    }
    expect(monitor.listAlerts().length).toBe(0)
    now += 60_000
    monitor.recordHttp('2.3.4.5', now) // 收尾上一分鐘 → 觸發告警
    const alerts = monitor.listAlerts()
    expect(alerts.length).toBe(1)
    expect(alerts[0]?.type).toBe('http-flood')
  })

  it('does not alert below thresholds', () => {
    const monitor = new IpMonitor()
    let now = 1_700_000_000_000
    for (let i = 0; i < 10; i++) {
      monitor.recordHttp('3.4.5.6', now)
      monitor.recordWsMessage('3.4.5.6', now)
    }
    now += 60_000
    monitor.recordHttp('3.4.5.6', now)
    expect(monitor.listAlerts().length).toBe(0)
  })

  it('deduplicates repeated alerts for the same ip and type within 5 minutes', () => {
    const monitor = new IpMonitor()
    let now = 1_700_000_000_000
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < IP_ALERT_HTTP_PER_MIN; i++) {
        monitor.recordHttp('4.5.6.7', now + round * 60_000)
      }
      now += 60_000
      monitor.recordHttp('4.5.6.7', now)
    }
    // 3 分鐘內的同一類型告警只記一筆。
    expect(monitor.listAlerts().filter((alert) => alert.type === 'http-flood').length).toBe(1)
  })

  it('raises a conn-storm alert on connection churn', () => {
    const monitor = new IpMonitor()
    let now = 1_700_000_000_000
    for (let i = 0; i <= IP_ALERT_CONN_PER_MIN; i++) {
      monitor.recordWsConnect('5.6.7.8', now)
      monitor.recordWsDisconnect('5.6.7.8')
    }
    now += 60_000
    monitor.recordHttp('5.6.7.8', now)
    expect(monitor.listAlerts().some((alert) => alert.type === 'conn-storm')).toBe(true)
  })

  it('ranks multiple ips by traffic and keeps top 10', () => {
    const monitor = new IpMonitor()
    const now = 1_700_000_000_000
    for (let ipIndex = 0; ipIndex < 12; ipIndex++) {
      const ip = `10.0.0.${ipIndex}`
      const weight = 12 - ipIndex
      for (let i = 0; i < weight * 3; i++) {
        monitor.recordHttp(ip, now)
      }
    }
    const top = monitor.top(3_600_000, now + 60_000)
    expect(top.length).toBe(10)
    expect(top[0]?.ip).toBe('10.0.0.0')
    expect(top[0]?.http).toBe(36)
  })
})

describe('IpMonitor blocking', () => {
  it('blocks, expires, and unblocks', () => {
    const monitor = new IpMonitor()
    const now = 1_700_000_000_000
    monitor.block('6.6.6.6', '5m', 'admin@test', now)
    expect(monitor.isBlocked('6.6.6.6', now + 60_000)).toBe(true)
    expect(monitor.isBlocked('6.6.6.6', now + 6 * 60_000)).toBe(false)
    monitor.block('7.7.7.7', 'permanent', 'admin@test', now)
    expect(monitor.isBlocked('7.7.7.7', now + 365 * 86_400_000)).toBe(true)
    expect(monitor.unblock('7.7.7.7')).toBe(true)
    expect(monitor.isBlocked('7.7.7.7')).toBe(false)
  })

  it('survives a restart via persistence', async () => {
    const { persistence } = makePersistence()
    const monitor = new IpMonitor(persistence)
    monitor.block('8.8.8.8', 'permanent', 'admin@test')
    await new Promise((resolve) => setTimeout(resolve, 0))

    const revived = new IpMonitor(persistence)
    await revived.init()
    expect(revived.isBlocked('8.8.8.8')).toBe(true)
  })

  it('drops expired blocks on restore', async () => {
    const { persistence } = makePersistence()
    const monitor = new IpMonitor(persistence)
    monitor.block('9.9.9.9', '5m', 'admin@test')
    await new Promise((resolve) => setTimeout(resolve, 0))

    const revived = new IpMonitor(persistence)
    await revived.init()
    expect(revived.isBlocked('9.9.9.9', Date.now() + 10 * 60_000)).toBe(false)
  })
})

describe('looksLikeIp', () => {
  it('accepts ipv4 and ipv6, rejects garbage', () => {
    expect(looksLikeIp('203.0.113.9')).toBe(true)
    expect(looksLikeIp('2001:db8::1')).toBe(true)
    expect(looksLikeIp('999.1.1.1')).toBe(false)
    expect(looksLikeIp('not-an-ip')).toBe(false)
  })
})