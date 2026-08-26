import type { GameState } from '../src/game/types'
import type { GameSummary } from '../src/shared/protocol'
import { Room, type RoomDeps } from './room'
import { newRoomId } from './ids'
import type { RoomDoc, RoomStore } from './store'

/** In-memory room cache with load-on-miss from the persistent store. */
export class RoomManager {
  private readonly rooms = new Map<string, Room>()
  private readonly loading = new Map<string, Promise<Room | null>>()
  private readonly deps: RoomDeps

  constructor(store: RoomStore, now: () => number = () => Date.now()) {
    this.deps = { store, now }
  }

  async create(creatorName: string): Promise<Room> {
    const roomId = newRoomId()
    const room = await Room.create(roomId, creatorName, this.deps)
    this.rooms.set(roomId, room)
    await this.deps.store.save(room.toDoc())
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

  /** Live-games board for the home screen: in-progress games, newest first. */
  async listGames(limit = 20): Promise<GameSummary[]> {
    const docs = await this.deps.store.listActive(limit)
    const summaries: GameSummary[] = []
    for (const doc of docs) {
      // Only games with both seats filled are worth watching.
      if (!doc.seats[1]) continue
      const summary = summarizeDoc(doc)
      if (!summary) continue
      summary.spectators = this.rooms.get(doc.roomId)?.spectatorCount ?? 0
      summaries.push(summary)
    }
    return summaries
  }

  /** Drops idle finished rooms from the cache (the store keeps them until TTL). */
  sweep(): void {
    for (const [roomId, room] of this.rooms) {
      if (room.status === 'finished' && !room.hasConnections) {
        room.dispose()
        this.rooms.delete(roomId)
      }
    }
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
