/**
 * Secret discovery for agent hooks: given the directory an agent is working in,
 * find every protected value it could stumble on, so tool output can be redacted
 * before the model sees it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { decryptValue, isEncryptedValue } from './crypto.js'
import { parseEnvPairs } from './envfile.js'
import { Keystore, keystoreDir, normalizeProjectDir } from './keystore.js'
import { isProtectable, redactText } from './redact.js'

function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Plaintext of every protectable value in every keystore-registered env file
 * whose project is `cwd`, an ancestor of it (agent cd'd into a subdir), or a
 * descendant of it (monorepo with nested .env files). Unreadable files and
 * undecryptable values are skipped: a hook must never crash the agent.
 */
export function collectSecrets(cwd: string): string[] {
  // Hooks fire on every tool call: don't create a keystore just to find it empty.
  if (!fs.existsSync(path.join(keystoreDir(), 'keystore.db'))) return []
  const here = normalizeProjectDir(cwd)
  const secrets = new Set<string>()
  const keystore = new Keystore()
  try {
    for (const entry of keystore.list()) {
      if (!isWithin(here, entry.dir) && !isWithin(entry.dir, here)) continue
      let content: string
      try {
        content = fs.readFileSync(path.join(entry.dir, entry.file), 'utf8')
      } catch {
        continue
      }
      const key = keystore.getKey(entry.dir, entry.file)
      for (const { value } of parseEnvPairs(content)) {
        let plain = value
        if (isEncryptedValue(value)) {
          if (!key) continue
          try {
            plain = decryptValue(value, key)
          } catch {
            continue
          }
        }
        if (isProtectable(plain)) secrets.add(plain)
      }
    }
  } finally {
    keystore.close()
  }
  return [...secrets]
}

/**
 * Redact secrets in every string inside a JSON-like value (tool results come
 * as strings, arrays of content blocks, or nested objects depending on agent).
 * Returns the same reference when nothing changed.
 */
export function redactDeep<T>(value: T, secrets: readonly string[]): T {
  if (secrets.length === 0) return value
  if (typeof value === 'string') return redactText(value, secrets) as T
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((v) => {
      const r = redactDeep(v, secrets)
      if (r !== v) changed = true
      return r
    })
    return (changed ? out : value) as T
  }
  if (value !== null && typeof value === 'object') {
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      const r = redactDeep(v, secrets)
      if (r !== v) changed = true
      out[k] = r
    }
    return (changed ? out : value) as T
  }
  return value
}
