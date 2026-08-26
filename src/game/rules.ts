import type { GameState, Piece, Position } from './types'
import { COLS, RANK, ROWS } from './constants'
import { findPiecePosition, pieceAt, pieceIdAt } from './game-state'

export function isAdjacent(a: Position, b: Position): boolean {
  const dr = Math.abs(a.row - b.row)
  const dc = Math.abs(a.col - b.col)
  return dr + dc === 1
}

/** Counts pieces strictly between two positions on the same row or column. Returns -1 if not aligned. */
export function countPiecesBetween(state: GameState, a: Position, b: Position): number {
  if (a.row !== b.row && a.col !== b.col) return -1
  if (a.row === b.row && a.col === b.col) return -1
  let count = 0
  if (a.row === b.row) {
    const [lo, hi] = a.col < b.col ? [a.col, b.col] : [b.col, a.col]
    for (let col = lo + 1; col < hi; col++) {
      if (pieceIdAt(state, { row: a.row, col })) count++
    }
  } else {
    const [lo, hi] = a.row < b.row ? [a.row, b.row] : [b.row, a.row]
    for (let row = lo + 1; row < hi; row++) {
      if (pieceIdAt(state, { row, col: a.col })) count++
    }
  }
  return count
}

/**
 * Ordinary movement: every piece (cannon included) moves exactly one step
 * up / down / left / right onto an empty cell.
 */
export function canMove(state: GameState, pieceId: string, to: Position): boolean {
  const piece = state.pieces[pieceId]
  if (!piece || piece.captured || !piece.faceUp) return false
  const from = findPiecePosition(state, pieceId)
  if (!from) return false
  if (to.row < 0 || to.row >= ROWS || to.col < 0 || to.col >= COLS) return false
  if (!isAdjacent(from, to)) return false
  return pieceIdAt(state, to) === null
}

export function getLegalMoves(state: GameState, pieceId: string): Position[] {
  const from = findPiecePosition(state, pieceId)
  if (!from) return []
  const candidates: Position[] = [
    { row: from.row - 1, col: from.col },
    { row: from.row + 1, col: from.col },
    { row: from.row, col: from.col - 1 },
    { row: from.row, col: from.col + 1 },
  ]
  return candidates.filter((to) => canMove(state, pieceId, to))
}

/** Type-vs-type capture permission for ordinary (non-cannon) captures. */
function rankAllowsCapture(attacker: Piece, target: Piece): boolean {
  if (attacker.type === 'pawn') {
    // Pawns capture only enemy pawns and the enemy general.
    return target.type === 'pawn' || target.type === 'general'
  }
  if (attacker.type === 'general') {
    // The general captures anything except enemy pawns.
    return target.type !== 'pawn'
  }
  return RANK[attacker.type] >= RANK[target.type]
}

/**
 * Whether `attacker` may capture `target` in the current board state.
 * Face-down pieces can never be captured. Cannons need exactly one screen
 * piece between themselves and the target (and then ignore rank entirely).
 */
export function canCapture(state: GameState, attackerId: string, targetId: string): boolean {
  const attacker = state.pieces[attackerId]
  const target = state.pieces[targetId]
  if (!attacker || !target || attackerId === targetId) return false
  if (attacker.captured || target.captured) return false
  if (!attacker.faceUp) return false
  if (!target.faceUp) return false // hidden pieces can never be capture targets
  if (attacker.color === target.color) return false
  const from = findPiecePosition(state, attackerId)
  const to = findPiecePosition(state, targetId)
  if (!from || !to) return false

  if (attacker.type === 'cannon') {
    // Cannon capture: same row/column with exactly one screen piece between.
    // The screen may be any piece (own, enemy, face-up or face-down).
    return countPiecesBetween(state, from, to) === 1
  }

  if (!isAdjacent(from, to)) return false
  return rankAllowsCapture(attacker, target)
}

export function getLegalCaptures(state: GameState, pieceId: string): string[] {
  const piece = state.pieces[pieceId]
  const from = findPiecePosition(state, pieceId)
  if (!piece || !from || !piece.faceUp || piece.captured) return []

  const targets: string[] = []
  if (piece.type === 'cannon') {
    const directions = [
      { dr: -1, dc: 0 },
      { dr: 1, dc: 0 },
      { dr: 0, dc: -1 },
      { dr: 0, dc: 1 },
    ]
    for (const { dr, dc } of directions) {
      let screenSeen = false
      let row = from.row + dr
      let col = from.col + dc
      while (row >= 0 && row < ROWS && col >= 0 && col < COLS) {
        const occupant = pieceAt(state, { row, col })
        if (occupant) {
          if (!screenSeen) {
            screenSeen = true
          } else {
            if (canCapture(state, pieceId, occupant.id)) targets.push(occupant.id)
            break
          }
        }
        row += dr
        col += dc
      }
    }
    return targets
  }

  const neighbors: Position[] = [
    { row: from.row - 1, col: from.col },
    { row: from.row + 1, col: from.col },
    { row: from.row, col: from.col - 1 },
    { row: from.row, col: from.col + 1 },
  ]
  for (const pos of neighbors) {
    const occupant = pieceAt(state, pos)
    if (occupant && canCapture(state, pieceId, occupant.id)) targets.push(occupant.id)
  }
  return targets
}
