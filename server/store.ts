import type { ChatMessage, GameOverReason, RoomStatus } from '../src/shared/protocol'

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
  /** In-progress games, most recently active first. */
  listActive(limit: number): Promise<RoomDoc[]>
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

  listActive(limit: number): Promise<RoomDoc[]> {
    const active = [...this.docs.values()]
      .filter((doc) => doc.status === 'playing')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
    return Promise.resolve(structuredClone(active))
  }
}
