// End-to-end encryption primitives. Built ONLY on the browser/Node WebCrypto API (no custom algorithms):
//   Device identity : ECDH P-256 key pair, private key generated NON-EXTRACTABLE
//   Key agreement   : ECDH -> HKDF-SHA256 (info binds sender+recipient device ids) -> AES-256-GCM wrap key
//   Message         : random AES-256-GCM key per message; AAD binds couple + client id + kind
//   Attachments     : random AES-256-GCM key per file (key travels inside the encrypted message)
// NOTE: no forward secrecy / ratcheting (not Signal). See docs/SECURITY.md.

const enc = new TextEncoder()
const dec = new TextDecoder()
const bs = (u: Uint8Array) => u as unknown as BufferSource

export function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
export function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

export interface PublicJwk { kty: 'EC'; crv: 'P-256'; x: string; y: string }
export interface WrapTarget { deviceId: string; publicJwk: PublicJwk }
export interface MessageContext { coupleId: string; clientId: string; kind: string }
export interface KeyEnvelope { device_id: string; wrapped_key: string; iv: string }
export interface EncryptedMessage { ciphertext: string; iv: string; keys: KeyEnvelope[] }

export async function generateDeviceKeys(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
}
export async function exportPublicJwk(pub: CryptoKey): Promise<PublicJwk> {
  const j = await crypto.subtle.exportKey('jwk', pub)
  return { kty: 'EC', crv: 'P-256', x: j.x as string, y: j.y as string }
}
export function importPublicJwk(j: PublicJwk): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', { ...j, ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, true, [])
}

async function deriveWrapKey(priv: CryptoKey, pub: CryptoKey, info: string): Promise<CryptoKey> {
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256)
  const hk = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(info) },
    hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  )
}
const wrapInfo = (senderDeviceId: string, targetDeviceId: string) => `2fold-v1-wrap|${senderDeviceId}|${targetDeviceId}`
const aadFor = (c: MessageContext) => enc.encode(`2fold-v1|${c.coupleId}|${c.clientId}|${c.kind}`)

export async function encryptMessage(
  payload: unknown, ctx: MessageContext,
  sender: { deviceId: string; privateKey: CryptoKey }, targets: WrapTarget[],
): Promise<EncryptedMessage> {
  const msgKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const aad = aadFor(ctx)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bs(iv), additionalData: bs(aad) }, msgKey, bs(enc.encode(JSON.stringify(payload))))
  const raw = await crypto.subtle.exportKey('raw', msgKey)
  const keys = await Promise.all(targets.map(async (t) => {
    const wk = await deriveWrapKey(sender.privateKey, await importPublicJwk(t.publicJwk), wrapInfo(sender.deviceId, t.deviceId))
    const wiv = crypto.getRandomValues(new Uint8Array(12))
    const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bs(wiv), additionalData: bs(aad) }, wk, raw)
    return { device_id: t.deviceId, wrapped_key: b64(wrapped), iv: b64(wiv) }
  }))
  return { ciphertext: b64(ct), iv: b64(iv), keys }
}

export async function decryptMessage<T = unknown>(
  row: { ciphertext: string; iv: string }, keyRow: { wrapped_key: string; iv: string }, ctx: MessageContext,
  senderDevice: { deviceId: string; publicJwk: PublicJwk }, me: { deviceId: string; privateKey: CryptoKey },
): Promise<T> {
  const aad = aadFor(ctx)
  const wk = await deriveWrapKey(me.privateKey, await importPublicJwk(senderDevice.publicJwk), wrapInfo(senderDevice.deviceId, me.deviceId))
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bs(unb64(keyRow.iv)), additionalData: bs(aad) }, wk, bs(unb64(keyRow.wrapped_key)))
  const msgKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt'])
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bs(unb64(row.iv)), additionalData: bs(aad) }, msgKey, bs(unb64(row.ciphertext)))
  return JSON.parse(dec.decode(pt)) as T
}

// ---- attachments: output = 12-byte IV || ciphertext ; key returned separately (base64)
export async function encryptBytes(data: Uint8Array): Promise<{ blob: Uint8Array; key: string }> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bs(iv) }, key, bs(data)))
  const blob = new Uint8Array(12 + ct.length)
  blob.set(iv, 0); blob.set(ct, 12)
  return { blob, key: b64(await crypto.subtle.exportKey('raw', key)) }
}
export async function decryptBytes(blob: Uint8Array, keyB64: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', bs(unb64(keyB64)), { name: 'AES-GCM' }, false, ['decrypt'])
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bs(blob.subarray(0, 12)) }, key, bs(blob.subarray(12))))
}

// ---- key verification ("safety number")
export async function thumbprint(j: PublicJwk): Promise<string> {
  const canon = `{"crv":"${j.crv}","kty":"${j.kty}","x":"${j.x}","y":"${j.y}"}`
  return b64(await crypto.subtle.digest('SHA-256', bs(enc.encode(canon))))
}
/** Same value on both phones if (and only if) both see the same set of active device keys. */
export async function safetyNumber(thumbprints: string[]): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bs(enc.encode([...thumbprints].sort().join('|')))))
  const groups: string[] = []
  for (let i = 0; i < 6; i++) {
    let n = 0
    for (const byte of h.subarray(i * 5, i * 5 + 5)) n = (n * 256 + byte) % 100000
    groups.push(String(n).padStart(5, '0'))
  }
  return groups.join(' ')
}
