import { randomBytes } from 'node:crypto'

/** Unambiguous lowercase base32 (no 0/1/o/l lookalikes). */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

/** Unguessable 10-char room id — the invite URL is the only credential. */
export function newRoomId(): string {
  const bytes = randomBytes(10)
  let id = ''
  for (const b of bytes) id += ALPHABET[b % ALPHABET.length]
  return id
}

export function isRoomId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z2-9]{10}$/.test(value)
}

/** Per-seat secret used to reclaim a seat after disconnecting. */
export function newPlayerToken(): string {
  return randomBytes(16).toString('hex')
}

export function newChatId(): string {
  return randomBytes(6).toString('hex')
}
