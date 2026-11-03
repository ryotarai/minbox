// This browser's key for pairing with a minbox server reached over the
// network. ECDSA P-256 from WebCrypto; the private key is not extractable and
// stays in IndexedDB. Over plain http:// (another machine's address) browsers
// withhold WebCrypto, so there the key is made and used by @noble/curves; its
// private key then sits in IndexedDB as bytes.
import { p256 } from '@noble/curves/nist.js'
import { sha256 } from '@noble/hashes/sha2.js'

const DB = 'minbox'
const STORE = 'keys'
const KEY_ID = 'device'

type Stored = { privateKey?: CryptoKey; secret?: Uint8Array; publicKey: string; fingerprint: string }

/** DER prefix of a P-256 SubjectPublicKeyInfo, before the 65-byte point. */
const SPKI_P256 = Uint8Array.from(atob('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgA='), (c) => c.charCodeAt(0))

function webcrypto(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle
}

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function get(): Promise<Stored | undefined> {
  const db = await idb()
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(KEY_ID)
    req.onsuccess = () => resolve(req.result as Stored | undefined)
    req.onerror = () => reject(req.error)
  })
}

async function put(v: Stored): Promise<void> {
  const db = await idb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(v, KEY_ID)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

function b64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
}

function unb64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

/** "SHA256:…" of the public key (base64, no padding), like ssh-keygen -l. */
async function fingerprintOf(spki: ArrayBuffer): Promise<string> {
  const d = sha256(new Uint8Array(spki))
  return `SHA256:${b64(d.buffer as ArrayBuffer).replace(/=+$/, '')}`
}

export function cryptoAvailable(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function' && typeof indexedDB !== 'undefined'
}

/** This browser's key, made on first use. */
export async function deviceKey(): Promise<{ publicKey: string; fingerprint: string }> {
  const have = await get()
  if (have) return { publicKey: have.publicKey, fingerprint: have.fingerprint }
  let v: Stored
  if (webcrypto()) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
    const spki = await crypto.subtle.exportKey('spki', pair.publicKey)
    v = { privateKey: pair.privateKey, publicKey: b64(spki), fingerprint: await fingerprintOf(spki) }
  } else {
    const secret = p256.utils.randomSecretKey()
    const point = p256.getPublicKey(secret, false)
    const spki = new Uint8Array(SPKI_P256.length + point.length)
    spki.set(SPKI_P256)
    spki.set(point, SPKI_P256.length)
    v = { secret, publicKey: b64(spki.buffer), fingerprint: await fingerprintOf(spki.buffer) }
  }
  await put(v)
  return { publicKey: v.publicKey, fingerprint: v.fingerprint }
}

export async function hasDeviceKey(): Promise<boolean> {
  return !!(await get().catch(() => undefined))
}

/** Signs the server's challenge (ECDSA P-256, SHA-256, IEEE P1363). */
export async function signChallenge(challenge: string): Promise<string> {
  const k = await get()
  if (!k) throw new Error('this browser has no key yet')
  if (k.privateKey) {
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.privateKey, unb64(challenge))
    return b64(sig)
  }
  // r||s (64 bytes) over SHA-256 of the challenge, as WebCrypto signs.
  const sig = p256.sign(unb64(challenge), k.secret!)
  return b64(new Uint8Array(sig).buffer)
}

/** A name for this browser: "Chrome on iPhone". */
export function deviceName(): string {
  const ua = navigator.userAgent
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'this device'
  return `${browser} on ${os}`
}

/** Signs in with the stored key: challenge → signature → cookie. True when accepted. */
export async function authenticate(): Promise<boolean> {
  const k = await get().catch(() => undefined)
  if (!k) return false
  const ch = await fetch('/api/devices/auth/challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fingerprint: k.fingerprint }),
  })
  if (!ch.ok) return false
  const { challenge } = (await ch.json()) as { challenge: string }
  const res = await fetch('/api/devices/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fingerprint: k.fingerprint, challenge, signature: await signChallenge(challenge) }),
  })
  return res.ok
}
