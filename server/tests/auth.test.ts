import { createSign, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  adminCookieHeader,
  adminEmailsFromEnv,
  clearAdminCookieHeader,
  isAdminEmail,
  parseCookies,
  signAdminSession,
  verifyAdminSession,
  verifyGoogleIdToken,
} from '../auth'

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url')
}

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; n: string; e: string }

async function jwkMap(): Promise<Map<string, { kty: string; n: string; e: string }>> {
  return new Map([['test-key', { kty: 'RSA', n: jwk.n, e: jwk.e }]])
}

function signCredential(payload: Record<string, unknown>, kid = 'test-key'): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', kid }))
  const body = b64url(JSON.stringify(payload))
  const signature = createSign('RSA-SHA256').update(`${header}.${body}`).sign(privateKey)
  return `${header}.${body}.${signature.toString('base64url')}`
}

describe('admin allowlist', () => {
  it('defaults to doggy.huang@gmail.com', () => {
    const emails = adminEmailsFromEnv({})
    expect(emails.has('doggy.huang@gmail.com')).toBe(true)
    expect(isAdminEmail('Doggy.Huang@Gmail.com', emails)).toBe(true)
    expect(isAdminEmail('someone@else.com', emails)).toBe(false)
  })

  it('parses the ADMIN_EMAILS list and de-duplicates case', () => {
    const emails = adminEmailsFromEnv({ ADMIN_EMAILS: 'a@x.com, B@Y.com ,b@y.com' })
    expect(emails.has('a@x.com')).toBe(true)
    expect(emails.has('b@y.com')).toBe(true)
    expect(emails.size).toBe(2)
  })
})

describe('admin session token', () => {
  it('round-trips and rejects tampering and expiry', () => {
    const token = signAdminSession('doggy.huang@gmail.com', 'secret', 60_000, 1_000_000)
    expect(verifyAdminSession(token, 'secret', 1_000_500)?.email).toBe('doggy.huang@gmail.com')
    expect(verifyAdminSession(token, 'secret', 1_061_000)).toBeNull()
    expect(verifyAdminSession(token, 'other-secret', 1_000_000)).toBeNull()
    const [body, mac] = token.split('.')
    expect(verifyAdminSession(`${body!.slice(0, -2)}xx.${mac}`, 'secret', 1_000_000)).toBeNull()
    expect(verifyAdminSession('garbage', 'secret')).toBeNull()
  })

  it('renders and clears the cookie header', () => {
    expect(adminCookieHeader('t', 120)).toBe('admin_session=t; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=120')
    expect(clearAdminCookieHeader()).toContain('Max-Age=0')
  })

  it('parses cookie headers', () => {
    expect(parseCookies('a=1; admin_session=%2Fabc; c=3')['admin_session']).toBe('/abc')
    expect(parseCookies(undefined)).toEqual({})
  })
})

describe('Google ID token verification', () => {
  const now = 1_700_000_000_000
  const nowSec = now / 1000
  const base = { iss: 'accounts.google.com', email: 'doggy.huang@gmail.com', email_verified: true, sub: '12345' }

  it('accepts a valid token with matching audience and verified email', async () => {
    const credential = signCredential({ ...base, aud: 'client-123', exp: nowSec + 600, name: '保哥' })
    const identity = await verifyGoogleIdToken(credential, 'client-123', { fetchCerts: jwkMap, now: () => now })
    expect(identity?.email).toBe('doggy.huang@gmail.com')
    expect(identity?.name).toBe('保哥')
    expect(identity?.sub).toBe('12345')
  })

  it('rejects wrong audience', async () => {
    const credential = signCredential({ ...base, aud: 'other-client', exp: nowSec + 600 })
    expect(await verifyGoogleIdToken(credential, 'client-123', { fetchCerts: jwkMap, now: () => now })).toBeNull()
  })

  it('rejects expired tokens', async () => {
    const credential = signCredential({ ...base, aud: 'client-123', exp: nowSec - 10 })
    expect(await verifyGoogleIdToken(credential, 'client-123', { fetchCerts: jwkMap, now: () => now })).toBeNull()
  })

  it('rejects unverified emails', async () => {
    const credential = signCredential({ ...base, aud: 'client-123', exp: nowSec + 600, email_verified: false })
    expect(await verifyGoogleIdToken(credential, 'client-123', { fetchCerts: jwkMap, now: () => now })).toBeNull()
  })

  it('rejects unknown key ids and foreign signatures', async () => {
    const credential = signCredential({ ...base, aud: 'client-123', exp: nowSec + 600 }, 'unknown-kid')
    expect(await verifyGoogleIdToken(credential, 'client-123', { fetchCerts: jwkMap, now: () => now })).toBeNull()

    const foreign = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const header = b64url(JSON.stringify({ alg: 'RS256', kid: 'test-key' }))
    const body = b64url(JSON.stringify({ ...base, aud: 'client-123', exp: nowSec + 600 }))
    const signature = createSign('RSA-SHA256').update(`${header}.${body}`).sign(foreign.privateKey)
    const forged = `${header}.${body}.${signature.toString('base64url')}`
    expect(await verifyGoogleIdToken(forged, 'client-123', { fetchCerts: jwkMap, now: () => now })).toBeNull()
  })

  it('rejects malformed input', async () => {
    expect(await verifyGoogleIdToken('not-a-jwt', 'client-123', { fetchCerts: jwkMap, now: () => now })).toBeNull()
  })
})