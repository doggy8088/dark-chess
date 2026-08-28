import { describe, expect, it } from 'vitest'
import { Room } from '../room'
import { FakeSocket, makeDeps } from './server-test-utils'

function otherSeat(seat: 0 | 1): 0 | 1 {
  return seat === 0 ? 1 : 0
}

async function seatedRoomWithSpectator() {
  const deps = makeDeps()
  const room = await Room.create('testroom22', '甲', deps)
  const a = new FakeSocket()
  const b = new FakeSocket()
  room.join(a, room.seats[0].token, undefined)
  room.join(b, undefined, '乙')
  const watcher = new FakeSocket()
  room.join(watcher, undefined, '觀眾丙', true)
  return { deps, room, a, b, watcher }
}

function currentSeat(room: Room): 0 | 1 {
  return room.state.currentPlayerIndex
}

describe('spectator takeover', () => {
  it('opens a takeover window instead of forfeiting when a disconnected player exceeds grace', async () => {
    const { deps, room, a, b, watcher } = await seatedRoomWithSpectator()
    const seat = currentSeat(room)
    const leaver = seat === 0 ? a : b
    const remaining = seat === 0 ? b : a
    room.disconnect(leaver)

    deps.clock.advance(91_000)
    room.evaluate()

    // No game over — the seat is open for takeover instead.
    expect(room.status).toBe('playing')
    expect(room.result).toBeNull()
    expect(remaining.ofType('takeoverOpen').length).toBeGreaterThan(0)
    expect(watcher.ofType('takeoverOpen').length).toBeGreaterThan(0)
    const presence = remaining.ofType('presence').at(-1)!
    expect(presence.presence.seats[seat].awaitingTakeover).toBe(true)
  })

  it('lets a spectator claim the seat and keeps the game going', async () => {
    const { deps, room, a, b, watcher } = await seatedRoomWithSpectator()
    const seat = currentSeat(room)
    const leaver = seat === 0 ? a : b
    const remaining = seat === 0 ? b : a
    room.disconnect(leaver)
    deps.clock.advance(91_000)
    room.evaluate()

    room.handleMessage(watcher, { t: 'takeoverSeat' })

    const joined = watcher.ofType('joined').at(-1)!
    expect(joined.seat).toBe(seat)
    expect(joined.playerToken).toBeTruthy()
    expect(joined.roomStatus).toBe('playing')
    expect(room.seats[seat]?.name).toBe('觀眾丙')
    expect(room.spectatorCount).toBe(0)
    expect(room.state.currentPlayerIndex).toBe(seat)
    // A fresh turn clock is running for the replacement.
    expect(joined.deadline?.at).toBeGreaterThan(deps.clock.now())
    // The player who stayed is told the takeover closed.
    expect(remaining.ofType('takeoverClosed').at(-1)?.seat).toBe(seat)
  })

  it('finishes by forfeit when the takeover window expires with no takers', async () => {
    const { deps, room, a, b, watcher } = await seatedRoomWithSpectator()
    const seat = currentSeat(room)
    room.disconnect(seat === 0 ? a : b)
    deps.clock.advance(91_000)
    room.evaluate()
    expect(room.status).toBe('playing')

    deps.clock.advance(5 * 60_000 + 1_000)
    room.evaluate()

    expect(room.status).toBe('finished')
    expect(room.result?.reason).toBe('forfeit')
    expect(room.result?.winnerIndex).toBe(otherSeat(seat))
    const gameOver = watcher.ofType('gameOver').at(-1)!
    expect(gameOver.winnerIndex).toBe(otherSeat(seat))
  })

  it('releases a timed-out player seat and invalidates the old token', async () => {
    const { deps, room, a, b, watcher } = await seatedRoomWithSpectator()
    const seat = currentSeat(room)
    const stallersToken = room.seats[seat]!.token
    const staller = seat === 0 ? a : b

    // The player stays connected but lets the move clock run out.
    deps.clock.advance(61_000)
    room.evaluate()

    // Seat released for takeover; the staller is demoted to the audience.
    expect(room.status).toBe('playing')
    expect(room.result).toBeNull()
    expect(staller.sent.some((m) => m.t === 'takeoverOpen')).toBe(true)
    expect(watcher.sent.some((m) => m.t === 'takeoverOpen')).toBe(true)
    expect(room.spectatorCount).toBe(2) // 原玩家 + 觀眾

    // The old token can no longer reclaim the seat.
    const rejoin = new FakeSocket()
    room.join(rejoin, stallersToken, undefined)
    expect(rejoin.ofType('joined')[0]!.seat).toBe('spectator')

    // The spectator can take the seat over and keep playing.
    room.handleMessage(watcher, { t: 'takeoverSeat' })
    expect(watcher.ofType('joined').at(-1)!.seat).toBe(seat)
  })

  it('still forfeits immediately when no spectator is connected', async () => {
    const deps = makeDeps()
    const room = await Room.create('testroom22', '甲', deps)
    const a = new FakeSocket()
    const b = new FakeSocket()
    room.join(a, room.seats[0].token, undefined)
    room.join(b, undefined, '乙')
    const seat = currentSeat(room)
    room.disconnect(seat === 0 ? a : b)

    deps.clock.advance(91_000)
    room.evaluate()

    expect(room.status).toBe('finished')
    expect(room.result?.reason).toBe('forfeit')
  })

  it('round-trips an open takeover window through the store', async () => {
    const { deps, room, a } = await seatedRoomWithSpectator()
    room.disconnect(a)
    deps.clock.advance(91_000)
    room.evaluate()
    expect(room.toDoc().takeover?.seat).toBe(currentSeat(room))

    const revived = Room.fromDoc(room.toDoc(), deps)
    expect(revived.toDoc().takeover?.seat).toBe(currentSeat(room))
    expect(revived.status).toBe('playing')
  })
})