import { describe, expect, it } from 'vitest'
import { Room } from '../room'
import { RoomManager } from '../rooms'
import { computeCommitmentHash } from '../../src/game/fairness'
import { buildState, at } from '../../src/tests/test-utils'
import { FakeSocket, makeDeps } from './server-test-utils'

async function seatedRoom(deps = makeDeps()) {
  const room = await Room.create('testroom22', '甲', deps)
  const a = new FakeSocket()
  const b = new FakeSocket()
  room.join(a, room.seats[0].token, undefined)
  room.join(b, undefined, '乙')
  return { room, a, b, deps }
}

describe('Room seating', () => {
  it('creator reclaims seat 0 by token; second visitor takes seat 1 and starts the game', async () => {
    const { room, a, b } = await seatedRoom()
    const joinedA = a.ofType('joined')[0]!
    const joinedB = b.ofType('joined')[0]!
    expect(joinedA.seat).toBe(0)
    expect(joinedB.seat).toBe(1)
    expect(room.status).toBe('playing')
    expect(room.state.players[1].name).toBe('乙')
    expect(joinedB.playerToken).toBeTruthy()
    expect(joinedB.fairnessHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('watch intent never claims an empty seat', async () => {
    const deps = makeDeps()
    const room = await Room.create('testroom22', '甲', deps)
    const watcher = new FakeSocket()
    room.join(watcher, undefined, '觀眾丙', true)
    expect(watcher.ofType('joined')[0]!.seat).toBe('spectator')
    expect(room.status).toBe('waiting')
    expect(room.seats[1]).toBeNull()
    // A real opponent can still take the seat afterwards.
    const b = new FakeSocket()
    room.join(b, undefined, '乙')
    expect(b.ofType('joined')[0]!.seat).toBe(1)
    expect(room.status).toBe('playing')
  })

  it('third visitor becomes a spectator', async () => {
    const { room } = await seatedRoom()
    const c = new FakeSocket()
    room.join(c, undefined, '丙')
    expect(c.ofType('joined')[0]!.seat).toBe('spectator')
  })

  it('same token in a second window kicks the first socket', async () => {
    const { room, a } = await seatedRoom()
    const a2 = new FakeSocket()
    room.join(a2, room.seats[0].token, undefined)
    expect(a.closed).toBe(true)
    expect(a.ofType('error')[0]!.code).toBe('connected-elsewhere')
    expect(a2.ofType('joined')[0]!.seat).toBe(0)
  })

  it('a disconnected player rejoins their seat with the same token', async () => {
    const { room, b } = await seatedRoom()
    room.disconnect(b)
    const b2 = new FakeSocket()
    room.join(b2, b.ofType('joined')[0]!.playerToken, undefined)
    expect(b2.ofType('joined')[0]!.seat).toBe(1)
  })
})

describe('Room actions', () => {
  it('rejects actions from the player not on turn', async () => {
    const { room, a, b } = await seatedRoom()
    const notOnTurn = room.state.currentPlayerIndex === 0 ? b : a
    room.handleMessage(notOnTurn, { t: 'action', seq: 7, action: { kind: 'flip', pieceId: 'c00' } })
    const invalid = notOnTurn.ofType('invalid')[0]!
    expect(invalid.seq).toBe(7)
    expect(invalid.message).toBe('還沒輪到你')
  })

  it('applies a legal flip: reveal to everyone, seq echoed only to the actor', async () => {
    const { room, a, b } = await seatedRoom()
    const [actor, other] = room.state.currentPlayerIndex === 0 ? [a, b] : [b, a]
    room.handleMessage(actor, { t: 'action', seq: 1, action: { kind: 'flip', pieceId: 'c05' } })
    const mine = actor.ofType('actionApplied')[0]!
    const theirs = other.ofType('actionApplied')[0]!
    expect(mine.seq).toBe(1)
    expect(theirs.seq).toBeUndefined()
    expect(mine.reveal!.pieceId).toBe('c05')
    expect(theirs.state.pieces.c05!.faceUp).toBe(true)
    expect(theirs.state.pieces.c06!.color).toBeUndefined()
    expect(mine.deadline).not.toBeNull()
  })

  it('returns the engine zh-TW error for illegal actions', async () => {
    const { room, a, b } = await seatedRoom()
    const actor = room.state.currentPlayerIndex === 0 ? a : b
    room.handleMessage(actor, { t: 'action', seq: 2, action: { kind: 'move', pieceId: 'c00', to: at(0, 1) } })
    expect(actor.ofType('invalid')[0]!.message).toBe('不能移動暗棋')
  })

  it('finishes with gameOver + verifiable fairness reveal when the last piece falls', async () => {
    const { room, a, b } = await seatedRoom()
    // Force an endgame: red general (seat 0) next to black's last piece.
    room.state = buildState([
      { id: 'c00', color: 'red', type: 'general', row: 0, col: 0 },
      { id: 'c01', color: 'black', type: 'advisor', row: 0, col: 1 },
    ])
    room.handleMessage(a, { t: 'action', seq: 3, action: { kind: 'capture', attackerId: 'c00', targetId: 'c01' } })
    const over = a.ofType('gameOver')[0]!
    expect(over.reason).toBe('capture')
    expect(over.winnerIndex).toBe(0)
    expect(b.ofType('gameOver')).toHaveLength(1)
    expect(room.status).toBe('finished')
    const recomputed = await computeCommitmentHash(over.fairnessReveal.layout, over.fairnessReveal.nonce)
    expect(recomputed).toBe(over.fairnessReveal.hash)
    expect(over.fairnessReveal.layout).toHaveLength(32)
  })

  it('resign gives the win to the opponent', async () => {
    const { room, a, b } = await seatedRoom()
    room.handleMessage(b, { t: 'resign' })
    const over = a.ofType('gameOver')[0]!
    expect(over.reason).toBe('resign')
    expect(over.winnerIndex).toBe(0)
    expect(room.status).toBe('finished')
  })

  it('abort with a connected opponent requires their consent', async () => {
    const { room, a, b } = await seatedRoom()
    room.handleMessage(a, { t: 'abortRequest' })
    expect(room.status).toBe('playing')
    expect(b.ofType('abortOffered')[0]!.by).toBe(0)
    room.handleMessage(b, { t: 'abortResponse', accept: true })
    const over = a.ofType('gameOver')[0]!
    expect(over.reason).toBe('aborted')
    expect(over.winnerIndex).toBeNull()
    expect(room.status).toBe('finished')
  })

  it('abort can be declined and play continues', async () => {
    const { room, a, b } = await seatedRoom()
    room.handleMessage(a, { t: 'abortRequest' })
    room.handleMessage(b, { t: 'abortResponse', accept: false })
    expect(a.ofType('abortRejected')[0]!.by).toBe(1)
    expect(room.status).toBe('playing')
  })

  it('abort ends immediately when the opponent is disconnected', async () => {
    const { room, a, b } = await seatedRoom()
    room.disconnect(b)
    room.handleMessage(a, { t: 'abortRequest' })
    const over = a.ofType('gameOver')[0]!
    expect(over.reason).toBe('aborted')
    expect(over.winnerIndex).toBeNull()
    expect(room.status).toBe('finished')
  })

  it('draw offer + acceptance ends in an agreed draw', async () => {
    const { room, a, b } = await seatedRoom()
    room.handleMessage(a, { t: 'drawOffer' })
    expect(b.ofType('drawOffered')[0]!.by).toBe(0)
    room.handleMessage(b, { t: 'drawResponse', accept: true })
    const over = a.ofType('gameOver')[0]!
    expect(over.reason).toBe('draw-agreed')
    expect(over.winnerIndex).toBeNull()
  })

  it('rematch swaps the first mover and resets the board', async () => {
    const { room, a, b } = await seatedRoom()
    const previousFirst = room.state.currentPlayerIndex
    room.handleMessage(a, { t: 'resign' })
    room.handleMessage(a, { t: 'rematch' })
    expect(b.ofType('rematchOffered')[0]!.by).toBe(0)
    room.handleMessage(b, { t: 'rematchResponse', accept: true })
    // startRematch is async (recomputes the commitment hash).
    await new Promise((resolve) => setTimeout(resolve, 20))
    const start = a.ofType('rematchStart')[0]!
    expect(start.state.turnNumber).toBe(0)
    expect(start.state.currentPlayerIndex).toBe(previousFirst === 0 ? 1 : 0)
    expect(room.status).toBe('playing')
    expect(start.fairnessHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('spectators can chat (with their name) but cannot act', async () => {
    const { room, a, deps } = await seatedRoom()
    const c = new FakeSocket()
    room.join(c, undefined, '路人甲')
    room.handleMessage(c, { t: 'action', seq: 1, action: { kind: 'flip', pieceId: 'c00' } })
    room.handleMessage(c, { t: 'resign' })
    expect(c.ofType('invalid')).toHaveLength(0)
    expect(room.status).toBe('playing')
    expect(room.state.turnNumber).toBe(0)

    deps.clock.advance(1000)
    room.handleMessage(c, { t: 'chat', text: '加油！' })
    const heard = a.ofType('chat')[0]!
    expect(heard.msg.text).toBe('加油！')
    expect(heard.msg.from).toBe('spectator')
    expect(heard.msg.name).toBe('路人甲')
  })
})

describe('live games board', () => {
  it('lists in-progress games with public score info only', async () => {
    const deps = makeDeps()
    const manager = new RoomManager(deps.store, deps.now)
    const waiting = await manager.create('獨守空房')
    void waiting
    const { room, a } = await seatedRoom(deps)
    await deps.store.save(room.toDoc())
    if (room.state.currentPlayerIndex === 0) {
      room.handleMessage(a, { t: 'action', seq: 1, action: { kind: 'flip', pieceId: 'c00' } })
    }

    const games = await manager.listGames()
    // The waiting room (no opponent yet) is not listed.
    expect(games.every((g) => g.roomId !== waiting.roomId)).toBe(true)
    const listed = games.find((g) => g.roomId === room.roomId)
    expect(listed).toBeTruthy()
    expect(listed!.players[0].name).toBe('甲')
    expect(listed!.players[1].name).toBe('乙')
    expect(listed!.capturedRed).toBe(0)
    expect(listed!.capturedBlack).toBe(0)
    // No hidden identities anywhere in the payload.
    expect(JSON.stringify(games)).not.toMatch(/"(general|advisor|elephant|rook|horse|cannon|pawn)"/)
  })
})

describe('Room persistence round-trip', () => {
  it('rebuilds a room from its stored doc with state intact', async () => {
    const deps = makeDeps()
    const { room, a } = await seatedRoom(deps)
    const actor = room.state.currentPlayerIndex === 0 ? a : null
    if (actor) room.handleMessage(actor, { t: 'action', seq: 1, action: { kind: 'flip', pieceId: 'c03' } })
    const doc = room.toDoc()
    const revived = Room.fromDoc(doc, deps)
    expect(revived.roomId).toBe(room.roomId)
    expect(revived.state.turnNumber).toBe(room.state.turnNumber)
    expect(revived.state.pieces.c03?.faceUp).toBe(room.state.pieces.c03?.faceUp)
    expect(revived.fairness.hash).toBe(room.fairness.hash)
    expect(revived.seats[1]?.name).toBe('乙')
  })
})
