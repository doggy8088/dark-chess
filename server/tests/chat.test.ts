import { describe, expect, it } from 'vitest'
import { Room } from '../room'
import { CHAT_BURST, CHAT_MAX_LENGTH, CHAT_MIN_GAP_MS } from '../config'
import { CANNED_MESSAGES } from '../../src/shared/canned'
import { FakeSocket, makeDeps } from './server-test-utils'

async function seatedRoom(deps = makeDeps()) {
  const room = await Room.create('testroom22', '甲', deps)
  const a = new FakeSocket()
  const b = new FakeSocket()
  room.join(a, room.seats[0].token, undefined)
  room.join(b, undefined, '乙')
  return { room, a, b, deps }
}

describe('chat', () => {
  it('delivers text messages to both players', async () => {
    const { room, a, b } = await seatedRoom()
    room.handleMessage(a, { t: 'chat', text: '請多指教' })
    expect(a.ofType('chat')[0]!.msg.text).toBe('請多指教')
    expect(b.ofType('chat')[0]!.msg.from).toBe(0)
  })

  it('accepts every canned id and rejects unknown ones', async () => {
    const { room, a, b, deps } = await seatedRoom()
    let count = 0
    for (const canned of CANNED_MESSAGES) {
      deps.clock.advance(CHAT_MIN_GAP_MS + 3_000)
      room.handleMessage(a, { t: 'canned', id: canned.id })
      count++
      const delivered = b.ofType('chat')
      expect(delivered[count - 1]!.msg.text).toBe(canned.text)
      expect(delivered[count - 1]!.msg.kind).toBe('canned')
    }
    deps.clock.advance(CHAT_MIN_GAP_MS + 3_000)
    room.handleMessage(a, { t: 'canned', id: 'not-a-real-id' })
    expect(b.ofType('chat')).toHaveLength(CANNED_MESSAGES.length)
  })

  it('rate-limits bursts', async () => {
    const { room, a, deps } = await seatedRoom()
    for (let i = 0; i < CHAT_BURST; i++) {
      deps.clock.advance(CHAT_MIN_GAP_MS + 1)
      room.handleMessage(a, { t: 'chat', text: `msg${i}` })
    }
    deps.clock.advance(CHAT_MIN_GAP_MS + 1)
    room.handleMessage(a, { t: 'chat', text: 'too much' })
    expect(a.ofType('chat')).toHaveLength(CHAT_BURST)
    expect(a.ofType('error').some((e) => e.code === 'rate-limited')).toBe(true)
  })

  it('enforces a minimum gap between messages', async () => {
    const { room, a, deps } = await seatedRoom()
    deps.clock.advance(CHAT_MIN_GAP_MS + 1)
    room.handleMessage(a, { t: 'chat', text: '一' })
    deps.clock.advance(100) // way under the min gap
    room.handleMessage(a, { t: 'chat', text: '二' })
    expect(a.ofType('chat')).toHaveLength(1)
  })

  it('clamps length and strips control characters', async () => {
    const { room, a, deps } = await seatedRoom()
    deps.clock.advance(CHAT_MIN_GAP_MS + 1)
    const bell = String.fromCharCode(7)
    room.handleMessage(a, { t: 'chat', text: `${bell}哈${'囉'.repeat(300)}` })
    const msg = a.ofType('chat')[0]!.msg
    expect(msg.text.length).toBeLessThanOrEqual(CHAT_MAX_LENGTH)
    expect(msg.text.includes(bell)).toBe(false)
    expect(msg.text.startsWith('哈')).toBe(true)
  })

  it('replays the chat tail to a rejoining player', async () => {
    const { room, a, b, deps } = await seatedRoom()
    deps.clock.advance(CHAT_MIN_GAP_MS + 1)
    room.handleMessage(a, { t: 'chat', text: '你好' })
    room.disconnect(b)
    const b2 = new FakeSocket()
    room.join(b2, b.ofType('joined')[0]!.playerToken, undefined)
    const joined = b2.ofType('joined')[0]!
    expect(joined.chat.some((m) => m.text === '你好')).toBe(true)
  })
})
