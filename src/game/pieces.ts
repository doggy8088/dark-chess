import type { Color, Piece, PieceType } from './types'
import { PIECE_COUNTS } from './constants'

const COLORS: Color[] = ['red', 'black']
const TYPES: PieceType[] = ['general', 'advisor', 'elephant', 'rook', 'horse', 'cannon', 'pawn']

/** Creates the full 32-piece set, all face-down and uncaptured. */
export function createAllPieces(): Piece[] {
  const pieces: Piece[] = []
  for (const color of COLORS) {
    for (const type of TYPES) {
      for (let i = 0; i < PIECE_COUNTS[type]; i++) {
        pieces.push({
          id: `${color}-${type}-${i}`,
          color,
          type,
          faceUp: false,
          captured: false,
        })
      }
    }
  }
  return pieces
}
