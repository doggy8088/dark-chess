import type { Position } from '../game/types'
import { COLS, ROWS } from '../game/constants'

/** World-space dimensions shared by rendering and physics. */
export const CELL = 1.06
export const PIECE_RADIUS = 0.4
export const PIECE_HEIGHT = 0.24
export const PIECE_BEVEL = 0.045

export const BOARD_MARGIN = 0.58
export const BOARD_WIDTH = COLS * CELL + BOARD_MARGIN * 2
export const BOARD_DEPTH = ROWS * CELL + BOARD_MARGIN * 2
export const BOARD_THICKNESS = 0.34
/** Y of the board's playing surface. */
export const BOARD_TOP = 0.05
export const TABLE_TOP = BOARD_TOP - BOARD_THICKNESS

export const PIECE_REST_Y = BOARD_TOP + PIECE_HEIGHT / 2

export function cellToWorld(pos: Position): { x: number; z: number } {
  return {
    x: (pos.col - (COLS - 1) / 2) * CELL,
    z: (pos.row - (ROWS - 1) / 2) * CELL,
  }
}

export function worldToCell(x: number, z: number): Position | null {
  const col = Math.round(x / CELL + (COLS - 1) / 2)
  const row = Math.round(z / CELL + (ROWS - 1) / 2)
  if (row < 0 || row >= ROWS || col < 0 || col >= COLS) return null
  return { row, col }
}
