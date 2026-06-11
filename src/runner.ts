/**
 * Spawns a child process with decrypted env vars and pipes its stdout/stderr
 * through StreamRedactor so protected values never reach the terminal.
 */
import { spawn } from 'node:child_process'
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

/** On Windows, bare command names often resolve to .cmd/.bat shims (npm, npx, ...). */
function commandCandidates(command: string): string[] {
  if (process.platform !== 'win32' || path_hasExtension(command)) return [command]
  return [command, `${command}.cmd`, `${command}.bat`, `${command}.exe`]
}

function path_hasExtension(command: string): boolean {
  return /\.[A-Za-z0-9]+$/.test(command)
}

export function runCommand(command: string, args: string[], opts: RunOptions): Promise<number> {
  const candidates = commandCandidates(command)

  const attempt = (index: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const child = spawn(candidates[index]!, args, {
        env: opts.env,
        cwd: opts.cwd,
        stdio: [opts.stdin ?? 'ignore', 'pipe', 'pipe'],
        shell: false,
      })

      const outRedactor = new StreamRedactor(opts.secrets)
      const errRedactor = new StreamRedactor(opts.secrets)

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => opts.stdout.write(outRedactor.process(chunk)))
      child.stderr.on('data', (chunk: string) => opts.stderr.write(errRedactor.process(chunk)))

      child.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' && index + 1 < candidates.length) {
          resolve(attempt(index + 1))
        } else {
          reject(error)
        }
      })

      child.on('close', (code, signal) => {
        opts.stdout.write(outRedactor.flush())
        opts.stderr.write(errRedactor.flush())
        resolve(code ?? (signal ? 1 : 0))
      })
    })

  return attempt(0)
}
