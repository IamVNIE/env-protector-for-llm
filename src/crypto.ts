/**
 * AES-256-GCM value encryption. Token format:
 *   enc:gcm:<base64(iv[12] || ciphertext || authTag[16])>
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export const ENC_PREFIX = 'enc:gcm:'

const IV_LENGTH = 12
const TAG_LENGTH = 16

export function generateKey(): Buffer {
  return randomBytes(32)
}

export function isEncryptedValue(value: string): boolean {
  return value.startsWith(ENC_PREFIX)
}

export function encryptValue(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return ENC_PREFIX + Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64')
}

export function decryptValue(token: string, key: Buffer): string {
  if (!isEncryptedValue(token)) {
    throw new Error('value is not an envshield-encrypted token')
  }
  const body = Buffer.from(token.slice(ENC_PREFIX.length), 'base64')
  if (body.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('malformed encrypted token')
  }
  const iv = body.subarray(0, IV_LENGTH)
  const ciphertext = body.subarray(IV_LENGTH, body.length - TAG_LENGTH)
  const tag = body.subarray(body.length - TAG_LENGTH)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
