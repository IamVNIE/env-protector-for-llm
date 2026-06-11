/**
 * Per-user keystore at ~/.envshield/keystore.db (SQLite via node:sqlite).
 * Maps (absolute project dir, env filename) -> 256-bit AES key, so key
 * material never lives inside the project an LLM agent works in.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite'
import { generateKey } from './crypto.js'

// Loaded via process.getBuiltinModule (runtime-only, Node >= 22.3) instead of a
// static import: esbuild rewrites `node:sqlite` to bare `sqlite`, which breaks
// the published bundle. The type-only import above is erased at compile time.
// Lazy so commands that never touch the keystore don't load sqlite at all.
let DatabaseSync: (typeof import('node:sqlite'))['DatabaseSync'] | undefined
function getDatabaseSync(): (typeof import('node:sqlite'))['DatabaseSync'] {
  DatabaseSync ??= (process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite'))
    .DatabaseSync
  return DatabaseSync
}

export function keystoreDir(): string {
  return process.env.ENVSHIELD_HOME ?? path.join(os.homedir(), '.envshield')
}

/**
 * Canonical project-dir spelling: absolute, normalized separators, no trailing
 * separator, lowercased on case-insensitive filesystems (Windows, macOS) so
 * `F:\Proj`, `f:/proj/` and `f:\proj` all map to the same key.
 */
export function normalizeProjectDir(dir: string): string {
  let p = path.normalize(path.resolve(dir))
  if (p.length > 1 && p.endsWith(path.sep) && !/^[A-Za-z]:\\$/.test(p)) {
    p = p.slice(0, -1)
  }
  if (process.platform === 'win32' || process.platform === 'darwin') {
    p = p.toLowerCase()
  }
  return p
}

export function keyId(dir: string, file: string): string {
  return createHash('sha256').update(`${normalizeProjectDir(dir)}|${file}`).digest('hex')
}

export interface KeystoreEntry {
  id: string
  dir: string
  file: string
  createdAt: string
}

function hardenPermissions(homeDir: string, dbPath: string): void {
  if (process.platform === 'win32') {
    // Owner-only ACL, strip inheritance. Best effort: unsupported filesystems
    // (FAT/exFAT) or restricted shells must not break the tool.
    try {
      const user = os.userInfo().username
      spawnSync('icacls', [homeDir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], {
        stdio: 'ignore',
        timeout: 10_000,
      })
    } catch {
      /* best effort */
    }
  } else {
    fs.chmodSync(homeDir, 0o700)
    if (fs.existsSync(dbPath)) fs.chmodSync(dbPath, 0o600)
  }
}

export class Keystore {
  readonly dbPath: string
  private readonly db: DatabaseSyncT

  constructor(homeDir: string = keystoreDir()) {
    fs.mkdirSync(homeDir, { recursive: true })
    this.dbPath = path.join(homeDir, 'keystore.db')
    this.db = new (getDatabaseSync())(this.dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS keys (
        id         TEXT PRIMARY KEY,
        dir        TEXT NOT NULL,
        file       TEXT NOT NULL,
        key        BLOB NOT NULL,
        created_at TEXT NOT NULL
      )
    `)
    hardenPermissions(homeDir, this.dbPath)
  }

  getKey(dir: string, file: string): Buffer | undefined {
    const row = this.db.prepare('SELECT key FROM keys WHERE id = ?').get(keyId(dir, file)) as
      | { key: Uint8Array }
      | undefined
    return row ? Buffer.from(row.key) : undefined
  }

  getOrCreateKey(dir: string, file: string): Buffer {
    const existing = this.getKey(dir, file)
    if (existing) return existing
    const key = generateKey()
    this.db
      .prepare('INSERT INTO keys (id, dir, file, key, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(keyId(dir, file), normalizeProjectDir(dir), file, key, new Date().toISOString())
    return key
  }

  list(): KeystoreEntry[] {
    const rows = this.db
      .prepare('SELECT id, dir, file, created_at FROM keys ORDER BY created_at')
      .all() as Array<{ id: string; dir: string; file: string; created_at: string }>
    return rows.map((r) => ({ id: r.id, dir: r.dir, file: r.file, createdAt: r.created_at }))
  }

  close(): void {
    this.db.close()
  }
}
