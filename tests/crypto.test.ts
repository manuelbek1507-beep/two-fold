import test from 'node:test'
import assert from 'node:assert/strict'
import {
  generateDeviceKeys, exportPublicJwk, encryptMessage, decryptMessage, encryptBytes, decryptBytes,
  thumbprint, safetyNumber,
} from '../src/lib/crypto.ts'

async function device(id: string) {
  const kp = await generateDeviceKeys()
  return { deviceId: id, privateKey: kp.privateKey, publicJwk: await exportPublicJwk(kp.publicKey) }
}
const ctx = { coupleId: 'c1', clientId: 'm1', kind: 'text' }

test('round trip: recipient and sender devices can both decrypt', async () => {
  const a = await device('A'), b = await device('B')
  const targets = [a, b].map((d) => ({ deviceId: d.deviceId, publicJwk: d.publicJwk }))
  const enc = await encryptMessage({ text: 'hello 💕' }, ctx, a, targets)
  const forB = enc.keys.find((k) => k.device_id === 'B')!
  const forA = enc.keys.find((k) => k.device_id === 'A')!
  assert.deepEqual(await decryptMessage(enc, forB, ctx, a, b), { text: 'hello 💕' })
  assert.deepEqual(await decryptMessage(enc, forA, ctx, a, a), { text: 'hello 💕' })
  assert.ok(!enc.ciphertext.includes('hello'))
})

test('a third device cannot decrypt', async () => {
  const a = await device('A'), b = await device('B'), eve = await device('E')
  const enc = await encryptMessage({ text: 'secret' }, ctx, a, [{ deviceId: 'B', publicJwk: b.publicJwk }])
  await assert.rejects(decryptMessage(enc, enc.keys[0], ctx, a, eve))
})

test('tampering with ciphertext or context is detected (AES-GCM + AAD)', async () => {
  const a = await device('A'), b = await device('B')
  const enc = await encryptMessage({ text: 'x' }, ctx, a, [{ deviceId: 'B', publicJwk: b.publicJwk }])
  const flipped = { ...enc, ciphertext: (enc.ciphertext[0] === 'A' ? 'B' : 'A') + enc.ciphertext.slice(1) }
  await assert.rejects(decryptMessage(flipped, enc.keys[0], ctx, a, b))
  await assert.rejects(decryptMessage(enc, enc.keys[0], { ...ctx, clientId: 'other' }, a, b))   // replay under another id
  await assert.rejects(decryptMessage(enc, enc.keys[0], { ...ctx, coupleId: 'c2' }, a, b))
})

test('private keys are non-extractable', async () => {
  const kp = await generateDeviceKeys()
  await assert.rejects(crypto.subtle.exportKey('jwk', kp.privateKey))
})

test('each message uses a fresh key and IV', async () => {
  const a = await device('A'), b = await device('B')
  const t = [{ deviceId: 'B', publicJwk: b.publicJwk }]
  const e1 = await encryptMessage({ t: 1 }, ctx, a, t), e2 = await encryptMessage({ t: 1 }, ctx, a, t)
  assert.notEqual(e1.iv, e2.iv)
  assert.notEqual(e1.ciphertext, e2.ciphertext)
  assert.notEqual(e1.keys[0].wrapped_key, e2.keys[0].wrapped_key)
})

test('attachment encryption round trip and tamper detection', async () => {
  const data = new Uint8Array(100_000)
  for (let i = 0; i < data.length; i += 65536) crypto.getRandomValues(data.subarray(i, i + 65536))
  const { blob, key } = await encryptBytes(data)
  assert.deepEqual(await decryptBytes(blob, key), data)
  blob[50] ^= 1
  await assert.rejects(decryptBytes(blob, key))
})

test('safety number is order-independent and key-sensitive', async () => {
  const a = await device('A'), b = await device('B'), c = await device('C')
  const [ta, tb, tc] = await Promise.all([a, b, c].map((d) => thumbprint(d.publicJwk)))
  assert.equal(await safetyNumber([ta, tb]), await safetyNumber([tb, ta]))
  assert.notEqual(await safetyNumber([ta, tb]), await safetyNumber([ta, tc]))
  assert.match(await safetyNumber([ta, tb]), /^\d{5}( \d{5}){5}$/)
})
