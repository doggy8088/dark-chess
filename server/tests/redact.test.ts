import { describe, expect, it } from 'vitest'
import { Room } from '../room'
import { redactState } from '../redact'
import { applyAction } from '../../src/game/actions'
import { makeDeps } from './server-test-utils'

async function newRoom() {
  return Room.create('testroom22', '甲', makeDeps())
}

describe('redactState', () => {
  it('strips color and type from face-down uncaptured pieces', async () => {
    const room = await newRoom()
    const dto = redactState(room.state)
    for (const piece of Object.values(dto.pieces)) {
      expect(piece.color).toBeUndefined()
      expect(piece.type).toBeUndefined()
      expect(piece.faceUp).toBe(false)
    }
  })

  it('leaks no identity substrings anywhere in the serialized DTO', async () => {
    const room = await newRoom()
    const serialized = JSON.stringify(redactState(room.state))
    // Quoted string values only — the key "captured" itself contains "red".
    expect(serialized).not.toMatch(/"(red|black)"/)
    expect(serialized).not.toMatch(/"(general|advisor|elephant|rook|horse|cannon|pawn)"/)
  })

  it('relabels piece ids to opaque c00–c31', async () => {
    const room = await newRoom()
    const ids = Object.keys(room.state.pieces).sort()
    expect(ids).toHaveLength(32)
    expect(ids[0]).toBe('c00')
    expect(ids[31]).toBe('c31')
    for (const id of ids) expect(id).toMatch(/^c\d{2}$/)
  })

  it('reveals a piece once flipped, and keeps others hidden', async () => {
    const room = await newRoom()
    const next = applyAction(room.state, { kind: 'flip', pieceId: 'c00' })
    const dto = redactState(next)
    expect(dto.pieces.c00!.color).toBeDefined()
    expect(dto.pieces.c00!.type).toBeDefined()
    expect(dto.pieces.c00!.faceUp).toBe(true)
    expect(dto.pieces.c01!.color).toBeUndefined()
    // History records the flip — that is public information after the flip.
    expect(dto.history).toHaveLength(1)
  })

  it('keeps board occupancy and players intact', async () => {
    const room = await newRoom()
    const dto = redactState(room.state)
    expect(dto.board).toEqual(room.state.board)
    expect(dto.players[0].name).toBe('甲')
    expect(dto.turnNumber).toBe(0)
  })
})
