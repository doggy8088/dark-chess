import type { Action, Color, GameStatus, HistoryEntry, PieceType, Player } from '../game/types'

/**
 * Wire protocol shared by the browser client and the game server.
 * Every WebSocket frame is a JSON-encoded message tagged by `t`.
 *
 * The server never sends hidden piece identities: face-down uncaptured
 * pieces appear in RedactedStateDTO without `color`/`type`, and piece ids
 * are opaque (`c00`–`c31`) so the id itself reveals nothing either.
 */

export interface RedactedPiece {
  id: string
  faceUp: boolean
  captured: boolean
  color?: Color
  type?: PieceType
}

/** GameState mirror with hidden identities stripped. History is public info. */
export interface RedactedStateDTO {
  board: (string | null)[]
  pieces: Record<string, RedactedPiece>
  players: [Player, Player]
  currentPlayerIndex: 0 | 1
  status: GameStatus
  winnerIndex: 0 | 1 | null
  turnNumber: number
  noCaptureTurnCount: number
  history: HistoryEntry[]
}

/** Absolute deadline plus the server clock so clients can correct skew. */
export interface TurnDeadline {
  seat: 0 | 1
  at: number
  serverNow: number
}

export interface ChatMessage {
  id: string
  from: 0 | 1 | 'spectator'
  /** Display name for spectator messages (seats resolve names from state). */
  name?: string
  kind: 'text' | 'canned'
  text: string
  cannedId?: string
  at: number
}

/** One row of the home screen's live-games board. All public info. */
export interface GameSummary {
  roomId: string
  /** 'playing' while the battle is on; 'finished' rows linger briefly after the game ends. */
  status: RoomStatus
  players: [{ name: string; color: Color | null }, { name: string; color: Color | null }]
  /** Captured piece counts: how many red / black pieces have fallen. */
  capturedRed: number
  capturedBlack: number
  turnNumber: number
  spectators: number
  updatedAt: number
}

/** True identity of a just-flipped piece, sent with the flip action. */
export interface PieceReveal {
  pieceId: string
  color: Color
  type: PieceType
}

export type GameOverReason = 'capture' | 'draw' | 'draw-agreed' | 'timeout' | 'forfeit' | 'resign' | 'aborted'

export interface SeatPresence {
  name: string
  connected: boolean
  /** Set while the seat is disconnected mid-game: forfeit deadline (epoch ms). */
  graceDeadlineAt?: number
}

export interface SpectatorPresence {
  name: string
}

export interface PresenceInfo {
  seats: [SeatPresence, SeatPresence]
  spectators: number
  spectatorList?: SpectatorPresence[]
}

export type RoomStatus = 'waiting' | 'playing' | 'finished'

/** Server-wide announcement pushed by the admin console. Public info only. */
export interface AnnouncementInfo {
  id: string
  text: string
  at: number
}

export interface FairnessReveal {
  /** Piece identities ("red-cannon"…) in board-index order at game start. */
  layout: string[]
  nonce: string
  hash: string
}

// ---------------------------------------------------------------- client → server

export type ClientMessage =
  | { t: 'subscribeLobby' }
  | { t: 'join'; roomId: string; playerToken?: string; name?: string; spectate?: boolean }
  | { t: 'action'; seq: number; action: Action }
  | { t: 'chat'; text: string }
  | { t: 'canned'; id: string }
  | { t: 'drawOffer' }
  | { t: 'drawResponse'; accept: boolean }
  | { t: 'abortRequest' }
  | { t: 'abortResponse'; accept: boolean }
  | { t: 'resign' }
  | { t: 'rematch' }
  | { t: 'rematchResponse'; accept: boolean }
  | { t: 'announcementAck'; id: string }

// ---------------------------------------------------------------- server → client

export type Seat = 0 | 1
export type SeatOrSpectator = Seat | 'spectator'

export type ServerMessage =
  | { t: 'lobby'; games: GameSummary[] }
  | {
      t: 'joined'
      roomId: string
      seat: SeatOrSpectator
      playerToken?: string
      roomStatus: RoomStatus
      state: RedactedStateDTO
      deadline: TurnDeadline | null
      chat: ChatMessage[]
      presence: PresenceInfo
      fairnessHash: string
      gameOver: { reason: GameOverReason; winnerIndex: 0 | 1 | null; fairnessReveal: FairnessReveal } | null
      /** Announcement still on display when the client joined — must be acknowledged. */
      announcement?: AnnouncementInfo | null
    }
  | { t: 'announcement'; id: string; text: string; at: number }
  | { t: 'state'; state: RedactedStateDTO; deadline: TurnDeadline | null }
  | {
      t: 'actionApplied'
      seq?: number
      by: Seat
      action: Action
      reveal?: PieceReveal
      state: RedactedStateDTO
      deadline: TurnDeadline | null
    }
  | { t: 'invalid'; seq: number; message: string }
  | { t: 'chat'; msg: ChatMessage }
  | { t: 'presence'; presence: PresenceInfo }
  | { t: 'deadline'; deadline: TurnDeadline }
  | { t: 'drawOffered'; by: Seat }
  | { t: 'drawRejected'; by: Seat }
  | { t: 'abortOffered'; by: Seat }
  | { t: 'abortRejected'; by: Seat }
  | { t: 'rematchOffered'; by: Seat }
  | { t: 'rematchRejected'; by: Seat }
  | { t: 'rematchStart'; state: RedactedStateDTO; deadline: TurnDeadline | null; fairnessHash: string }
  | {
      t: 'gameOver'
      state: RedactedStateDTO
      reason: GameOverReason
      winnerIndex: 0 | 1 | null
      fairnessReveal: FairnessReveal
    }
  | { t: 'error'; code: ErrorCode; message: string }

export type ErrorCode = 'room-not-found' | 'bad-message' | 'connected-elsewhere' | 'rate-limited'

/** zh-TW description for each way an online game can end. */
export const GAME_OVER_REASON_TEXT: Record<GameOverReason, string> = {
  capture: '吃光對方所有棋子',
  draw: '連續 25 步無吃子，判定和棋',
  'draw-agreed': '雙方同意和棋',
  timeout: '走棋逾時，判定敗北',
  forfeit: '斷線逾時未回，判定敗北',
  resign: '認輸',
  aborted: '對戰提前結束，不計勝負',
}
