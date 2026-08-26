import type { ClientSocket, RoomDeps } from '../room'
import type { ServerMessage } from '../../src/shared/protocol'
import { InMemoryStore } from '../store'

/** Records everything the server sends so tests can assert on it. */
export class FakeSocket implements ClientSocket {
  readonly sent: ServerMessage[] = []
  closed = false

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage)
  }

  close(): void {
    this.closed = true
  }

  last(): ServerMessage | undefined {
    return this.sent[this.sent.length - 1]
  }

  ofType<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.sent.filter((m) => m.t === t) as Extract<ServerMessage, { t: T }>[]
  }
}

export interface TestClock {
  now(): number
  advance(ms: number): void
}

export function makeClock(start = 1_000_000): TestClock {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

export function makeDeps(clock: TestClock = makeClock()): RoomDeps & { clock: TestClock; store: InMemoryStore } {
  const store = new InMemoryStore()
  return { store, now: () => clock.now(), clock }
}
