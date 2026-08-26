import { describe, expect, it } from 'vitest'
import { applyAction, agreeDraw, checkDraw, checkVictory, validateAction } from '../game/actions'
import { NO_CAPTURE_DRAW_LIMIT } from '../game/constants'
import { at, buildState } from './test-utils'

describe('victory', () => {
  it('capturing the last enemy piece wins the game', () => {
    const state = buildState([
      { color: 'red', type: 'rook', row: 0, col: 0, id: 'atk' },
      { color: 'black', type: 'horse', row: 0, col: 1, id: 'last' },
    ])
    const next = applyAction(state, { kind: 'capture', attackerId: 'atk', targetId: 'last' })
    expect(next.status).toBe('won')
    expect(next.winnerIndex).toBe(0)
    expect(checkVictory(next)).toBe(0)
  })

  it('does not end the game while the loser still has hidden pieces', () => {
    const state = buildState([
      { color: 'red', type: 'rook', row: 0, col: 0, id: 'atk' },
      { color: 'black', type: 'horse', row: 0, col: 1, id: 'tgt' },
      { color: 'black', type: 'pawn', row: 3, col: 7, id: 'hidden', faceUp: false },
    ])
    const next = applyAction(state, { kind: 'capture', attackerId: 'atk', targetId: 'tgt' })
    expect(next.status).toBe('playing')
    expect(next.winnerIndex).toBeNull()
  })

  it('player 2 can win as well', () => {
    const base = buildState([
      { color: 'red', type: 'pawn', row: 2, col: 2, id: 'red-last' },
      { color: 'black', type: 'general', row: 3, col: 7, id: 'bg' },
      { color: 'black', type: 'rook', row: 2, col: 0, id: 'b-rook' },
    ])
    // P1 (red) moves next to the black rook, then P2 (black) captures red's last piece.
    const afterMove = applyAction(base, { kind: 'move', pieceId: 'red-last', to: at(2, 1) })
    const next = applyAction(afterMove, { kind: 'capture', attackerId: 'b-rook', targetId: 'red-last' })
    expect(next.status).toBe('won')
    expect(next.winnerIndex).toBe(1)
  })
})

describe('draw by no-capture counter (Taiwan Tournament Rules)', () => {
  it('increments on flips and moves, resets on captures', () => {
    let state = buildState([
      { color: 'red', type: 'rook', row: 0, col: 0, id: 'r' },
      { color: 'black', type: 'horse', row: 3, col: 7, id: 'b' },
      { color: 'black', type: 'pawn', row: 0, col: 1, id: 'victim' },
      { color: 'red', type: 'pawn', row: 3, col: 0, id: 'hidden', faceUp: false },
    ])
    state = applyAction(state, { kind: 'move', pieceId: 'r', to: at(1, 0) })
    expect(state.noCaptureTurnCount).toBe(1)
    state = applyAction(state, { kind: 'flip', pieceId: 'hidden' })
    expect(state.noCaptureTurnCount).toBe(2)
    state = applyAction(state, { kind: 'move', pieceId: 'r', to: at(0, 0) })
    expect(state.noCaptureTurnCount).toBe(3)
    state = applyAction(state, { kind: 'move', pieceId: 'b', to: at(2, 7) })
    expect(state.noCaptureTurnCount).toBe(4)
    state = applyAction(state, { kind: 'capture', attackerId: 'r', targetId: 'victim' })
    expect(state.noCaptureTurnCount).toBe(0)
  })

  it(`declares a draw after ${NO_CAPTURE_DRAW_LIMIT} consecutive turns without a capture`, () => {
    const state = buildState([
      { color: 'red', type: 'rook', row: 0, col: 0, id: 'r' },
      { color: 'black', type: 'rook', row: 3, col: 7, id: 'b' },
    ])
    state.noCaptureTurnCount = NO_CAPTURE_DRAW_LIMIT - 1
    const next = applyAction(state, { kind: 'move', pieceId: 'r', to: at(0, 1) })
    expect(next.noCaptureTurnCount).toBe(NO_CAPTURE_DRAW_LIMIT)
    expect(checkDraw(next)).toBe(true)
    expect(next.status).toBe('draw')
    expect(next.winnerIndex).toBeNull()
  })

  it('a capture on the would-be final turn avoids the draw', () => {
    const state = buildState([
      { color: 'red', type: 'rook', row: 0, col: 0, id: 'r' },
      { color: 'black', type: 'horse', row: 0, col: 1, id: 'victim' },
      { color: 'black', type: 'rook', row: 3, col: 7, id: 'b' },
    ])
    state.noCaptureTurnCount = NO_CAPTURE_DRAW_LIMIT - 1
    const next = applyAction(state, { kind: 'capture', attackerId: 'r', targetId: 'victim' })
    expect(next.status).toBe('playing')
    expect(next.noCaptureTurnCount).toBe(0)
  })

  it('draw by mutual agreement ends the game', () => {
    const state = buildState([
      { color: 'red', type: 'rook', row: 0, col: 0, id: 'r' },
      { color: 'black', type: 'rook', row: 3, col: 7, id: 'b' },
    ])
    const next = agreeDraw(state)
    expect(next.status).toBe('draw')
    expect(validateAction(next, { kind: 'move', pieceId: 'r', to: at(0, 1) })).toBe('對局已結束')
  })
})

describe('fairness commitment', () => {
  it('commitment hash verifies for the original layout and fails after tampering', async () => {
    const { computeCommitmentHash, createCommitment, verifyCommitment } = await import('../game/fairness')
    const { createAllPieces } = await import('../game/pieces')
    const { fisherYatesShuffle } = await import('../game/shuffle')

    const layout = fisherYatesShuffle(createAllPieces())
    const data = await createCommitment(layout)
    expect(data.commitmentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(await verifyCommitment(data)).toBe(true)

    const tampered = data.layout.slice()
    const tmp = tampered[0]!
    tampered[0] = tampered[1]!
    tampered[1] = tmp
    expect(await computeCommitmentHash(tampered, data.nonce)).not.toBe(data.commitmentHash)
  })
})
