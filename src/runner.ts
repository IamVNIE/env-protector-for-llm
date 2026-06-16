/**
 * Spawns a child process with decrypted env vars and pipes its stdout/stderr
 * through StreamRedactor so protected values never reach the terminal.
 */
import { spawn, type SpawnOptions } from 'node:child_process'
import type { Writable } from 'node:stream'
import { StreamRedactor } from './redact.js'

export interface RunOptions {
  env: NodeJS.ProcessEnv
  secrets: readonly string[]
  stdout: Writable
  stderr: Writable
  cwd?: string
  /** 'inherit' for interactive CLI use; tests default to 'ignore'. */
  stdin?: 'inherit' | 'ignore'
}

const isWindows = process.platform === 'win32'

function hasExtension(command: string): boolean {
  return /\.[A-Za-z0-9]+$/.test(command)
}

/** On Windows these are batch shims (npm, npx, nodemon, ...) that Node won't exec without a shell. */
function isWindowsShim(command: string): boolean {
  return /\.(cmd|bat)$/i.test(command)
}

/**
 * Quote one argument for a cmd.exe command line used with windowsVerbatimArguments.
 * Node does not quote args itself under shell semantics, so we do it: wrap anything
 * with whitespace or cmd metacharacters in double quotes and double any embedded quote.
 */
function cmdQuote(arg: string): string {
  if (arg.length > 0 && !/[\s"^&|<>()%!]/.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

/**
 * Run a command with decrypted env, redacting secrets from its output.
 *
 * Three dispatch cases:
 *  - No discrete args (`command` is a whole line) → run through the shell. This lets users
 *    chain with the shell — `envshield run -- "migrate && docker compose up"` — and lets a
 *    bare `.cmd`/`.bat` resolve via PATHEXT on Windows.
 *  - Windows + bare name or `.cmd`/`.bat` → route through cmd.exe. Node refuses to spawn
 *    batch files with shell:false (EINVAL, CVE-2024-27980), and a bare name needs PATHEXT.
 *  - Otherwise (POSIX, or an explicit `.exe`) → spawn directly with exact args.
 */
export function runCommand(command: string, args: string[], opts: RunOptions): Promise<number> {
  if (args.length === 0) {
    return spawnRedacted(command, [], { shell: true }, opts)
  }

  if (isWindows && (isWindowsShim(command) || !hasExtension(command))) {
    const comspec = process.env.ComSpec || 'cmd.exe'
    const line = [command, ...args].map(cmdQuote).join(' ')
    return spawnRedacted(comspec, ['/d', '/s', '/c', line], { windowsVerbatimArguments: true }, opts)
  }

  return spawnRedacted(command, args, {}, opts)
}

function spawnRedacted(file: string, spawnArgs: string[], extra: SpawnOptions, opts: RunOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, spawnArgs, {
      env: opts.env,
      cwd: opts.cwd,
      stdio: [opts.stdin ?? 'ignore', 'pipe', 'pipe'],
      shell: false,
      ...extra,
    })

    const outRedactor = new StreamRedactor(opts.secrets)
    const errRedactor = new StreamRedactor(opts.secrets)

    child.stdout!.setEncoding('utf8')
    child.stderr!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => opts.stdout.write(outRedactor.process(chunk)))
    child.stderr!.on('data', (chunk: string) => opts.stderr.write(errRedactor.process(chunk)))

    child.on('error', (error: NodeJS.ErrnoException) => reject(error))

    child.on('close', (code, signal) => {
      opts.stdout.write(outRedactor.flush())
      opts.stderr.write(errRedactor.flush())
      resolve(code ?? (signal ? 1 : 0))
    })
  })
}
