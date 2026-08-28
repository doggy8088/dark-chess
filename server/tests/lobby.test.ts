import { describe, expect, it } from 'vitest'
import { RoomManager } from '../rooms'
import { FakeSocket, makeDeps } from './server-test-utils'

async function startGame(manager: RoomManager) {
  const room = await manager.create('房主')
  const a = new FakeSocket()
  room.join(a, room.seats[0].token, undefined)
  const b = new FakeSocket()
  room.join(b, undefined, '對手')
  return { room, a, b }
}

describe('live games board', () => {
  it('orders rooms by creation time and never reorders while games progress', async () => {
    const deps = makeDeps()
    const manager = new RoomManager(deps.store, deps.now)
    const first = await startGame(manager)
    deps.clock.advance(1_000)
    const second = await startGame(manager)

    const before = (await manager.listGames()).map((g) => g.roomId)
    expect(before).toEqual([second.room.roomId, first.room.roomId])

    // Activity in the older room must not shuffle the board.
    first.room.handleMessage(first.a, { t: 'chat', text: '活動一下' })
    deps.clock.advance(30_000)
    const after = (await manager.listGames()).map((g) => g.roomId)
    expect(after).toEqual(before)
  })

  it('keeps a finished game on the board for 5 minutes, then drops it', async () => {
    const deps = makeDeps()
    const manager = new RoomManager(deps.store, deps.now)
    const { room, b } = await startGame(manager)

    room.handleMessage(b, { t: 'resign' })
    expect(room.status).toBe('finished')

    // Just inside the linger window: still listed, marked as finished.
    deps.clock.advance(4 * 60_000 + 59_000)
    const games = await manager.listGames()
    const row = games.find((g) => g.roomId === room.roomId)
    expect(row?.status).toBe('finished')
    expect(row?.players[1].name).toBe('對手')

    // Past the window the row leaves the board.
    deps.clock.advance(2_000)
    const gone = await manager.listGames()
    expect(gone.some((g) => g.roomId === room.roomId)).toBe(false)
  })

  it('exposes a waiting room on the board after 30 seconds so visitors can join', async () => {
    const deps = makeDeps()
    const manager = new RoomManager(deps.store, deps.now)
    const waiting = await manager.create('獨守空房')

    // 前 30 秒不曝光。
    deps.clock.advance(29_000)
    expect((await manager.listGames()).some((g) => g.roomId === waiting.roomId)).toBe(false)

    // 30 秒後出現在戰情中心，狀態為 waiting。
    deps.clock.advance(2_000)
    const row = (await manager.listGames()).find((g) => g.roomId === waiting.roomId)
    expect(row?.status).toBe('waiting')
    expect(row?.players[0].name).toBe('獨守空房')

    // 對手加入後變成 playing，正常列為交戰中。
    const joiner = new FakeSocket()
    waiting.join(joiner, undefined, '挑戰者')
    const after = (await manager.listGames()).find((g) => g.roomId === waiting.roomId)
    expect(after?.status).toBe('playing')
  })
})