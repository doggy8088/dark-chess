import type { Color, GameState, Piece, PieceType, Position } from '../game/types'
import { CELL_COUNT } from '../game/constants'
import { positionToIndex } from '../game/game-state'

export interface PieceSpec {
  id?: string
  color: Color
  type: PieceType
  row: number
  col: number
  faceUp?: boolean
}

export interface BuildStateOptions {
  /** Color of the player to move. Defaults to 'red'. */
  currentColor?: Color
  /** Leave both players without an assigned camp (pre-first-flip). */
  colorsUnassigned?: boolean
}

/**
 * Builds a minimal but fully valid GameState with the given pieces placed on
 * an otherwise empty board. Player 1 is to move and owns `currentColor`.
 */
export function buildState(specs: PieceSpec[], options: BuildStateOptions = {}): GameState {
  const currentColor = options.currentColor ?? 'red'
  const board: (string | null)[] = new Array(CELL_COUNT).fill(null)
  const pieces: Record<string, Piece> = {}
  specs.forEach((spec, i) => {
    const id = spec.id ?? `${spec.color}-${spec.type}-t${i}`
    if (pieces[id]) throw new Error(`duplicate test piece id ${id}`)
    const index = positionToIndex({ row: spec.row, col: spec.col })
    if (board[index]) throw new Error(`two pieces on cell ${spec.row},${spec.col}`)
    pieces[id] = { id, color: spec.color, type: spec.type, faceUp: spec.faceUp ?? true, captured: false }
    board[index] = id
  })
  const otherColor: Color = currentColor === 'red' ? 'black' : 'red'
  return {
    board,
    pieces,
    players: [
      { id: 'p1', name: '玩家一', color: options.colorsUnassigned ? null : currentColor },
      { id: 'p2', name: '玩家二', color: options.colorsUnassigned ? null : otherColor },
    ],
    currentPlayerIndex: 0,
    status: 'playing',
    winnerIndex: null,
    turnNumber: 0,
    noCaptureTurnCount: 0,
    history: [],
  }
}

export function at(row: number, col: number): Position {
  return { row, col }
}
