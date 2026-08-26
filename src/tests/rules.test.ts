import { describe, expect, it } from 'vitest'
import { createGame, findPiecePosition, pieceIdAt } from '../game/game-state'
import { createAllPieces } from '../game/pieces'
import { fisherYatesShuffle, secureRandomInt } from '../game/shuffle'
import { canCapture, canMove, getLegalCaptures, getLegalMoves } from '../game/rules'
import { applyAction, flipPiece, validateAction } from '../game/actions'
import { at, buildState } from './test-utils'

describe('setup', () => {
  it('creates 32 pieces, 16 per color, all face-down', () => {
    const state = createGame()
    const pieces = Object.values(state.pieces)
    expect(pieces).toHaveLength(32)
    expect(pieces.filter((p) => p.color === 'red')).toHaveLength(16)
    expect(pieces.filter((p) => p.color === 'black')).toHaveLength(16)
    expect(pieces.every((p) => !p.faceUp)).toBe(true)
    expect(pieces.every((p) => !p.captured)).toBe(true)
  })

  it('fills all 32 cells with exactly one piece each', () => {
    const state = createGame()
    expect(state.board).toHaveLength(32)
    expect(state.board.every((cell) => cell !== null)).toBe(true)
    expect(new Set(state.board).size).toBe(32)
  })

  it('shuffle preserves the multiset of pieces and does not mutate input', () => {
    const original = createAllPieces()
    const copy = original.slice()
    const shuffled = fisherYatesShuffle(original)
    expect(original).toEqual(copy)
    expect(shuffled).toHaveLength(32)
    expect(new Set(shuffled.map((p) => p.id)).size).toBe(32)
  })

  it('secureRandomInt stays within bounds', () => {
    for (let n = 1; n <= 8; n++) {
      for (let i = 0; i < 200; i++) {
        const v = secureRandomInt(n)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThan(n)
      }
    }
  })
})

describe('first flip assigns camps', () => {
  it('gives the flipping player the revealed color and the opponent the other', () => {
    const layout = createAllPieces() // index 0 is red-general-0
    const state = createGame({ layout })
    const first = layout[0]!
    const next = flipPiece(state, first.id)
    expect(first.color).toBe('red')
    expect(next.players[0].color).toBe('red')
    expect(next.players[1].color).toBe('black')
  })

  it('assigns black to player 1 when the first flip reveals a black piece', () => {
    const layout = createAllPieces().reverse() // index 0 is a black piece
    const state = createGame({ layout })
    const first = layout[0]!
    expect(first.color).toBe('black')
    const next = flipPiece(state, first.id)
    expect(next.players[0].color).toBe('black')
    expect(next.players[1].color).toBe('red')
  })

  it('never reassigns camps on later flips', () => {
    const layout = createAllPieces()
    let state = createGame({ layout })
    state = flipPiece(state, layout[0]!.id) // red revealed by P1
    const blackPiece = layout.find((p) => p.color === 'black')!
    state = flipPiece(state, blackPiece.id) // P2 flips a black piece
    expect(state.players[0].color).toBe('red')
    expect(state.players[1].color).toBe('black')
  })
})

describe('turns', () => {
  it('switches player after every action', () => {
    const layout = createAllPieces()
    const state = createGame({ layout })
    expect(state.currentPlayerIndex).toBe(0)
    const next = flipPiece(state, layout[5]!.id)
    expect(next.currentPlayerIndex).toBe(1)
  })

  it('rejects acting with a piece that is not yours (one action per turn)', () => {
    // P1 (red) moves a red piece; the returned state must reject another red action.
    const state = buildState([
      { color: 'red', type: 'rook', row: 0, col: 0, id: 'r1' },
      { color: 'black', type: 'rook', row: 3, col: 7, id: 'b1' },
    ])
    const next = applyAction(state, { kind: 'move', pieceId: 'r1', to: at(0, 1) })
    expect(next.currentPlayerIndex).toBe(1)
    expect(validateAction(next, { kind: 'move', pieceId: 'r1', to: at(0, 2) })).toBe('這不是你的棋子')
    expect(validateAction(next, { kind: 'move', pieceId: 'b1', to: at(3, 6) })).toBeNull()
  })

  it('rejects any action once the game is over', () => {
    const state = buildState([
      { color: 'red', type: 'rook', row: 0, col: 0, id: 'r1' },
      { color: 'black', type: 'horse', row: 0, col: 1, id: 'b1' },
    ])
    const done = applyAction(state, { kind: 'capture', attackerId: 'r1', targetId: 'b1' })
    expect(done.status).toBe('won')
    expect(validateAction(done, { kind: 'move', pieceId: 'r1', to: at(0, 0) })).toBe('對局已結束')
  })
})

describe('movement', () => {
  const base = () =>
    buildState([
      { color: 'red', type: 'horse', row: 1, col: 3, id: 'h' },
      { color: 'red', type: 'pawn', row: 1, col: 4, id: 'blocker' },
    ])

  it('allows one step up, down, left, right', () => {
    const state = base()
    expect(canMove(state, 'h', at(0, 3))).toBe(true)
    expect(canMove(state, 'h', at(2, 3))).toBe(true)
    expect(canMove(state, 'h', at(1, 2))).toBe(true)
  })

  it('rejects diagonal moves', () => {
    const state = base()
    expect(canMove(state, 'h', at(0, 2))).toBe(false)
    expect(canMove(state, 'h', at(2, 4))).toBe(false)
  })

  it('rejects moving two cells (no chess-style long moves)', () => {
    const state = base()
    expect(canMove(state, 'h', at(3, 3))).toBe(false)
    expect(canMove(state, 'h', at(1, 1))).toBe(false)
  })

  it('rejects moving onto an occupied cell', () => {
    const state = base()
    expect(canMove(state, 'h', at(1, 4))).toBe(false)
  })

  it('rejects moving off the board and lists only legal targets', () => {
    const state = buildState([{ color: 'red', type: 'rook', row: 0, col: 0, id: 'r' }])
    expect(canMove(state, 'r', at(-1, 0))).toBe(false)
    expect(canMove(state, 'r', at(0, -1))).toBe(false)
    expect(getLegalMoves(state, 'r')).toEqual(
      expect.arrayContaining([at(1, 0), at(0, 1)]),
    )
    expect(getLegalMoves(state, 'r')).toHaveLength(2)
  })

  it('rejects moving a face-down piece', () => {
    const state = buildState([{ color: 'red', type: 'rook', row: 0, col: 0, id: 'r', faceUp: false }])
    expect(canMove(state, 'r', at(0, 1))).toBe(false)
    expect(validateAction(state, { kind: 'move', pieceId: 'r', to: at(0, 1) })).toBe('不能移動暗棋')
  })
})

describe('ordinary captures (rank hierarchy)', () => {
  function capturePair(attackerType: Parameters<typeof buildState>[0][0]['type'], targetType: typeof attackerType) {
    return buildState([
      { color: 'red', type: attackerType, row: 1, col: 1, id: 'atk' },
      { color: 'black', type: targetType, row: 1, col: 2, id: 'tgt' },
    ])
  }

  it('higher rank captures lower rank', () => {
    expect(canCapture(capturePair('advisor', 'elephant'), 'atk', 'tgt')).toBe(true)
    expect(canCapture(capturePair('rook', 'horse'), 'atk', 'tgt')).toBe(true)
    expect(canCapture(capturePair('elephant', 'cannon'), 'atk', 'tgt')).toBe(true)
  })

  it('equal ranks capture each other', () => {
    expect(canCapture(capturePair('rook', 'rook'), 'atk', 'tgt')).toBe(true)
    expect(canCapture(capturePair('pawn', 'pawn'), 'atk', 'tgt')).toBe(true)
    expect(canCapture(capturePair('general', 'general'), 'atk', 'tgt')).toBe(true)
  })

  it('lower rank cannot capture higher rank', () => {
    expect(canCapture(capturePair('horse', 'rook'), 'atk', 'tgt')).toBe(false)
    expect(canCapture(capturePair('elephant', 'advisor'), 'atk', 'tgt')).toBe(false)
    expect(canCapture(capturePair('pawn', 'advisor'), 'atk', 'tgt')).toBe(false)
  })

  it('requires adjacency for non-cannon captures', () => {
    const state = buildState([
      { color: 'red', type: 'rook', row: 1, col: 1, id: 'atk' },
      { color: 'black', type: 'horse', row: 1, col: 3, id: 'far' },
      { color: 'black', type: 'horse', row: 2, col: 2, id: 'diag' },
    ])
    expect(canCapture(state, 'atk', 'far')).toBe(false)
    expect(canCapture(state, 'atk', 'diag')).toBe(false)
  })

  it('cannot capture your own pieces', () => {
    const state = buildState([
      { color: 'red', type: 'rook', row: 1, col: 1, id: 'atk' },
      { color: 'red', type: 'horse', row: 1, col: 2, id: 'own' },
    ])
    expect(canCapture(state, 'atk', 'own')).toBe(false)
  })
})

describe('general vs pawn', () => {
  it('a pawn can capture the enemy general', () => {
    const state = buildState([
      { color: 'red', type: 'pawn', row: 0, col: 0, id: 'pawn' },
      { color: 'black', type: 'general', row: 0, col: 1, id: 'general' },
    ])
    expect(canCapture(state, 'pawn', 'general')).toBe(true)
  })

  it('a 卒 can capture the enemy 帥', () => {
    const state = buildState(
      [
        { color: 'black', type: 'pawn', row: 0, col: 0, id: 'pawn' },
        { color: 'red', type: 'general', row: 0, col: 1, id: 'general' },
      ],
      { currentColor: 'black' },
    )
    expect(canCapture(state, 'pawn', 'general')).toBe(true)
  })

  it('the general cannot capture enemy pawns (both directions)', () => {
    const redGeneral = buildState([
      { color: 'red', type: 'general', row: 0, col: 0, id: 'general' },
      { color: 'black', type: 'pawn', row: 0, col: 1, id: 'pawn' },
    ])
    expect(canCapture(redGeneral, 'general', 'pawn')).toBe(false)

    const blackGeneral = buildState(
      [
        { color: 'black', type: 'general', row: 0, col: 0, id: 'general' },
        { color: 'red', type: 'pawn', row: 0, col: 1, id: 'pawn' },
      ],
      { currentColor: 'black' },
    )
    expect(canCapture(blackGeneral, 'general', 'pawn')).toBe(false)
  })

  it('a pawn cannot capture advisor / elephant / rook / horse / cannon', () => {
    for (const type of ['advisor', 'elephant', 'rook', 'horse', 'cannon'] as const) {
      const state = buildState([
        { color: 'red', type: 'pawn', row: 0, col: 0, id: 'pawn' },
        { color: 'black', type, row: 0, col: 1, id: 'tgt' },
      ])
      expect(canCapture(state, 'pawn', 'tgt')).toBe(false)
    }
  })

  it('the general can capture everything except pawns', () => {
    for (const type of ['general', 'advisor', 'elephant', 'rook', 'horse', 'cannon'] as const) {
      const state = buildState([
        { color: 'red', type: 'general', row: 0, col: 0, id: 'general' },
        { color: 'black', type, row: 0, col: 1, id: 'tgt' },
      ])
      expect(canCapture(state, 'general', 'tgt')).toBe(true)
    }
  })
})

describe('hidden pieces', () => {
  it('face-down pieces can never be capture targets', () => {
    for (const type of ['general', 'advisor', 'elephant', 'rook', 'horse', 'pawn'] as const) {
      const state = buildState([
        { color: 'red', type, row: 0, col: 0, id: 'atk' },
        { color: 'black', type: 'pawn', row: 0, col: 1, id: 'hidden', faceUp: false },
      ])
      expect(canCapture(state, 'atk', 'hidden')).toBe(false)
      expect(getLegalCaptures(state, 'atk')).toEqual([])
    }
  })

  it('validateAction reports capturing a hidden piece as illegal', () => {
    const state = buildState([
      { color: 'red', type: 'general', row: 0, col: 0, id: 'atk' },
      { color: 'black', type: 'pawn', row: 0, col: 1, id: 'hidden', faceUp: false },
    ])
    expect(validateAction(state, { kind: 'capture', attackerId: 'atk', targetId: 'hidden' })).toBe('不能吃暗棋')
  })

  it('flipping is always allowed on any face-down piece', () => {
    const layout = createAllPieces()
    const state = createGame({ layout })
    expect(validateAction(state, { kind: 'flip', pieceId: layout[31]!.id })).toBeNull()
  })

  it('re-flipping a face-up piece is illegal', () => {
    const layout = createAllPieces()
    const flipped = flipPiece(createGame({ layout }), layout[0]!.id)
    expect(validateAction(flipped, { kind: 'flip', pieceId: layout[0]!.id })).toBe('這顆棋已經翻開')
  })
})

describe('board bookkeeping', () => {
  it('move updates the board cells', () => {
    const state = buildState([{ color: 'red', type: 'rook', row: 2, col: 2, id: 'r' }])
    const next = applyAction(state, { kind: 'move', pieceId: 'r', to: at(2, 3) })
    expect(pieceIdAt(next, at(2, 2))).toBeNull()
    expect(pieceIdAt(next, at(2, 3))).toBe('r')
    expect(findPiecePosition(next, 'r')).toEqual(at(2, 3))
  })

  it('capture moves the attacker onto the target cell and marks the target captured', () => {
    const state = buildState([
      { color: 'red', type: 'rook', row: 1, col: 1, id: 'atk' },
      { color: 'black', type: 'horse', row: 1, col: 2, id: 'tgt' },
      { color: 'black', type: 'rook', row: 3, col: 7, id: 'other' },
    ])
    const next = applyAction(state, { kind: 'capture', attackerId: 'atk', targetId: 'tgt' })
    expect(next.pieces['tgt']!.captured).toBe(true)
    expect(pieceIdAt(next, at(1, 2))).toBe('atk')
    expect(pieceIdAt(next, at(1, 1))).toBeNull()
    expect(findPiecePosition(next, 'tgt')).toBeNull()
  })
})
