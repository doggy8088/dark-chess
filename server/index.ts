import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { WebSocketServer, type WebSocket } from 'ws'
import { FIRESTORE_ENABLED, PORT } from './config'
import { parseClientMessage } from './guards'
import { isRoomId } from './ids'
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

const rooms = new RoomManager(await makeStore())
setInterval(() => rooms.sweep(), 60_000).unref()

const app = express()
app.use(express.json({ limit: '4kb' }))

const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'

app.get('/healthz', (_req, res) => res.status(200).send('ok'))
// Same health check under /api so the Vite dev proxy (and the client's
// online-mode feature detection) reach it with one proxy rule.
app.get('/api/health', (_req, res) => res.status(200).json({ ok: true, version: APP_VERSION }))

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
    const name = rawName.trim().slice(0, 12) || '玩家一'
    const room = await rooms.create(name)
    res.json({ roomId: room.roomId, playerToken: room.seats[0].token })
  } catch (error) {
    console.error('create room failed', error)
    res.status(500).json({ error: 'create-failed' })
  }
})

// Invite URLs are client-side routes: serve the SPA shell.
app.get(/^\/r\/[a-z2-9]{10}$/, (_req, res) => {
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
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request)
  })
})

wss.on('connection', (ws: WebSocket) => {
  let room: Room | null = null

  ws.on('message', (raw) => {
    const msg = parseClientMessage(typeof raw === 'string' ? raw : raw.toString())
    if (!msg) {
      ws.send(JSON.stringify({ t: 'error', code: 'bad-message', message: '無法解析的訊息' }))
      return
    }
    if (msg.t === 'join') {
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
        room.join(ws, msg.playerToken, msg.name)
      })()
      return
    }
    room?.handleMessage(ws, msg)
  })

  ws.on('close', () => {
    room?.disconnect(ws)
    room = null
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
