/** Per-room seat credential, kept so the same URL rejoins the same seat. */

export interface RoomCredential {
  token: string
  savedAt: number
}

const PREFIX = 'taiwan-dark-chess:online:'

export function loadRoomToken(roomId: string): string | null {
  try {
    const raw = localStorage.getItem(PREFIX + roomId)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<RoomCredential>
    return typeof parsed.token === 'string' ? parsed.token : null
  } catch {
    return null
  }
}

export function saveRoomToken(roomId: string, token: string): void {
  try {
    const credential: RoomCredential = { token, savedAt: Date.now() }
    localStorage.setItem(PREFIX + roomId, JSON.stringify(credential))
  } catch {
    // Private mode — reconnecting from the same tab still works via memory.
  }
}
