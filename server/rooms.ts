import type { GameState } from '../src/game/types'
import type { AnnouncementInfo, GameSummary, ServerMessage } from '../src/shared/protocol'
import { Room, type RoomDeps } from './room'
import { newRoomId } from './ids'
import { isLobbyListable, type RoomDoc, type RoomStore } from './store'

/** In-memory room cache with load-on-miss from the persistent store. */
export class RoomManager {
  private readonly rooms = new Map<string, Room>()
  private readonly loading = new Map<string, Promise<Room | null>>()
  private readonly deps: RoomDeps
  private readonly listeners = new Set<() => void>()

  constructor(
    store: RoomStore,
    now: () => number = Date.now,
    hooks: { onAnnouncementAck?: (id: string, name: string) => void; activeAnnouncement?: () => AnnouncementInfo | null } = {},
  ) {
    this.deps = {
      store,
      now,
      onActivity: () => this.notifyListeners(),
      onAnnouncementAck: hooks.onAnnouncementAck,
      activeAnnouncement: hooks.activeAnnouncement,
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (err) {
        console.error('RoomManager listener error', err)
      }
    }
  }

  async create(creatorName: string): Promise<Room> {
    const roomId = newRoomId()
    const room = await Room.create(roomId, creatorName, this.deps)
    this.rooms.set(roomId, room)
    await this.deps.store.save(room.toDoc())
    this.notifyListeners()
    return room
  }

  /** Cached room, or rebuilt from the store after a restart. */
  async get(roomId: string): Promise<Room | null> {
    const cached = this.rooms.get(roomId)
    if (cached) {
      cached.evaluate()
      return cached
    }
    // Coalesce concurrent loads of the same room so two players joining
    // right after a restart can't create two divergent Room instances.
    let pending = this.loading.get(roomId)
    if (!pending) {
      pending = this.deps.store
        .load(roomId)
        .then((doc) => {
          if (!doc) return null
          const existing = this.rooms.get(roomId)
          if (existing) return existing
          const room = Room.fromDoc(doc, this.deps)
          this.rooms.set(roomId, room)
          return room
        })
        .finally(() => this.loading.delete(roomId))
      this.loading.set(roomId, pending)
    }
    return pending
  }

  /**
   * Live-games board for the home screen: games in progress, plus finished
   * games that linger for a few minutes so results don't vanish mid-scroll.
   * Newest room first — the order keys off creation time, which never
   * changes, so rows never jump around while games progress.
   */
  async listGames(limit = 50): Promise<GameSummary[]> {
    const now = this.deps.now()
    const rows = new Map<string, { summary: GameSummary; createdAt: number }>()
    const add = (doc: RoomDoc, spectators: number): void => {
      if (!doc.seats[1]) return
      if (!isLobbyListable(doc, now)) return
      const summary = summarizeDoc(doc)
      if (!summary) return
      summary.spectators = spectators
      rows.set(doc.roomId, { summary, createdAt: doc.createdAt })
    }
    for (const room of this.rooms.values()) {
      room.evaluate()
      add(room.toDoc(), room.spectatorCount)
    }
    const docs = await this.deps.store.listActive(limit, now)
    for (const doc of docs) {
      if (rows.has(doc.roomId)) continue
      add(doc, this.rooms.get(doc.roomId)?.spectatorCount ?? 0)
    }
    const list = [...rows.values()]
    list.sort((a, b) => b.createdAt - a.createdAt || a.summary.roomId.localeCompare(b.summary.roomId))
    return list.slice(0, limit).map((row) => row.summary)
  }

  /** Live-room stats for the admin dashboard gauge. */
  stats(): { roomsPlaying: number; roomsWaiting: number; players: number; spectators: number } {
    let roomsPlaying = 0
    let roomsWaiting = 0
    let players = 0
    let spectators = 0
    for (const room of this.rooms.values()) {
      room.evaluate()
      if (room.status === 'playing') roomsPlaying++
      else if (room.status === 'waiting') roomsWaiting++
      players += room.connectedPlayers
      spectators += room.spectatorCount
    }
    return { roomsPlaying, roomsWaiting, players, spectators }
  }

  /** Fan-out a server-wide message to every room currently in memory. */
  announce(msg: ServerMessage): void {
    for (const room of this.rooms.values()) room.announce(msg)
  }

  /** Drops idle finished rooms from the cache (the store keeps them until TTL). */
  sweep(): void {
    let changed = false
    for (const [roomId, room] of this.rooms) {
      if (room.status === 'finished' && !room.hasConnections) {
        room.dispose()
        this.rooms.delete(roomId)
        changed = true
      }
    }
    if (changed) this.notifyListeners()
  }
}

/** Public-info scoreboard row from a stored room doc. Null on parse failure. */
export function summarizeDoc(doc: RoomDoc): GameSummary | null {
  try {
    const state = JSON.parse(doc.stateJson) as GameState
    let capturedRed = 0
    let capturedBlack = 0
    for (const piece of Object.values(state.pieces)) {
      if (!piece.captured) continue
      if (piece.color === 'red') capturedRed++
      else capturedBlack++
    }
    return {
      roomId: doc.roomId,
      status: doc.status,
      players: [
        { name: state.players[0].name, color: state.players[0].color },
        { name: state.players[1].name, color: state.players[1].color },
      ],
      capturedRed,
      capturedBlack,
      turnNumber: state.turnNumber,
      spectators: 0,
      updatedAt: doc.updatedAt,
    }
  } catch {
    return null
  }
}
