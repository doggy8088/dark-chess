import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { WebSocketServer, type WebSocket } from 'ws'
import { FIRESTORE_ENABLED, PORT } from './config'
import { parseClientMessage } from './guards'
import { isRoomId } from './ids'
import { randomFunName } from '../src/shared/fun-names'
import type { AnnouncementInfo } from '../src/shared/protocol'
import {
  ADMIN_SESSION_TTL_MS,
  adminCookieHeader,
  adminEmailsFromEnv,
  clearAdminCookieHeader,
  isAdminEmail,
  parseCookies,
  randomSecret,
  signAdminSession,
  verifyAdminSession,
  verifyGoogleIdToken,
  ADMIN_COOKIE,
} from './auth'
import { AnnouncementBoard, type AnnouncementPersistence } from './announcements'
import { Metrics, type MetricsPersistence } from './metrics'
import { IpMonitor, isIpBlockDuration, looksLikeIp, IP_BLOCK_DURATIONS, type IpMonitorPersistence } from './ip-monitor'
import type { Room } from './room'
import { RoomManager } from './rooms'
import { InMemoryStore, type RoomStore } from './store'

const here = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(here, '..', 'dist')

async function makeStore(): Promise<RoomStore> {
  if (!FIRESTORE_ENABLED) {
    console.log('FIRESTORE_ENABLED=0 — using in-memory store (games do not survive restarts)')
    return new InMemoryStore()
  }
  const { FirestoreStore } = await import('./firestore-store')
  return new FirestoreStore()
}

const adminEmails = adminEmailsFromEnv()
const adminSessionSecret = process.env.ADMIN_SESSION_SECRET || randomSecret()
let adminStore: (AnnouncementPersistence & MetricsPersistence & IpMonitorPersistence) | undefined
if (FIRESTORE_ENABLED) {
  const { FirestoreAdminStore } = await import('./firestore-admin')
  adminStore = new FirestoreAdminStore()
}

const announcements = new AnnouncementBoard(adminStore as AnnouncementPersistence | undefined)
await announcements.init()

const ipMonitor = new IpMonitor(adminStore as IpMonitorPersistence | undefined)
await ipMonitor.init()
ipMonitor.start()

const rooms = new RoomManager(await makeStore(), Date.now, {
  onAnnouncementAck: (id, name) => announcements.ack(id, name),
  activeAnnouncement: () => {
    const current = announcements.current()
    const info: AnnouncementInfo | null = current ? { id: current.id, text: current.text, at: current.at } : null
    return info
  },
})
setInterval(() => rooms.sweep(), 60_000).unref()

const metrics = new Metrics({
  gauge: () => {
    const stats = rooms.stats()
    return { ...stats, lobby: lobbySockets.size }
  },
  persistence: adminStore as MetricsPersistence | undefined,
})
metrics.start()

const app = express()
// Cloud Run terminates TLS at the Google Front End; the real client IP rides
// in X-Forwarded-For. trust proxy makes req.ip resolve to it.
app.set('trust proxy', true)
app.use(express.json({ limit: '4kb' }))

function clientIp(req: express.Request): string {
  const forwarded = req.headers['x-forwarded-for']
  const first = typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : Array.isArray(forwarded) ? forwarded[0]?.trim() : undefined
  return first || req.ip || req.socket.remoteAddress || 'unknown'
}

app.use((req, res, next) => {
  metrics.recordHttp()
  const ip = clientIp(req)
  ipMonitor.recordHttp(ip)
  // 封鎖不影響後台自身與健康檢查，管理員不會把自己鎖在外面。
  if (!/^\/(admin|api\/admin|healthz|api\/health)/.test(req.path) && ipMonitor.isBlocked(ip)) {
    res.status(403).json({ error: 'ip-blocked', message: '您的網路位置已被暫時封鎖。若有疑問請與管理員聯絡。' })
    return
  }
  next()
})

const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'

app.get('/healthz', (_req, res) => res.status(200).send('ok'))
// Same health check under /api so the Vite dev proxy (and the client's
// online-mode feature detection) reach it with one proxy rule.
app.get('/api/health', (_req, res) => res.status(200).json({ ok: true, version: APP_VERSION }))

// ------------------------------------------------------------- admin console

function currentAdminEmail(req: { headers: { cookie?: string } }): string | null {
  const token = parseCookies(req.headers.cookie)[ADMIN_COOKIE]
  if (!token) return null
  const session = verifyAdminSession(token, adminSessionSecret)
  if (!session || !isAdminEmail(session.email, adminEmails)) return null
  return session.email
}

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const email = currentAdminEmail(req)
  if (!email) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }
  res.locals.adminEmail = email
  next()
}

/** OAuth client id for the Google sign-in button (public). */
app.get('/api/admin/config', (_req, res) => {
  res.json({ clientId: process.env.GOOGLE_CLIENT_ID ?? null })
})

app.post('/api/admin/google', async (req, res) => {
  try {
    const clientId = process.env.GOOGLE_CLIENT_ID
    const credential = typeof req.body?.credential === 'string' ? req.body.credential : ''
    if (!clientId) {
      res.status(503).json({ error: 'google-not-configured', message: '伺服器尚未設定 GOOGLE_CLIENT_ID' })
      return
    }
    if (!credential) {
      res.status(400).json({ error: 'missing-credential' })
      return
    }
    const identity = await verifyGoogleIdToken(credential, clientId)
    if (!identity || !isAdminEmail(identity.email, adminEmails)) {
      res.status(401).json({ error: 'not-admin', message: '此 Google 帳號沒有管理員權限' })
      return
    }
    res.setHeader('Set-Cookie', adminCookieHeader(signAdminSession(identity.email, adminSessionSecret, ADMIN_SESSION_TTL_MS)))
    res.json({ ok: true, email: identity.email })
  } catch (error) {
    console.error('admin google auth failed', error)
    res.status(500).json({ error: 'auth-failed' })
  }
})

app.get('/api/admin/session', (req, res) => {
  const email = currentAdminEmail(req)
  res.json({ authenticated: email !== null, email })
})

app.post('/api/admin/logout', (_req, res) => {
  res.setHeader('Set-Cookie', clearAdminCookieHeader())
  res.json({ ok: true })
})

/** Broadcasts an announcement to every connected room and lobby viewer. */
app.post('/api/admin/announcements', requireAdmin, (req, res) => {
  const rawBody: unknown = req.body?.text
  const raw = typeof rawBody === 'string' ? rawBody : ''
  const text = Array.from(raw)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0
      return code >= 32 && code !== 127
    })
    .join('')
    .trim()
    .slice(0, 500)
  if (!text) {
    res.status(400).json({ error: 'empty-text', message: '公告內容不可為空' })
    return
  }
  const stats = rooms.stats()
  const reached = stats.players + stats.spectators + lobbySockets.size
  const record = announcements.post(text, reached)
  const message: AnnouncementInfo = { id: record.id, text: record.text, at: record.at }
  rooms.announce({ t: 'announcement', ...message })
  const payload = JSON.stringify({ t: 'announcement', ...message })
  for (const client of lobbySockets) {
    if (client.readyState === 1 /* WebSocket.OPEN */) client.send(payload)
  }
  res.json({ ok: true, announcement: { id: record.id, text: record.text, at: record.at, reached, acks: 0 } })
})

app.get('/api/admin/announcements', requireAdmin, (_req, res) => {
  res.json({ announcements: announcements.list() })
})

app.get('/api/admin/metrics/live', requireAdmin, (_req, res) => {
  res.json({ version: APP_VERSION, ...metrics.live() })
})

app.get('/api/admin/metrics/series', requireAdmin, async (req, res) => {
  const granularity = req.query.granularity === 'hour' || req.query.granularity === 'day' ? req.query.granularity : 'minute'
  const to = Number(req.query.to) || Date.now()
  const from = Number(req.query.from) || to - 60 * 60 * 1000
  try {
    if (granularity === 'minute') {
      res.json({ granularity, points: metrics.seriesMinute(from, to) })
      return
    }
    if (granularity === 'hour') {
      res.json({ granularity, points: await metrics.seriesHour(from, to) })
      return
    }
    res.json({ granularity, points: await metrics.seriesDay(from, to) })
  } catch (error) {
    console.error('metrics series failed', error)
    res.status(500).json({ error: 'metrics-failed' })
  }
})

// ------------------------------------------------------------ IP 監控與封鎖

const IP_STATS_RANGES: Record<string, number> = {
  '1h': 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
}

app.get('/api/admin/ip-stats', requireAdmin, (req, res) => {
  const range = typeof req.query.range === 'string' && req.query.range in IP_STATS_RANGES ? req.query.range : '24h'
  const fallback = IP_STATS_RANGES['24h']!
  const window = IP_STATS_RANGES[range] ?? fallback
  res.json({ range, points: ipMonitor.top(window) })
})

app.get('/api/admin/ip-alerts', requireAdmin, (_req, res) => {
  res.json({ alerts: ipMonitor.listAlerts(), thresholds: ipMonitor.thresholds() })
})

app.get('/api/admin/ip-blocks', requireAdmin, (_req, res) => {
  res.json({ blocks: ipMonitor.listBlocks() })
})

app.post('/api/admin/ip-blocks', requireAdmin, (req, res) => {
  const ip = typeof req.body?.ip === 'string' ? req.body.ip.trim() : ''
  const duration = req.body?.duration
  if (!ip || ip.length > 45 || !looksLikeIp(ip)) {
    res.status(400).json({ error: 'bad-ip', message: 'IP 格式不正確（需為 IPv4 或 IPv6）' })
    return
  }
  if (!isIpBlockDuration(duration)) {
    res.status(400).json({
      error: 'bad-duration',
      message: `時長必須是：${Object.keys(IP_BLOCK_DURATIONS).join(' / ')} / permanent`,
    })
    return
  }
  const email = res.locals.adminEmail as string
  const block = ipMonitor.block(ip, duration, email)
  // 立即中斷該 IP 的既有連線（升級時的檢查只擋新連線）。
  for (const client of wss.clients) {
    if (wsIps.get(client) === ip) client.close(4003, 'ip-blocked')
  }
  res.json({ ok: true, block })
})

app.delete('/api/admin/ip-blocks/:ip', requireAdmin, (req, res) => {
  const ip = req.params.ip ?? ''
  const removed = ipMonitor.unblock(ip)
  res.json({ ok: true, removed })
})

// Admin console shell (login happens client-side via Google Identity Services).
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(distDir, 'admin.html'))
})

// Live-games board for the home screen (public info only).
app.get('/api/games', async (_req, res) => {
  try {
    res.json({ games: await rooms.listGames(20) })
  } catch (error) {
    console.error('list games failed', error)
    res.status(500).json({ error: 'list-failed' })
  }
})

app.post('/api/rooms', async (req, res) => {
  try {
    const rawName = typeof req.body?.name === 'string' ? (req.body.name as string) : ''
    const name = rawName.trim().slice(0, 12) || randomFunName()
    const room = await rooms.create(name)
    res.json({ roomId: room.roomId, playerToken: room.seats[0].token })
  } catch (error) {
    console.error('create room failed', error)
    res.status(500).json({ error: 'create-failed' })
  }
})

// Invite URLs 與其他 client-side routes：統一回 SPA shell（由前端依網址切換畫面）。
app.get(/^\/r\/[a-z2-9]{10}$/, (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'))
})
app.get(/^\/(online|setup)$/, (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'))
})

app.use(express.static(distDir))

const server = createServer(app)
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost')
  if (pathname !== '/ws') {
    socket.destroy()
    return
  }
  const forwarded = request.headers['x-forwarded-for']
  const ip =
    (typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined) ??
    request.socket.remoteAddress ??
    'unknown'
  // 封鎖中的 IP：直接拒絕 WebSocket 升級。
  if (ipMonitor.isBlocked(ip)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wsIps.set(ws, ip)
    wss.emit('connection', ws, request)
  })
})

const lobbySockets = new Set<WebSocket>()
/** 每條 WS 連線的用戶端 IP（升級時記錄），封鎖時用來踢線。 */
const wsIps = new WeakMap<WebSocket, string>()
let broadcastTimer: NodeJS.Timeout | null = null

async function broadcastLobby(): Promise<void> {
  if (lobbySockets.size === 0) return
  try {
    const games = await rooms.listGames(50)
    const payload = JSON.stringify({ t: 'lobby', games })
    for (const client of lobbySockets) {
      if (client.readyState === 1 /* WebSocket.OPEN */) {
        client.send(payload)
      }
    }
  } catch (err) {
    console.error('broadcastLobby failed', err)
  }
}

function scheduleLobbyBroadcast(): void {
  if (broadcastTimer) return
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null
    void broadcastLobby()
  }, 50)
}

rooms.subscribe(() => {
  scheduleLobbyBroadcast()
})

wss.on('connection', (ws: WebSocket) => {
  let room: Room | null = null
  const ip = wsIps.get(ws) ?? 'unknown'
  ipMonitor.recordWsConnect(ip)

  ws.on('message', (raw) => {
    ipMonitor.recordWsMessage(ip)
    const msg = parseClientMessage(typeof raw === 'string' ? raw : raw.toString())
    if (!msg) {
      ws.send(JSON.stringify({ t: 'error', code: 'bad-message', message: '無法解析的訊息' }))
      return
    }
    if (msg.t === 'subscribeLobby') {
      room?.disconnect(ws)
      room = null
      lobbySockets.add(ws)
      const active = announcements.current()
      if (active) ws.send(JSON.stringify({ t: 'announcement', id: active.id, text: active.text, at: active.at }))
      void (async () => {
        try {
          const games = await rooms.listGames(50)
          if (ws.readyState === 1 /* WebSocket.OPEN */) {
            ws.send(JSON.stringify({ t: 'lobby', games }))
          }
        } catch (err) {
          console.error('initial lobby send failed', err)
        }
      })()
      return
    }
    // Lobby viewers (no room yet) still acknowledge announcements.
    if (msg.t === 'announcementAck' && lobbySockets.has(ws)) {
      announcements.ack(msg.id, '🏠 大廳')
      return
    }
    if (msg.t === 'join') {
      lobbySockets.delete(ws)
      void (async () => {
        if (!isRoomId(msg.roomId)) {
          ws.send(JSON.stringify({ t: 'error', code: 'room-not-found', message: '房間不存在或已過期' }))
          return
        }
        const found = await rooms.get(msg.roomId)
        if (!found) {
          ws.send(JSON.stringify({ t: 'error', code: 'room-not-found', message: '房間不存在或已過期' }))
          return
        }
        room?.disconnect(ws)
        room = found
        room.join(ws, msg.playerToken, msg.name, msg.spectate)
      })()
      return
    }
    room?.handleMessage(ws, msg)
  })

  ws.on('close', () => {
    lobbySockets.delete(ws)
    room?.disconnect(ws)
    room = null
    ipMonitor.recordWsDisconnect(ip)
  })
  ws.on('error', () => {
    // close follows; nothing to do here.
  })
})

// WebSocket keepalive: Cloud Run (and some proxies) drop silent connections.
const HEARTBEAT_MS = 30_000
const alive = new WeakSet<WebSocket>()
wss.on('connection', (ws: WebSocket) => {
  alive.add(ws)
  ws.on('pong', () => alive.add(ws))
})
setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.has(ws)) {
      ws.terminate()
      continue
    }
    alive.delete(ws)
    ws.ping()
  }
}, HEARTBEAT_MS).unref()

server.listen(PORT, () => {
  console.log(`taiwan-dark-chess server listening on :${PORT} (static: ${distDir})`)
})
