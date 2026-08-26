import type { GameState, Piece, Player, Position } from './types'
import { CELL_COUNT, COLS, ROWS } from './constants'
import { createAllPieces } from './pieces'
import { fisherYatesShuffle } from './shuffle'

export function positionToIndex(pos: Position): number {
  return pos.row * COLS + pos.col
}

export function indexToPosition(index: number): Position {
  return { row: Math.floor(index / COLS), col: index % COLS }
}

export function isOnBoard(pos: Position): boolean {
  return (
    Number.isInteger(pos.row) &&
    Number.isInteger(pos.col) &&
    pos.row >= 0 &&
    pos.row < ROWS &&
    pos.col >= 0 &&
    pos.col < COLS
  )
}

export function pieceIdAt(state: GameState, pos: Position): string | null {
  if (!isOnBoard(pos)) return null
  return state.board[positionToIndex(pos)] ?? null
}

export function pieceAt(state: GameState, pos: Position): Piece | null {
  const id = pieceIdAt(state, pos)
  return id ? (state.pieces[id] ?? null) : null
}

export function findPiecePosition(state: GameState, pieceId: string): Position | null {
  const index = state.board.indexOf(pieceId)
  return index === -1 ? null : indexToPosition(index)
}

export function currentPlayer(state: GameState): Player {
  return state.players[state.currentPlayerIndex]
}

export function opponentIndex(index: 0 | 1): 0 | 1 {
  return index === 0 ? 1 : 0
}

/** Living (uncaptured) pieces of a color, face-up or face-down. */
export function remainingPieces(state: GameState, color: 'red' | 'black'): Piece[] {
  return Object.values(state.pieces).filter((p) => p.color === color && !p.captured)
}

export function capturedPieces(state: GameState, color: 'red' | 'black'): Piece[] {
  return Object.values(state.pieces).filter((p) => p.color === color && p.captured)
}

export interface CreateGameOptions {
  playerNames?: [string, string]
  firstPlayerIndex?: 0 | 1
  /** Fixed board layout (index order), mainly for tests and resume. Defaults to a secure shuffle. */
  layout?: Piece[]
}

export function createGame(options: CreateGameOptions = {}): GameState {
  const layout = options.layout ?? fisherYatesShuffle(createAllPieces())
  if (layout.length !== CELL_COUNT) {
    throw new Error(`createGame: layout must contain ${CELL_COUNT} pieces`)
  }
  const pieces: Record<string, Piece> = {}
  const board: (string | null)[] = []
  for (const piece of layout) {
    if (pieces[piece.id]) throw new Error(`createGame: duplicate piece id ${piece.id}`)
    pieces[piece.id] = { ...piece }
    board.push(piece.id)
  }
  const names = options.playerNames ?? ['玩家一', '玩家二']
  const players: [Player, Player] = [
    { id: 'p1', name: names[0], color: null },
    { id: 'p2', name: names[1], color: null },
  ]
  return {
    board,
    pieces,
    players,
    currentPlayerIndex: options.firstPlayerIndex ?? 0,
    status: 'playing',
    winnerIndex: null,
    turnNumber: 0,
    noCaptureTurnCount: 0,
    history: [],
  }
}

export function cloneState(state: GameState): GameState {
  return structuredClone(state)
}
