import { describe, it, expect } from 'vitest'
import { formatHistoryConclusion, formatHistoryEntry, positionLabel } from '../ui/history'
import type { GameState } from '../game/types'

function makeState(status: GameState['status'], winnerIndex: 0 | 1 | null): GameState {
  return {
    board: Array(32).fill(null),
    pieces: {},
    players: [{ id: 'p1', name: '玩家一', color: 'red' }, { id: 'p2', name: '玩家二', color: 'black' }],
    currentPlayerIndex: 0,
    status,
    winnerIndex,
    turnNumber: 5,
    noCaptureTurnCount: 0,
    history: [],
  }
}

describe('formatHistoryConclusion', () => {
  it('returns null when game is still playing', () => {
    const state = makeState('playing', null)
    expect(formatHistoryConclusion(state)).toBeNull()
  })

  it('formats winner and reason when game is won', () => {
    const state = makeState('won', 0)
    expect(formatHistoryConclusion(state, '走棋逾時，判定敗北')).toBe('🏆 玩家一 獲勝 · 走棋逾時，判定敗北')
  })

  it('formats draw and reason when game is draw', () => {
    const state = makeState('draw', null)
    expect(formatHistoryConclusion(state, '雙方同意和棋')).toBe('🤝 和局 · 雙方同意和棋')
  })
})

describe('positionLabel and formatHistoryEntry', () => {
  it('formats board coordinate correctly', () => {
    expect(positionLabel({ row: 0, col: 0 })).toBe('A1')
    expect(positionLabel({ row: 3, col: 7 })).toBe('H4')
  })

  it('formats flip, move, and capture entries', () => {
    const state = makeState('playing', null)
    expect(
      formatHistoryEntry(
        { turn: 1, playerIndex: 0, kind: 'flip', pieceColor: 'red', pieceType: 'general', to: { row: 0, col: 0 } },
        state,
      ),
    ).toBe('玩家一 翻開 紅帥 A1')

    expect(
      formatHistoryEntry(
        {
          turn: 2,
          playerIndex: 1,
          kind: 'move',
          pieceColor: 'black',
          pieceType: 'general',
          from: { row: 0, col: 1 },
          to: { row: 0, col: 0 },
        },
        state,
      ),
    ).toBe('玩家二 將 B1 → A1')

    expect(
      formatHistoryEntry(
        {
          turn: 3,
          playerIndex: 0,
          kind: 'capture',
          pieceColor: 'red',
          pieceType: 'pawn',
          targetColor: 'black',
          targetType: 'general',
          from: { row: 1, col: 0 },
          to: { row: 0, col: 0 },
        },
        state,
      ),
    ).toBe('玩家一 兵 A2 ✕ 將 A1')
  })
})
