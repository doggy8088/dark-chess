import type { Color, PieceType } from './types'

export const ROWS = 4
export const COLS = 8
export const CELL_COUNT = ROWS * COLS

/** Taiwan Dark Chess Rules v1: draw after this many consecutive turns without a capture. */
export const NO_CAPTURE_DRAW_LIMIT = 25

/** Rank ordering used for ordinary captures (higher may capture lower or equal). */
export const RANK: Record<PieceType, number> = {
  general: 7,
  advisor: 6,
  elephant: 5,
  rook: 4,
  horse: 3,
  cannon: 2,
  pawn: 1,
}

/** How many of each type exist per color in a full set. */
export const PIECE_COUNTS: Record<PieceType, number> = {
  general: 1,
  advisor: 2,
  elephant: 2,
  rook: 2,
  horse: 2,
  cannon: 2,
  pawn: 5,
}

export const PIECE_CHAR: Record<Color, Record<PieceType, string>> = {
  red: {
    general: '帥',
    advisor: '仕',
    elephant: '相',
    rook: '俥',
    horse: '傌',
    cannon: '炮',
    pawn: '兵',
  },
  black: {
    general: '將',
    advisor: '士',
    elephant: '象',
    rook: '車',
    horse: '馬',
    cannon: '包',
    pawn: '卒',
  },
}

export const COLOR_NAME: Record<Color, string> = {
  red: '紅方',
  black: '黑方',
}

export const RULES_VERSION = 'Taiwan Dark Chess Rules v1'
