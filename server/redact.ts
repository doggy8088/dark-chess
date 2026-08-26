import type { GameState } from '../src/game/types'
import type { RedactedPiece, RedactedStateDTO } from '../src/shared/protocol'

/**
 * Strips hidden information before a state leaves the server. A face-down,
 * uncaptured piece keeps only its opaque id and flags; face-up or captured
 * pieces are public. Everything else in GameState is public already
 * (history only ever records revealed pieces).
 */
export function redactState(state: GameState): RedactedStateDTO {
  const pieces: Record<string, RedactedPiece> = {}
  for (const piece of Object.values(state.pieces)) {
    if (piece.faceUp || piece.captured) {
      pieces[piece.id] = {
        id: piece.id,
        faceUp: piece.faceUp,
        captured: piece.captured,
        color: piece.color,
        type: piece.type,
      }
    } else {
      pieces[piece.id] = { id: piece.id, faceUp: false, captured: false }
    }
  }
  return {
    board: [...state.board],
    pieces,
    players: [{ ...state.players[0] }, { ...state.players[1] }],
    currentPlayerIndex: state.currentPlayerIndex,
    status: state.status,
    winnerIndex: state.winnerIndex,
    turnNumber: state.turnNumber,
    noCaptureTurnCount: state.noCaptureTurnCount,
    history: structuredClone(state.history),
  }
}
