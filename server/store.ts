import type { ChatMessage, GameOverReason, RoomStatus } from '../src/shared/protocol'
import { LOBBY_ENDED_RETENTION_MS, LOBBY_WAIT_VISIBILITY_MS } from './config'

export interface SeatDoc {
  token: string
  name: string
}

export interface TurnClockDoc {
  deadlineAt: number | null
  pausedRemainingMs: number | null
  graceDeadlineAt: number | null
}

/** Everything needed to rebuild a Room after a restart. */
export interface RoomDoc {
  version: 1
  roomId: string
  status: RoomStatus
  /** Full authoritative GameState (opaque piece ids), JSON-encoded. */
  stateJson: string
  fairness: { identityLayout: string[]; nonce: string; hash: string }
  seats: [SeatDoc, SeatDoc | null]
  turn: TurnClockDoc
  /** Chat tail, JSON-encoded (ChatMessage[]). */
  chatJson: string
  result: { reason: GameOverReason; winnerIndex: 0 | 1 | null } | null
  /** Active spectator-takeover window for an abandoned seat, if any. */
  takeover?: { seat: 0 | 1; deadlineAt: number } | null
  /** Epoch ms when the game finished; null while it has not finished yet. */
  finishedAt?: number | null
  createdAt: number
  updatedAt: number
  /** Epoch ms after which the room may be deleted. */
  expireAt: number
}

export function parseChat(doc: RoomDoc): ChatMessage[] {
  try {
    const parsed: unknown = JSON.parse(doc.chatJson)
    return Array.isArray(parsed) ? (parsed as ChatMessage[]) : []
  } catch {
    return []
  }
}

export interface RoomStore {
  load(roomId: string): Promise<RoomDoc | null>
  save(doc: RoomDoc): Promise<void>
  delete(roomId: string): Promise<void>
  /** Rooms listable on the home live board: games in progress plus finished
   *  ones still within their linger window. Room creation time first. */
  listActive(limit: number, now: number): Promise<RoomDoc[]>
}

/** True when the doc may appear on the home live board right now. */
export function isLobbyListable(doc: RoomDoc, now: number): boolean {
  if (doc.status === 'playing') return true
  if (doc.status === 'waiting') {
    // 等待對手超過 30 秒的房間公開曝光，讓訪客直接加入。
    return now - doc.createdAt >= LOBBY_WAIT_VISIBILITY_MS
  }
  if (doc.status !== 'finished') return false
  const endedAt = doc.finishedAt ?? doc.updatedAt
  return now - endedAt < LOBBY_ENDED_RETENTION_MS
}

/** Stable live-board order: newest room first. Sorted by creation time —
 *  which never changes — so rows never jump around while games progress. */
export function byLobbyOrder(a: RoomDoc, b: RoomDoc): number {
  return b.createdAt - a.createdAt || a.roomId.localeCompare(b.roomId)
}

/** Dev/test store. Games do not survive a restart without Firestore. */
export class InMemoryStore implements RoomStore {
  private readonly docs = new Map<string, RoomDoc>()

  load(roomId: string): Promise<RoomDoc | null> {
    return Promise.resolve(this.docs.get(roomId) ?? null)
  }

  save(doc: RoomDoc): Promise<void> {
    this.docs.set(doc.roomId, structuredClone(doc))
    return Promise.resolve()
  }

  delete(roomId: string): Promise<void> {
    this.docs.delete(roomId)
    return Promise.resolve()
  }

  listActive(limit: number, now: number): Promise<RoomDoc[]> {
    const active = [...this.docs.values()]
      .filter((doc) => isLobbyListable(doc, now))
      .sort(byLobbyOrder)
      .slice(0, limit)
    return Promise.resolve(structuredClone(active))
  }
}
