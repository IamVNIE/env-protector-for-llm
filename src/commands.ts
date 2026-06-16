import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Writable } from 'node:stream'
import { decryptValue, encryptValue, isEncryptedValue } from './crypto.js'
import { parseEnvPairs, transformEnvValues } from './envfile.js'
import { Keystore, keystoreDir } from './keystore.js'
import { isProtectable } from './redact.js'
import { runCommand } from './runner.js'

export interface CliIo {
  cwd?: string
  stdout?: Writable
  stderr?: Writable
  /** stdin mode passed to `run` children. */
  stdin?: 'inherit' | 'ignore'
}

interface Ctx {
  cwd: string
  stdout: Writable
  stderr: Writable
  stdin: 'inherit' | 'ignore'
}

const HELP = `envshield — encrypted .env with out-of-project keys + output redaction

Usage:
  envshield encrypt [-f <file>]            encrypt values (>= 5 chars) in place
  envshield decrypt [-f <file>] [--stdout] restore plaintext (key must exist locally)
  envshield run [-f <file>] -- <command>   run with decrypted env, secrets redacted in output
                                           chain via the shell: run -- "a && b" (quote the whole line)
  envshield keys list                      show known projects (never key material)
  envshield keys path                      show keystore location
  envshield --version | --help

Keys live in ${path.join('~', '.envshield', 'keystore.db')} (override dir with ENVSHIELD_HOME),
mapped to (project directory, env filename) — never inside the project.
Values shorter than 5 characters are not protected (not encrypted, not redacted).
`

function pkgVersion(): string {
  const require = createRequire(import.meta.url)
  return (require('../package.json') as { version: string }).version
}

function atomicWrite(filePath: string, content: string): void {
  const tmp = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, filePath)
}

function resolveEnvFile(ctx: Ctx, file: string | undefined): { filePath: string; dir: string; base: string } {
  const filePath = path.resolve(ctx.cwd, file ?? '.env')
  return { filePath, dir: path.dirname(filePath), base: path.basename(filePath) }
}

function readEnvFile(ctx: Ctx, filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    ctx.stderr.write(`error: env file not found: ${filePath}\n`)
    return undefined
  }
}

function noKeyError(ctx: Ctx, dir: string, base: string): number {
  ctx.stderr.write(
    `error: no key found for ${path.join(dir, base)}\n` +
      `Keys are bound to the directory where "envshield encrypt" ran.\n` +
      `Run from that project, or inspect known projects with: envshield keys list\n`,
  )
  return 1
}

function cmdEncrypt(ctx: Ctx, file: string | undefined): number {
  const { filePath, dir, base } = resolveEnvFile(ctx, file)
  const content = readEnvFile(ctx, filePath)
  if (content === undefined) return 1

  const keystore = new Keystore()
  try {
    const key = keystore.getOrCreateKey(dir, base)
    let encrypted = 0
    let skippedShort = 0
    const next = transformEnvValues(content, (_key, value) => {
      if (isEncryptedValue(value) || value.length === 0) return undefined
      if (!isProtectable(value)) {
        skippedShort++
        return undefined
      }
      encrypted++
      return encryptValue(value, key)
    })
    if (next !== content) atomicWrite(filePath, next)
    ctx.stdout.write(
      `encrypted ${encrypted} value(s) in ${base}` +
        (skippedShort ? ` (${skippedShort} left in plaintext: shorter than 5 chars)` : '') +
        `\nkey stored in ${keystore.dbPath} — keep it out of agent reach\n`,
    )
    return 0
  } finally {
    keystore.close()
  }
}

function cmdDecrypt(ctx: Ctx, file: string | undefined, toStdout: boolean): number {
  const { filePath, dir, base } = resolveEnvFile(ctx, file)
  const content = readEnvFile(ctx, filePath)
  if (content === undefined) return 1

  const keystore = new Keystore()
  try {
    const key = keystore.getKey(dir, base)
    if (!key) return noKeyError(ctx, dir, base)
    const next = transformEnvValues(content, (_key, value) =>
      isEncryptedValue(value) ? decryptValue(value, key) : undefined,
    )
    if (toStdout) {
      ctx.stdout.write(next)
    } else {
      atomicWrite(filePath, next)
      ctx.stdout.write(`decrypted ${base} in place — re-run "envshield encrypt" before letting agents near it\n`)
    }
    return 0
  } finally {
    keystore.close()
  }
}

async function cmdRun(ctx: Ctx, file: string | undefined, command: string[]): Promise<number> {
  if (command.length === 0) {
    ctx.stderr.write('usage: envshield run [-f <file>] -- <command> [args...]\n')
    return 1
  }
  const { filePath, dir, base } = resolveEnvFile(ctx, file)
  const content = readEnvFile(ctx, filePath)
  if (content === undefined) return 1

  const pairs = parseEnvPairs(content)
  const needsKey = pairs.some((p) => isEncryptedValue(p.value))
  let key: Buffer | undefined
  if (needsKey) {
    const keystore = new Keystore()
    try {
      key = keystore.getKey(dir, base)
    } finally {
      keystore.close()
    }
    if (!key) return noKeyError(ctx, dir, base)
  }

  const childEnv: NodeJS.ProcessEnv = { ...process.env }
  const secrets: string[] = []
  for (const { key: name, value } of pairs) {
    const plain = isEncryptedValue(value) ? decryptValue(value, key!) : value
    childEnv[name] = plain
    if (isProtectable(plain)) secrets.push(plain)
  }

  const [cmd, ...args] = command
  return runCommand(cmd!, args, {
    env: childEnv,
    secrets,
    stdout: ctx.stdout,
    stderr: ctx.stderr,
    cwd: ctx.cwd,
    stdin: ctx.stdin,
  })
}

function cmdKeys(ctx: Ctx, sub: string | undefined): number {
  if (sub === 'path') {
    ctx.stdout.write(`${keystoreDir()}\n`)
    return 0
  }
  if (sub === 'list') {
    const keystore = new Keystore()
    try {
      const entries = keystore.list()
      if (entries.length === 0) {
        ctx.stdout.write('no keys stored yet — run "envshield encrypt" in a project\n')
        return 0
      }
      for (const e of entries) {
        ctx.stdout.write(`${e.id.slice(0, 12)}  ${e.createdAt}  ${path.join(e.dir, e.file)}\n`)
      }
      return 0
    } finally {
      keystore.close()
    }
  }
  ctx.stderr.write('usage: envshield keys <list|path>\n')
  return 1
}

/** Pull `-f <file>` / `--file <file>` out of an argument list. */
function extractFileOption(args: string[]): { file: string | undefined; rest: string[] } {
  const rest: string[] = []
  let file: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-f' || args[i] === '--file') {
      file = args[++i]
    } else {
      rest.push(args[i]!)
    }
  }
  return { file, rest }
}

export async function cliMain(argv: string[], io: CliIo = {}): Promise<number> {
  const ctx: Ctx = {
    cwd: io.cwd ?? process.cwd(),
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    stdin: io.stdin ?? 'ignore',
  }
  const [command, ...rawArgs] = argv

  try {
    switch (command) {
      case undefined:
      case '--help':
      case '-h':
        ctx.stdout.write(HELP)
        return 0
      case '--version':
      case '-v':
        ctx.stdout.write(`${pkgVersion()}\n`)
        return 0
      case 'encrypt': {
        const { file } = extractFileOption(rawArgs)
        return cmdEncrypt(ctx, file)
      }
      case 'decrypt': {
        const { file, rest } = extractFileOption(rawArgs)
        return cmdDecrypt(ctx, file, rest.includes('--stdout'))
      }
      case 'run': {
        const sep = rawArgs.indexOf('--')
        const own = sep === -1 ? rawArgs : rawArgs.slice(0, sep)
        const child = sep === -1 ? [] : rawArgs.slice(sep + 1)
        const { file, rest } = extractFileOption(own)
        return await cmdRun(ctx, file, child.length > 0 ? child : rest)
      }
      case 'keys':
        return cmdKeys(ctx, rawArgs[0])
      default:
        ctx.stderr.write(`error: unknown command "${command}"\n\n${HELP}`)
        return 1
    }
  } catch (error) {
    ctx.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
