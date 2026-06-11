import { describe, expect, it } from 'vitest'
import {
  ENC_PREFIX,
  decryptValue,
  encryptValue,
  generateKey,
  isEncryptedValue,
} from '../src/crypto.js'

describe('crypto', () => {
  it('generates 32-byte (AES-256) keys', () => {
    const key = generateKey()
    expect(key).toHaveLength(32)
    expect(generateKey().equals(key)).toBe(false)
  })

  it('roundtrips values including unicode and special chars', () => {
    const key = generateKey()
    for (const v of ['sk-live-abc123', 'p@ss=word#with"quotes\'', 'héllo wörld 🔑', 'x'.repeat(5000)]) {
      const token = encryptValue(v, key)
      expect(token.startsWith(ENC_PREFIX)).toBe(true)
      expect(token).not.toContain(v)
      expect(decryptValue(token, key)).toBe(v)
    }
  })

  it('produces a different token each time (random IV)', () => {
    const key = generateKey()
    expect(encryptValue('same-input', key)).not.toBe(encryptValue('same-input', key))
  })

  it('rejects decryption with the wrong key', () => {
    const token = encryptValue('secret-value', generateKey())
    expect(() => decryptValue(token, generateKey())).toThrow()
  })

  it('rejects tampered ciphertext (GCM auth tag)', () => {
    const key = generateKey()
    const token = encryptValue('secret-value', key)
    const body = Buffer.from(token.slice(ENC_PREFIX.length), 'base64')
    body[14] = body[14]! ^ 0xff // flip a ciphertext byte
    expect(() => decryptValue(ENC_PREFIX + body.toString('base64'), key)).toThrow()
  })

  it('rejects malformed tokens', () => {
    const key = generateKey()
    expect(() => decryptValue('enc:gcm:!!!', key)).toThrow()
    expect(() => decryptValue('plaintext', key)).toThrow()
  })

  it('identifies encrypted values', () => {
    expect(isEncryptedValue(encryptValue('abc', generateKey()))).toBe(true)
    expect(isEncryptedValue('sk-live-abc')).toBe(false)
  })
})
