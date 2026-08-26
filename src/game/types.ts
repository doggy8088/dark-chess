export type Color = 'red' | 'black'

export type PieceType =
  | 'general'
  | 'advisor'
  | 'elephant'
  | 'rook'
  | 'horse'
  | 'cannon'
  | 'pawn'

export interface Piece {
  id: string
  color: Color
  type: PieceType
  faceUp: boolean
  captured: boolean
}

export interface Position {
  row: number
  col: number
}

export interface Player {
  id: 'p1' | 'p2'
  name: string
  color: Color | null
}

export type GameStatus = 'playing' | 'won' | 'draw'

export type Action =
  | { kind: 'flip'; pieceId: string }
  | { kind: 'move'; pieceId: string; to: Position }
  | { kind: 'capture'; attackerId: string; targetId: string }

export interface HistoryEntry {
  turn: number
  playerIndex: 0 | 1
  kind: Action['kind']
  pieceColor: Color
  pieceType: PieceType
  from?: Position
  to?: Position
  targetColor?: Color
  targetType?: PieceType
}

export interface GameState {
  /** 32 cells, index = row * 8 + col. Value is a piece id or null. */
  board: (string | null)[]
  pieces: Record<string, Piece>
  players: [Player, Player]
  currentPlayerIndex: 0 | 1
  status: GameStatus
  winnerIndex: 0 | 1 | null
  /** Number of completed actions since game start. */
  turnNumber: number
  /** Consecutive turns without a capture. A capture resets it to 0. */
  noCaptureTurnCount: number
  history: HistoryEntry[]
}
