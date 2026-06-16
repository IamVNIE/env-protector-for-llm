import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cliMain } from '../src/commands.js'
import { Keystore } from '../src/keystore.js'

class MemWriter extends Writable {
  text = ''
  override _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
    this.text += chunk.toString()
    cb()
  }
}

const SECRET = 'sk-live-1234567890abcdef'
const ENV_CONTENT = [
  '# api credentials',
  `OPENAI_API_KEY=${SECRET}`,
  'DB_PASSWORD="hunter2-with spaces"',
  'PORT=8080',
  'DEBUG=1',
  '',
].join('\n')

let home: string
let proj: string
let out: MemWriter
let err: MemWriter

function cli(...argv: string[]): Promise<number> {
  return cliMain(argv, { cwd: proj, stdout: out, stderr: err })
}

const envPath = () => path.join(proj, '.env')
const readEnv = () => fs.readFileSync(envPath(), 'utf8')

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'envshield-home-'))
  proj = fs.mkdtempSync(path.join(os.tmpdir(), 'envshield-proj-'))
  process.env.ENVSHIELD_HOME = home
  fs.writeFileSync(envPath(), ENV_CONTENT)
  out = new MemWriter()
  err = new MemWriter()
})

afterEach(() => {
  delete process.env.ENVSHIELD_HOME
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(proj, { recursive: true, force: true })
})

describe('envshield encrypt', () => {
  it('encrypts values >= 5 chars, leaves short values and comments alone', async () => {
    expect(await cli('encrypt')).toBe(0)
    const content = readEnv()
    expect(content).toContain('# api credentials')
    expect(content).toMatch(/OPENAI_API_KEY=enc:gcm:/)
    expect(content).toMatch(/DB_PASSWORD="enc:gcm:/) // quote style preserved
    expect(content).toContain('PORT=8080')
    expect(content).toContain('DEBUG=1')
    expect(content).not.toContain(SECRET)
    expect(content).not.toContain('hunter2')
  })

  it('is idempotent and writes no plaintext key material into the project', async () => {
    await cli('encrypt')
    const once = readEnv()
    expect(await cli('encrypt')).toBe(0)
    expect(readEnv()).toBe(once)
    // nothing new in the project dir except .env (no .env.keys like dotenvx)
    expect(fs.readdirSync(proj)).toEqual(['.env'])
  })

  it('fails cleanly when the env file is missing', async () => {
    expect(await cli('encrypt', '-f', 'nope.env')).toBe(1)
    expect(err.text).toMatch(/not found|no such file/i)
  })
})

describe('envshield decrypt', () => {
  it('--stdout prints plaintext without touching the file', async () => {
    await cli('encrypt')
    const encrypted = readEnv()
    expect(await cli('decrypt', '--stdout')).toBe(0)
    expect(out.text).toContain(`OPENAI_API_KEY=${SECRET}`)
    expect(readEnv()).toBe(encrypted)
  })

  it('restores the original file when run without --stdout', async () => {
    await cli('encrypt')
    expect(await cli('decrypt')).toBe(0)
    expect(readEnv()).toBe(ENV_CONTENT)
  })

  it('fails with a helpful error when no key exists for this project', async () => {
    await cli('encrypt')
    const stolen = fs.mkdtempSync(path.join(os.tmpdir(), 'envshield-stolen-'))
    try {
      fs.copyFileSync(envPath(), path.join(stolen, '.env'))
      const code = await cliMain(['decrypt'], { cwd: stolen, stdout: out, stderr: err })
      expect(code).toBe(1)
      expect(err.text).toMatch(/no key/i)
    } finally {
      fs.rmSync(stolen, { recursive: true, force: true })
    }
  })
})

describe('envshield run', () => {
  it('decrypts in memory and redacts secrets printed by the child', async () => {
    await cli('encrypt')
    const code = await cli(
      'run',
      '--',
      process.execPath,
      '-e',
      'console.log("key=" + process.env.OPENAI_API_KEY); console.log("port=" + process.env.PORT)',
    )
    expect(code).toBe(0)
    expect(out.text).not.toContain(SECRET)
    expect(out.text).toContain('key=' + '*'.repeat(22) + 'ef') // 90% of 24 chars masked
    expect(out.text).toContain('port=8080') // <5 chars value not redacted
  })

  it('redacts stderr too', async () => {
    await cli('encrypt')
    await cli('run', '--', process.execPath, '-e', 'console.error(process.env.DB_PASSWORD)')
    expect(err.text).not.toContain('hunter2-with spaces')
    expect(err.text).toContain('*')
  })

  it('propagates the child exit code', async () => {
    await cli('encrypt')
    expect(await cli('run', '--', process.execPath, '-e', 'process.exit(3)')).toBe(3)
  })

  it('fails when encrypted values exist but the key is missing', async () => {
    await cli('encrypt')
    const stolen = fs.mkdtempSync(path.join(os.tmpdir(), 'envshield-stolen2-'))
    try {
      fs.copyFileSync(envPath(), path.join(stolen, '.env'))
      const code = await cliMain(['run', '--', process.execPath, '-e', '0'], {
        cwd: stolen,
        stdout: out,
        stderr: err,
      })
      expect(code).toBe(1)
      expect(err.text).toMatch(/no key/i)
    } finally {
      fs.rmSync(stolen, { recursive: true, force: true })
    }
  })

  it('errors when no command is given', async () => {
    expect(await cli('run')).toBe(1)
    expect(err.text).toMatch(/usage|command/i)
  })

  it('runs a quoted command line through the shell so && chains work', async () => {
    await cli('encrypt')
    const node = JSON.stringify(process.execPath)
    // First command succeeds (exit 0), so the second runs and sets the exit code.
    const code = await cli('run', '--', `${node} -e "process.exit(0)" && ${node} -e "process.exit(7)"`)
    expect(code).toBe(7)
  })

  it('short-circuits a quoted chain when the first command fails', async () => {
    await cli('encrypt')
    const node = JSON.stringify(process.execPath)
    const code = await cli('run', '--', `${node} -e "process.exit(4)" && ${node} -e "process.exit(0)"`)
    expect(code).toBe(4)
  })

  it.runIf(process.platform === 'win32')('runs .cmd/.bat shims that Node will not exec directly', async () => {
    await cli('encrypt')
    // A bare `.cmd` cannot be spawned with shell:false on modern Node (EINVAL).
    // Real shims (npm, npx, nodemon) live on PATH (npm prepends node_modules/.bin).
    fs.writeFileSync(path.join(proj, 'greet.cmd'), '@echo hello %1\r\n')
    const savedPath = process.env.PATH
    process.env.PATH = `${proj}${path.delimiter}${savedPath ?? ''}`
    try {
      const code = await cli('run', '--', 'greet', 'world')
      expect(code).toBe(0)
      expect(out.text).toContain('hello world')
    } finally {
      process.env.PATH = savedPath
    }
  })
})

describe('envshield keys', () => {
  it('keys list shows the project entry without key material', async () => {
    await cli('encrypt')
    expect(await cli('keys', 'list')).toBe(0)
    expect(out.text).toContain('.env')
    expect(out.text.toLowerCase()).toContain(path.basename(proj).toLowerCase())
    const ks = new Keystore()
    const key = ks.getOrCreateKey(proj, '.env')
    ks.close()
    expect(out.text).not.toContain(key.toString('base64'))
    expect(out.text).not.toContain(key.toString('hex'))
  })

  it('keys path prints the keystore location', async () => {
    expect(await cli('keys', 'path')).toBe(0)
    expect(out.text.trim()).toBe(home)
  })
})

describe('envshield misc', () => {
  it('--version prints a semver', async () => {
    expect(await cli('--version')).toBe(0)
    expect(out.text.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('unknown commands fail with help on stderr', async () => {
    expect(await cli('frobnicate')).toBe(1)
    expect(err.text).toMatch(/unknown command/i)
  })

  it('source fails with a clear explanation pointing to run --', async () => {
    expect(await cli('source', '.env')).toBe(1)
    expect(err.text).toMatch(/not supported/i)
    expect(err.text).toMatch(/shell builtin/i)
    expect(err.text).toContain('envshield run -- ')
    expect(err.text).not.toMatch(/unknown command/i) // not the generic fallthrough
  })
})
