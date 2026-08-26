import { describe, expect, it } from 'vitest'
import { Room } from '../room'
import { GRACE_MS, TURN_MS } from '../config'
import { FakeSocket, makeDeps } from './server-test-utils'

async function seatedRoom(deps = makeDeps()) {
  const room = await Room.create('testroom22', '甲', deps)
  const a = new FakeSocket()
  const b = new FakeSocket()
  room.join(a, room.seats[0].token, undefined)
  room.join(b, undefined, '乙')
  const current = room.state.currentPlayerIndex
  const [mover, waiter] = current === 0 ? [a, b] : [b, a]
  return { room, a, b, mover, waiter, current, deps }
}

describe('turn clock', () => {
  it('running out the move clock loses the game', async () => {
    const { room, deps, current, waiter } = await seatedRoom()
    deps.clock.advance(TURN_MS + 1)
    room.evaluate()
    expect(room.status).toBe('finished')
    const over = waiter.ofType('gameOver')[0]!
    expect(over.reason).toBe('timeout')
    expect(over.winnerIndex).toBe(current === 0 ? 1 : 0)
  })

  it('deadline message carries absolute time plus serverNow', async () => {
    const { mover, deps } = await seatedRoom()
    const joined = mover.ofType('joined')[0]!
    // The deadline may ride in the joined, state (game-start), or deadline message.
    const deadline =
      joined.deadline ?? mover.ofType('deadline')[0]?.deadline ?? mover.ofType('state')[0]?.deadline
    expect(deadline).toBeTruthy()
    expect(deadline!.at - deps.clock.now()).toBeLessThanOrEqual(TURN_MS)
    expect(deadline!.at - deadline!.serverNow).toBeLessThanOrEqual(TURN_MS)
  })

  it('pauses the move clock when the player-to-move disconnects, then forfeits after grace', async () => {
    const { room, deps, mover, waiter, current } = await seatedRoom()
    deps.clock.advance(20_000) // 40s left on the move clock
    room.disconnect(mover)

    // The 60s move clock must NOT fire while paused: advance past it.
    deps.clock.advance(TURN_MS)
    room.evaluate()
    expect(room.status).toBe('playing')

    // But the 90s grace clock does fire.
    deps.clock.advance(GRACE_MS)
    room.evaluate()
    expect(room.status).toBe('finished')
    const over = waiter.ofType('gameOver')[0]!
    expect(over.reason).toBe('forfeit')
    expect(over.winnerIndex).toBe(current === 0 ? 1 : 0)
  })

  it('rejoining within grace resumes the remaining move time', async () => {
    const { room, deps, mover, current } = await seatedRoom()
    const token = mover.ofType('joined')[0]!.playerToken
    deps.clock.advance(20_000)
    room.disconnect(mover)
    deps.clock.advance(60_000) // inside the 90s grace

    const back = new FakeSocket()
    room.join(back, token, undefined)
    expect(room.status).toBe('playing')
    const rejoined = back.ofType('joined')[0]!
    expect(rejoined.deadline).not.toBeNull()
    // 40s were left when they dropped; the clock resumes from there.
    expect(rejoined.deadline!.at - deps.clock.now()).toBe(TURN_MS - 20_000)
    expect(rejoined.deadline!.seat).toBe(current)
  })

  it('turn passing to a disconnected player starts their grace clock', async () => {
    const { room, deps, mover, waiter } = await seatedRoom()
    room.disconnect(waiter)
    // Mover flips a piece; the turn passes to the disconnected opponent.
    room.handleMessage(mover, { t: 'action', seq: 1, action: { kind: 'flip', pieceId: 'c00' } })
    expect(room.status).toBe('playing')
    deps.clock.advance(GRACE_MS + 1)
    room.evaluate()
    expect(room.status).toBe('finished')
    expect(mover.ofType('gameOver')[0]!.reason).toBe('forfeit')
  })

  it('after a long outage the room revives with a fresh grace window, then forfeits lazily', async () => {
    const deps = makeDeps()
    const { room, mover } = await seatedRoom(deps)
    room.handleMessage(mover, { t: 'action', seq: 1, action: { kind: 'flip', pieceId: 'c00' } })
    const doc = room.toDoc()

    // Simulate a long outage: past both move and grace windows. The outage
    // is not the players' fault, so nobody is forfeited at load — but a full
    // grace period with no rejoin still ends the game.
    deps.clock.advance(TURN_MS + GRACE_MS + 60_000)
    const revived = Room.fromDoc(doc, deps)
    expect(revived.status).toBe('playing')
    deps.clock.advance(GRACE_MS + 1)
    revived.evaluate()
    expect(revived.status).toBe('finished')
    expect(revived.result?.reason).toBe('forfeit')
  })

  it('recovers gracefully after a short restart: clock pauses into grace', async () => {
    const deps = makeDeps()
    const { room, mover, current } = await seatedRoom(deps)
    room.handleMessage(mover, { t: 'action', seq: 1, action: { kind: 'flip', pieceId: 'c00' } })
    const doc = room.toDoc()

    deps.clock.advance(10_000) // brief redeploy
    const revived = Room.fromDoc(doc, deps)
    expect(revived.status).toBe('playing')

    // The next player rejoins and their clock resumes.
    const next = revived.state.currentPlayerIndex
    const token = next === current ? doc.seats[current]!.token : doc.seats[next]!.token
    const socket = new FakeSocket()
    revived.join(socket, token, undefined)
    const joined = socket.ofType('joined')[0]!
    expect(joined.deadline).not.toBeNull()
    expect(joined.deadline!.at - deps.clock.now()).toBeLessThanOrEqual(TURN_MS)
  })

  it('waiting rooms have no clock until the opponent joins', async () => {
    const deps = makeDeps()
    const room = await Room.create('testroom22', '甲', deps)
    const a = new FakeSocket()
    room.join(a, room.seats[0].token, undefined)
    expect(a.ofType('joined')[0]!.deadline).toBeNull()
    deps.clock.advance(TURN_MS * 10)
    room.evaluate()
    expect(room.status).toBe('waiting')
  })
})
