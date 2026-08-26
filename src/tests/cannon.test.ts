import { describe, expect, it } from 'vitest'
import { canCapture, canMove, getLegalCaptures, getLegalMoves } from '../game/rules'
import { validateAction } from '../game/actions'
import { at, buildState, type PieceSpec } from './test-utils'

const cannon = (row: number, col: number): PieceSpec => ({
  color: 'red',
  type: 'cannon',
  row,
  col,
  id: 'cannon',
})

describe('cannon captures (screen rule)', () => {
  it('cannot capture with 0 screens, even an adjacent enemy', () => {
    const state = buildState([
      cannon(1, 1),
      { color: 'black', type: 'pawn', row: 1, col: 2, id: 'adjacent' },
      { color: 'black', type: 'pawn', row: 1, col: 5, id: 'far' },
    ])
    expect(canCapture(state, 'cannon', 'adjacent')).toBe(false)
    // 'far' has 'adjacent' as its single screen, so it IS capturable — but a
    // direct line with nothing between ('adjacent' itself) is not.
    expect(canCapture(state, 'cannon', 'far')).toBe(true)
  })

  it('cannot capture over an empty line (0 pieces between)', () => {
    const state = buildState([
      cannon(2, 0),
      { color: 'black', type: 'rook', row: 2, col: 6, id: 'tgt' },
    ])
    expect(canCapture(state, 'cannon', 'tgt')).toBe(false)
  })

  it('captures with exactly 1 screen', () => {
    const state = buildState([
      cannon(2, 0),
      { color: 'black', type: 'pawn', row: 2, col: 3, id: 'screen' },
      { color: 'black', type: 'rook', row: 2, col: 6, id: 'tgt' },
    ])
    expect(canCapture(state, 'cannon', 'tgt')).toBe(true)
  })

  it('cannot capture with 2 screens', () => {
    const state = buildState([
      cannon(2, 0),
      { color: 'black', type: 'pawn', row: 2, col: 2, id: 's1' },
      { color: 'red', type: 'pawn', row: 2, col: 4, id: 's2' },
      { color: 'black', type: 'rook', row: 2, col: 6, id: 'tgt' },
    ])
    expect(canCapture(state, 'cannon', 'tgt')).toBe(false)
  })

  it('cannot capture with 3 screens', () => {
    const state = buildState([
      cannon(2, 0),
      { color: 'black', type: 'pawn', row: 2, col: 1, id: 's1' },
      { color: 'red', type: 'pawn', row: 2, col: 3, id: 's2' },
      { color: 'black', type: 'horse', row: 2, col: 5, id: 's3' },
      { color: 'black', type: 'rook', row: 2, col: 7, id: 'tgt' },
    ])
    expect(canCapture(state, 'cannon', 'tgt')).toBe(false)
  })

  it('a face-down (hidden) piece works as a screen', () => {
    const state = buildState([
      cannon(0, 0),
      { color: 'black', type: 'general', row: 0, col: 3, id: 'screen', faceUp: false },
      { color: 'black', type: 'rook', row: 0, col: 5, id: 'tgt' },
    ])
    expect(canCapture(state, 'cannon', 'tgt')).toBe(true)
  })

  it('an enemy piece works as a screen', () => {
    const state = buildState([
      cannon(0, 0),
      { color: 'black', type: 'horse', row: 0, col: 2, id: 'screen' },
      { color: 'black', type: 'rook', row: 0, col: 6, id: 'tgt' },
    ])
    expect(canCapture(state, 'cannon', 'tgt')).toBe(true)
  })

  it('an own piece works as a screen', () => {
    const state = buildState([
      cannon(0, 0),
      { color: 'red', type: 'pawn', row: 0, col: 4, id: 'screen' },
      { color: 'black', type: 'rook', row: 0, col: 7, id: 'tgt' },
    ])
    expect(canCapture(state, 'cannon', 'tgt')).toBe(true)
  })

  it('works vertically and across long distances', () => {
    const state = buildState([
      cannon(0, 5),
      { color: 'red', type: 'pawn', row: 2, col: 5, id: 'screen' },
      { color: 'black', type: 'advisor', row: 3, col: 5, id: 'tgt' },
    ])
    expect(canCapture(state, 'cannon', 'tgt')).toBe(true)
  })

  it('ignores rank completely: can capture the general and a pawn', () => {
    const vsGeneral = buildState([
      cannon(1, 0),
      { color: 'black', type: 'pawn', row: 1, col: 2, id: 'screen' },
      { color: 'black', type: 'general', row: 1, col: 4, id: 'tgt' },
    ])
    expect(canCapture(vsGeneral, 'cannon', 'tgt')).toBe(true)

    const vsPawn = buildState([
      cannon(1, 0),
      { color: 'red', type: 'rook', row: 1, col: 3, id: 'screen' },
      { color: 'black', type: 'pawn', row: 1, col: 5, id: 'tgt' },
    ])
    expect(canCapture(vsPawn, 'cannon', 'tgt')).toBe(true)
  })

  it('cannot capture a hidden piece even with a valid screen', () => {
    const state = buildState([
      cannon(3, 0),
      { color: 'red', type: 'pawn', row: 3, col: 2, id: 'screen' },
      { color: 'black', type: 'rook', row: 3, col: 5, id: 'hidden', faceUp: false },
    ])
    expect(canCapture(state, 'cannon', 'hidden')).toBe(false)
    expect(validateAction(state, { kind: 'capture', attackerId: 'cannon', targetId: 'hidden' })).toBe('不能吃暗棋')
  })

  it('cannot capture own pieces or off-line targets', () => {
    const state = buildState([
      cannon(1, 1),
      { color: 'red', type: 'pawn', row: 1, col: 3, id: 'screen' },
      { color: 'red', type: 'horse', row: 1, col: 5, id: 'own' },
      { color: 'black', type: 'rook', row: 2, col: 4, id: 'offline' },
    ])
    expect(canCapture(state, 'cannon', 'own')).toBe(false)
    expect(canCapture(state, 'cannon', 'offline')).toBe(false)
  })

  it('getLegalCaptures finds the first piece beyond the screen in each direction only', () => {
    const state = buildState([
      cannon(2, 3),
      // Row: screen at col 4, target at col 6, another piece beyond at col 7.
      { color: 'red', type: 'pawn', row: 2, col: 4, id: 'screen-row' },
      { color: 'black', type: 'rook', row: 2, col: 6, id: 'target-row' },
      { color: 'black', type: 'horse', row: 2, col: 7, id: 'beyond' },
      // Column: screen at row 1, hidden piece at row 0 (not capturable).
      { color: 'black', type: 'pawn', row: 1, col: 3, id: 'screen-col' },
      { color: 'black', type: 'general', row: 0, col: 3, id: 'hidden-col', faceUp: false },
    ])
    expect(getLegalCaptures(state, 'cannon')).toEqual(['target-row'])
  })
})

describe('cannon ordinary movement', () => {
  it('moves exactly one orthogonal step onto an empty cell, like every other piece', () => {
    const state = buildState([cannon(1, 4)])
    expect(getLegalMoves(state, 'cannon')).toEqual(
      expect.arrayContaining([at(0, 4), at(2, 4), at(1, 3), at(1, 5)]),
    )
    expect(getLegalMoves(state, 'cannon')).toHaveLength(4)
  })

  it('cannot slide multiple cells', () => {
    const state = buildState([cannon(1, 1)])
    expect(canMove(state, 'cannon', at(1, 4))).toBe(false)
    expect(canMove(state, 'cannon', at(3, 1))).toBe(false)
  })

  it('cannot jump over a piece as a normal move', () => {
    const state = buildState([
      cannon(1, 1),
      { color: 'black', type: 'pawn', row: 1, col: 2, id: 'blocker' },
    ])
    expect(canMove(state, 'cannon', at(1, 2))).toBe(false)
    expect(canMove(state, 'cannon', at(1, 3))).toBe(false)
  })
})
