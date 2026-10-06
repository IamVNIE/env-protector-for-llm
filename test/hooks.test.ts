import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cliMain } from '../src/commands.js'
import { handleHook } from '../src/hooks.js'
import { maskSecret } from '../src/redact.js'

class MemWriter extends Writable {
  text = ''
  override _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
    this.text += chunk.toString()
    cb()
  }
}

const SECRET = 'sk-live-1234567890abcdef'
const MASKED = maskSecret(SECRET)

describe('handleHook adapters', () => {
  it('claude: replaces any tool output via updatedToolOutput', () => {
    const r = handleHook(
      'claude',
      { tool_name: 'Bash', tool_response: { stdout: `key=${SECRET}`, stderr: '', interrupted: false } },
      [SECRET],
    )
    const out = JSON.parse(r.stdout!)
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse')
    expect(out.hookSpecificOutput.updatedToolOutput).toEqual({ stdout: `key=${MASKED}`, stderr: '', interrupted: false })
    expect(r.stdout).not.toContain(SECRET)
  })

  it('leaves output untouched (no stdout) when nothing matches or there are no secrets', () => {
    expect(handleHook('claude', { tool_response: { stdout: 'clean' } }, [SECRET]).stdout).toBeUndefined()
    expect(handleHook('claude', { tool_response: { stdout: SECRET } }, []).stdout).toBeUndefined()
  })

  it('codex: blocks the raw output and hands the model the redacted text', () => {
    const r = handleHook('codex', { tool_response: `token ${SECRET}` }, [SECRET])
    const out = JSON.parse(r.stdout!)
    expect(out.decision).toBe('block')
    expect(out.reason).toContain(`token ${MASKED}`)
    expect(out.reason).not.toContain(SECRET)
  })

  it('gemini: denies with redacted llmContent text', () => {
    const r = handleHook(
      'gemini',
      { tool_response: { llmContent: [{ text: `a ${SECRET}` }, { text: 'b' }], returnDisplay: SECRET } },
      [SECRET],
    )
    const out = JSON.parse(r.stdout!)
    expect(out.decision).toBe('deny')
    expect(out.reason).toContain(`a ${MASKED}\nb`)
    expect(out.reason).not.toContain(SECRET)
  })

  it('cursor: denies reading files that contain secrets, allows others', () => {
    const deny = JSON.parse(
      handleHook('cursor', { hook_event_name: 'beforeReadFile', content: `X=${SECRET}` }, [SECRET]).stdout!,
    )
    expect(deny.permission).toBe('deny')
    const allow = JSON.parse(handleHook('cursor', { hook_event_name: 'beforeReadFile', content: 'X=1' }, [SECRET]).stdout!)
    expect(allow.permission).toBe('allow')
  })

  it('cursor: rewrites MCP tool output (a JSON string)', () => {
    const r = handleHook(
      'cursor',
      { hook_event_name: 'postToolUse', tool_output: JSON.stringify({ result: SECRET }) },
      [SECRET],
    )
    expect(JSON.parse(r.stdout!)).toEqual({ updated_mcp_tool_output: { result: MASKED } })
  })

  it('pi/opencode/generic: returns the redacted payload', () => {
    const payload = { content: [{ type: 'text', text: SECRET }, { type: 'image', data: 'xyz' }] }
    const out = JSON.parse(handleHook('pi', { cwd: '/x', payload }, [SECRET]).stdout!)
    expect(out.payload.content[0].text).toBe(MASKED)
    expect(out.payload.content[1]).toEqual({ type: 'image', data: 'xyz' })
  })
})

describe('envshield hook / hooks (CLI)', () => {
  let home: string
  let agentHome: string
  let proj: string
  let out: MemWriter
  let err: MemWriter

  const cli = (argv: string[], input?: string) =>
    cliMain(argv, { cwd: proj, stdout: out, stderr: err, input, home: agentHome })

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'envshield-home-'))
    agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'envshield-agents-'))
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'envshield-proj-'))
    process.env.ENVSHIELD_HOME = home
    fs.writeFileSync(path.join(proj, '.env'), `OPENAI_API_KEY=${SECRET}\nPORT=8080\n`)
    out = new MemWriter()
    err = new MemWriter()
  })

  afterEach(() => {
    delete process.env.ENVSHIELD_HOME
    for (const d of [home, agentHome, proj]) fs.rmSync(d, { recursive: true, force: true })
  })

  it('redacts secrets of the encrypted project, also from a subdirectory', async () => {
    await cli(['encrypt'])
    out.text = ''
    const sub = path.join(proj, 'packages', 'api')
    fs.mkdirSync(sub, { recursive: true })
    const payload = { cwd: sub, tool_name: 'Read', tool_response: { content: `1\tOPENAI_API_KEY=${SECRET}` } }
    expect(await cli(['hook', 'claude'], JSON.stringify(payload))).toBe(0)
    expect(out.text).not.toContain(SECRET)
    expect(out.text).toContain(MASKED)
  })

  it('ignores other projects and malformed input (fails open)', async () => {
    await cli(['encrypt'])
    out.text = ''
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'envshield-other-'))
    try {
      const payload = { cwd: elsewhere, tool_response: { stdout: SECRET } }
      expect(await cli(['hook', 'claude'], JSON.stringify(payload))).toBe(0)
      expect(out.text).toBe('')
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true })
    }
    expect(await cli(['hook', 'claude'], 'not json')).toBe(0)
    expect(out.text).toBe('')
  })

  it('does not create a keystore when none exists', async () => {
    expect(await cli(['hook', 'claude'], JSON.stringify({ cwd: proj, tool_response: SECRET }))).toBe(0)
    expect(fs.existsSync(path.join(home, 'keystore.db'))).toBe(false)
  })

  it('install merges into existing settings, is idempotent, and uninstall restores them', async () => {
    const settings = path.join(agentHome, '.claude', 'settings.json')
    fs.mkdirSync(path.dirname(settings), { recursive: true })
    const original = {
      model: 'opus',
      hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'prettier' }] }] },
    }
    fs.writeFileSync(settings, JSON.stringify(original))

    expect(await cli(['hooks', 'install', 'claude'])).toBe(0)
    expect(await cli(['hooks', 'install', 'claude'])).toBe(0)
    const installed = JSON.parse(fs.readFileSync(settings, 'utf8'))
    expect(installed.model).toBe('opus')
    expect(installed.hooks.PostToolUse).toHaveLength(2)
    expect(installed.hooks.PostToolUse[1].hooks[0].command).toBe('envshield hook claude')

    out.text = ''
    await cli(['hooks', 'status'])
    expect(out.text).toMatch(/claude\s+installed/)

    expect(await cli(['hooks', 'uninstall', 'claude'])).toBe(0)
    expect(JSON.parse(fs.readFileSync(settings, 'utf8'))).toEqual(original)
  })

  it('install with no arguments targets detected agents only', async () => {
    fs.mkdirSync(path.join(agentHome, '.codex'))
    fs.mkdirSync(path.join(agentHome, '.pi', 'agent'), { recursive: true })
    expect(await cli(['hooks', 'install'])).toBe(0)

    const codex = JSON.parse(fs.readFileSync(path.join(agentHome, '.codex', 'hooks.json'), 'utf8'))
    expect(codex.hooks.PostToolUse[0].hooks[0].command).toBe('envshield hook codex')
    const piExt = path.join(agentHome, '.pi', 'agent', 'extensions', 'envshield.js')
    expect(fs.readFileSync(piExt, 'utf8')).toContain("pi.on('tool_result'")
    expect(fs.existsSync(path.join(agentHome, '.claude'))).toBe(false)

    expect(await cli(['hooks', 'uninstall'])).toBe(0)
    expect(fs.existsSync(piExt)).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(agentHome, '.codex', 'hooks.json'), 'utf8'))).toEqual({})
  })

  it('installs Gemini and Cursor hooks in their own formats', async () => {
    expect(await cli(['hooks', 'install', 'gemini', 'cursor'])).toBe(0)
    const gemini = JSON.parse(fs.readFileSync(path.join(agentHome, '.gemini', 'settings.json'), 'utf8'))
    expect(gemini.hooks.AfterTool[0].hooks[0]).toMatchObject({ command: 'envshield hook gemini', timeout: 30000 })
    const cursor = JSON.parse(fs.readFileSync(path.join(agentHome, '.cursor', 'hooks.json'), 'utf8'))
    expect(cursor.version).toBe(1)
    expect(cursor.hooks.beforeReadFile[0].command).toBe('envshield hook cursor')
    expect(cursor.hooks.postToolUse[0].matcher).toBe('MCP:.*')
  })

  it('refuses to overwrite a config it cannot parse', async () => {
    const settings = path.join(agentHome, '.gemini', 'settings.json')
    fs.mkdirSync(path.dirname(settings), { recursive: true })
    fs.writeFileSync(settings, '{ // comment\n "a": 1 }')
    expect(await cli(['hooks', 'install', 'gemini'])).toBe(1)
    expect(err.text).toMatch(/cannot parse/)
    expect(fs.readFileSync(settings, 'utf8')).toBe('{ // comment\n "a": 1 }')
  })

  it('rejects unknown agents', async () => {
    expect(await cli(['hooks', 'install', 'notepad'])).toBe(1)
    expect(err.text).toMatch(/unknown agent/)
  })
})
