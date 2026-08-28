import { createHmac, createPublicKey, createVerify, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Admin console auth: Google Identity Services ID-token sign-in + a signed
 * HMAC session cookie. No external auth dependency — the client obtains the
 * Google credential, the server verifies it against Google's public JWKS,
 * checks the admin allowlist, and issues an HttpOnly cookie.

 * Env:
 * - GOOGLE_CLIENT_ID: OAuth client id (audience) — required for login.
 * - ADMIN_EMAILS: comma-separated allowlist; defaults to doggy.huang@gmail.com.
 * - ADMIN_SESSION_SECRET: HMAC secret; a random per-boot secret by default
 *   (restarts sign everyone out, which is fine for a console this small).
 */

export const ADMIN_COOKIE = 'admin_session'
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000

export function adminEmailsFromEnv(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.ADMIN_EMAILS?.trim()
  const list = raw && raw.length > 0 ? raw.split(',') : ['doggy.huang@gmail.com']
  return new Set(list.map((email) => email.trim().toLowerCase()).filter((email) => email.length > 0))
}

export function isAdminEmail(email: string, allowed: Set<string>): boolean {
  return allowed.has(email.trim().toLowerCase())
}

// ------------------------------------------------------------- base64url

function b64urlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8')
}

function b64urlEncode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url')
}

// ------------------------------------------------------- Google ID token

interface Jwk {
  kid?: string
  kty?: string
  n?: string
  e?: string
}

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const jwksCache: { keys: Map<string, Jwk> | null; fetchedAt: number } = { keys: null, fetchedAt: 0 }
const JWKS_TTL_MS = 60 * 60 * 1000

async function fetchGoogleJwks(): Promise<Map<string, Jwk>> {
  if (jwksCache.keys && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys
  const res = await fetch(JWKS_URL)
  if (!res.ok) throw new Error(`jwks fetch failed: HTTP ${res.status}`)
  const body = (await res.json()) as { keys?: Jwk[] }
  const keys = new Map<string, Jwk>()
  for (const key of body.keys ?? []) {
    if (key.kid) keys.set(key.kid, key)
  }
  jwksCache.keys = keys
  jwksCache.fetchedAt = Date.now()
  return keys
}

export interface GoogleIdentity {
  email: string
  name: string
  sub: string
}

/** Verifies a Google ID token (RS256) and returns the identity, or null. */
export async function verifyGoogleIdToken(
  credential: string,
  clientId: string,
  deps: { fetchCerts?: () => Promise<Map<string, Jwk>>; now?: () => number } = {},
): Promise<GoogleIdentity | null> {
  const parts = credential.split('.')
  if (parts.length !== 3) return null
  const [header64, payload64, signature64] = parts
  if (!header64 || !payload64 || !signature64) return null
  let header: { alg?: string; kid?: string }
  let payload: Record<string, unknown>
  try {
    header = JSON.parse(b64urlDecode(header64)) as { alg?: string; kid?: string }
    payload = JSON.parse(b64urlDecode(payload64)) as Record<string, unknown>
  } catch {
    return null
  }
  if (header.alg !== 'RS256' || !header.kid) return null

  let jwk: Jwk | undefined
  try {
    const certs = await (deps.fetchCerts ?? fetchGoogleJwks)()
    jwk = certs.get(header.kid)
  } catch {
    return null
  }
  if (!jwk || jwk.kty !== 'RSA' || !jwk.n || !jwk.e) return null
  const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' })
  const signature = Buffer.from(signature64, 'base64url')
  const valid = createVerify('RSA-SHA256').update(`${header64}.${payload64}`).end()
  if (!valid.verify(key, signature)) return null

  const now = (deps.now ?? Date.now)()
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return null
  if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') return null
  if (payload.aud !== clientId) return null
  if (payload.email_verified !== true || typeof payload.email !== 'string') return null
  return {
    email: payload.email.toLowerCase(),
    name: typeof payload.name === 'string' ? payload.name : '',
    sub: typeof payload.sub === 'string' ? payload.sub : '',
  }
}

// --------------------------------------------------------- session token

export interface AdminSession {
  email: string
  exp: number
}

export function signAdminSession(email: string, secret: string, ttlMs = ADMIN_SESSION_TTL_MS, now = Date.now()): string {
  const body = b64urlEncode(JSON.stringify({ email: email.toLowerCase(), exp: now + ttlMs }))
  const mac = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${mac}`
}

export function verifyAdminSession(token: string, secret: string, now = Date.now()): AdminSession | null {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  const mac = token.slice(dot + 1)
  const expected = createHmac('sha256', secret).update(body).digest('base64url')
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(b64urlDecode(body)) as AdminSession
    if (typeof payload.email !== 'string' || typeof payload.exp !== 'number') return null
    if (payload.exp <= now) return null
    return payload
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- cookies

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {}
  if (!header) return cookies
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (name) cookies[name] = decodeURIComponent(value)
  }
  return cookies
}

export function adminCookieHeader(token: string, maxAgeSec = ADMIN_SESSION_TTL_MS / 1000): string {
  return `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`
}

export function clearAdminCookieHeader(): string {
  return `${ADMIN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

export function randomSecret(): string {
  return randomBytes(32).toString('hex')
}