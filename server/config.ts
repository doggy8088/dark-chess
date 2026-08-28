export const PORT = Number(process.env.PORT ?? 8787)

/** Per-move thinking time. Running out loses the game. */
export const TURN_MS = Number(process.env.TURN_MS ?? 60_000)

/** When a seat is abandoned (disconnect/timeout), spectators get this long to take over. */
export const TAKEOVER_WINDOW_MS = 5 * 60 * 1000

/** How long a disconnected player (whose move it is) may take to rejoin. */
export const GRACE_MS = Number(process.env.GRACE_MS ?? 90_000)

/** Firestore persistence. Disable for local dev / tests (in-memory store). */
export const FIRESTORE_ENABLED = process.env.FIRESTORE_ENABLED !== '0'

/** Finished rooms expire this long after the game ends. */
export const FINISHED_ROOM_TTL_MS = 24 * 60 * 60 * 1000

/** Ended games linger on the home live board this long after the game ends. */
export const LOBBY_ENDED_RETENTION_MS = 5 * 60 * 1000

/** Unfinished rooms expire this long after their last update. */
export const IDLE_ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Chat rate limit: at most this many messages per window, per seat. */
export const CHAT_BURST = 5
export const CHAT_WINDOW_MS = 10_000
export const CHAT_MIN_GAP_MS = 600
export const CHAT_MAX_LENGTH = 120
export const CHAT_TAIL_LENGTH = 50
