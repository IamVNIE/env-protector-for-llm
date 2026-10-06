/**
 * Post-tool-call hooks for LLM coding agents. Every tool result an agent
 * receives is passed through `envshield hook <agent>`, which masks protected
 * .env values before the model sees them — even if the agent `cat`s a decrypted
 * file, reads a log the app wrote, or calls an MCP tool that echoes a key.
 *
 * Each agent exposes a different (and differently capable) hook API, so each
 * gets an adapter that turns "here is the redacted payload" into the response
 * format that agent understands.
 */
import fs from 'node:fs'
import path from 'node:path'
import { redactDeep } from './secrets.js'

export const AGENTS = ['claude', 'codex', 'gemini', 'cursor', 'pi', 'opencode'] as const
export type Agent = (typeof AGENTS)[number]

export function isAgent(name: string): name is Agent {
  return (AGENTS as readonly string[]).includes(name)
}

/** Marks every config entry envshield owns, so install is idempotent and uninstall is surgical. */
const HOOK_MARKER = 'envshield hook'

const REDACTED_NOTE =
  'envshield: this tool call completed, but its output contained protected secret values, ' +
  'which have been masked. This is the real output with secrets redacted — do not retry ' +
  'to get the unmasked values.'

type Json = Record<string, unknown>

export interface HookResult {
  /** JSON (or text) to write to stdout; undefined writes nothing (= leave the output unchanged). */
  stdout?: string
  exitCode: number
}

const pass: HookResult = { exitCode: 0 }

function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

/** Gemini's llmContent is a string, a Part, or Part[]; keep only the text the model would read. */
function geminiText(content: unknown): string {
  if (typeof content === 'string') return content
  const parts = Array.isArray(content) ? content : [content]
  return parts
    .map((p) => (p && typeof p === 'object' && typeof (p as Json).text === 'string' ? (p as Json).text : asText(p)))
    .join('\n')
}

/** The project directory a hook payload refers to. */
export function payloadCwd(input: Json): string {
  if (typeof input.cwd === 'string' && input.cwd) return input.cwd
  const roots = input.workspace_roots
  if (Array.isArray(roots) && typeof roots[0] === 'string') return roots[0]
  return process.cwd()
}

/**
 * Handle one hook invocation. `secrets` are the protected values for the
 * payload's project (see collectSecrets). Pure apart from its arguments, so
 * adapters are testable without touching the keystore.
 */
export function handleHook(agent: Agent | 'generic', input: Json, secrets: readonly string[]): HookResult {
  if (secrets.length === 0) return pass

  switch (agent) {
    case 'claude': {
      // PostToolUse: updatedToolOutput replaces the result of any tool, built-in or MCP.
      const response = input.tool_response
      const redacted = redactDeep(response, secrets)
      if (redacted === response) return pass
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: redacted },
        }),
      }
    }

    case 'codex': {
      // PostToolUse can't edit output, but decision:"block" swaps it for `reason`.
      const response = input.tool_response
      const redacted = redactDeep(response, secrets)
      if (redacted === response) return pass
      return {
        exitCode: 0,
        stdout: JSON.stringify({ decision: 'block', reason: `${REDACTED_NOTE}\n\n${asText(redacted)}` }),
      }
    }

    case 'gemini': {
      // AfterTool decision:"deny" replaces llmContent with "Tool result blocked: <reason>".
      const response = (input.tool_response ?? {}) as Json
      const content = response.llmContent
      const redacted = redactDeep(content, secrets)
      if (redacted === content) return pass
      return {
        exitCode: 0,
        stdout: JSON.stringify({ decision: 'deny', reason: `${REDACTED_NOTE}\n\n${geminiText(redacted)}` }),
      }
    }

    case 'cursor': {
      if (input.hook_event_name === 'beforeReadFile') {
        // Read results can't be rewritten in Cursor, so refuse files that hold secrets.
        const content = input.content
        if (typeof content !== 'string' || redactDeep(content, secrets) === content) {
          return { exitCode: 0, stdout: JSON.stringify({ permission: 'allow' }) }
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            permission: 'deny',
            user_message: 'envshield blocked reading a file that contains protected secret values.',
            agent_message:
              'envshield: this file contains protected secret values and cannot be read. ' +
              'Run commands that need the secrets via `envshield run -- <cmd>`.',
          }),
        }
      }
      // postToolUse: only MCP output is replaceable; tool_output arrives as a JSON string.
      const raw = input.tool_output
      if (typeof raw !== 'string') return pass
      let parsed: unknown = raw
      try {
        parsed = JSON.parse(raw)
      } catch {
        /* plain text output */
      }
      const redacted = redactDeep(parsed, secrets)
      if (redacted === parsed) return pass
      return { exitCode: 0, stdout: JSON.stringify({ updated_mcp_tool_output: redacted }) }
    }

    case 'pi':
    case 'opencode':
    case 'generic': {
      // In-process plugins send {cwd, payload} and get back {payload} only when it changed.
      const payload = input.payload
      const redacted = redactDeep(payload, secrets)
      if (redacted === payload) return pass
      return { exitCode: 0, stdout: JSON.stringify({ payload: redacted }) }
    }
  }
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

export interface AgentPaths {
  home: string
  env?: NodeJS.ProcessEnv
}

function configFile(agent: Agent, { home, env = process.env }: AgentPaths): string {
  switch (agent) {
    case 'claude':
      return path.join(home, '.claude', 'settings.json')
    case 'codex':
      return path.join(env.CODEX_HOME ?? path.join(home, '.codex'), 'hooks.json')
    case 'gemini':
      return path.join(home, '.gemini', 'settings.json')
    case 'cursor':
      return path.join(home, '.cursor', 'hooks.json')
    case 'pi':
      return path.join(env.PI_CODING_AGENT_DIR ?? path.join(home, '.pi', 'agent'), 'extensions', 'envshield.js')
    case 'opencode':
      return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'opencode', 'plugins', 'envshield.js')
  }
}

/** The agent's own config directory — its presence means the agent is installed. */
function agentDir(agent: Agent, paths: AgentPaths): string {
  const file = configFile(agent, paths)
  return agent === 'pi' || agent === 'opencode' ? path.dirname(path.dirname(file)) : path.dirname(file)
}

export function detectAgents(paths: AgentPaths): Agent[] {
  return AGENTS.filter((a) => fs.existsSync(agentDir(a, paths)))
}

function readJson(file: string): Json {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  if (!text.trim()) return {}
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Json
  } catch {
    /* fall through */
  }
  // Never clobber a config we can't parse (e.g. JSON with comments).
  throw new Error(`cannot parse ${file} as a JSON object — edit it by hand or fix it first`)
}

function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.envshield-backup`)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, file)
}

interface MatcherGroup {
  matcher?: string
  hooks?: Array<{ command?: string } & Json>
}

function isOurs(hook: { command?: unknown }): boolean {
  return typeof hook.command === 'string' && hook.command.startsWith(HOOK_MARKER)
}

/** Remove our entries from a Claude/Codex/Gemini style `hooks[event]` list. */
function withoutOurGroups(groups: unknown): MatcherGroup[] {
  if (!Array.isArray(groups)) return []
  return (groups as MatcherGroup[])
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
    .filter((g) => g.hooks.length > 0)
}

function setGroups(config: Json, event: string, groups: MatcherGroup[]): void {
  const hooks = (config.hooks && typeof config.hooks === 'object' ? config.hooks : {}) as Json
  if (groups.length > 0) hooks[event] = groups
  else delete hooks[event]
  if (Object.keys(hooks).length > 0) config.hooks = hooks
  else delete config.hooks
}

const EVENT: Record<'claude' | 'codex' | 'gemini', string> = {
  claude: 'PostToolUse',
  codex: 'PostToolUse',
  gemini: 'AfterTool',
}

function matcherHook(agent: 'claude' | 'codex' | 'gemini'): MatcherGroup {
  const command = `${HOOK_MARKER} ${agent}`
  switch (agent) {
    case 'claude':
      return { matcher: '*', hooks: [{ type: 'command', command, timeout: 30 }] }
    case 'codex':
      return { matcher: '.*', hooks: [{ type: 'command', command, timeout: 30, statusMessage: 'envshield: redacting secrets' }] }
    case 'gemini':
      return { matcher: '.*', hooks: [{ name: 'envshield', type: 'command', command, timeout: 30_000 }] }
  }
}

/**
 * pi and OpenCode take in-process JS plugins. They shell out to the same
 * `envshield hook` entry point (constant args, so the Windows shell is safe),
 * keeping secrets out of the agent process entirely. Failures pass the
 * original output through: a broken hook must not break the agent.
 */
const PLUGIN_HELPER = `import { spawn } from 'node:child_process'

/** Ask envshield to mask protected .env values in \`payload\`; resolves undefined if nothing changed. */
function envshieldRedact(agent, cwd, payload) {
  return new Promise((resolve) => {
    let out = ''
    let child
    try {
      child = spawn('envshield', ['hook', agent], { shell: process.platform === 'win32', windowsHide: true })
    } catch {
      return resolve(undefined)
    }
    child.on('error', () => resolve(undefined))
    child.stdout.on('data', (d) => (out += d))
    child.on('close', (code) => {
      if (code !== 0 || !out.trim()) return resolve(undefined)
      try {
        resolve(JSON.parse(out).payload)
      } catch {
        resolve(undefined)
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ cwd, payload }))
  })
}
`

const PI_EXTENSION = `// ${HOOK_MARKER} pi — installed by \`envshield hooks install\`; remove with \`envshield hooks uninstall pi\`.
// Masks protected .env values in every tool result before the model sees it.
${PLUGIN_HELPER}
export default function (pi) {
  pi.on('tool_result', async (event, ctx) => {
    const redacted = await envshieldRedact('pi', ctx.cwd, {
      content: event.content,
      structuredContent: event.structuredContent,
    })
    if (!redacted) return
    const result = { content: redacted.content }
    if (redacted.structuredContent !== undefined) result.structuredContent = redacted.structuredContent
    return result
  })
}
`

const OPENCODE_PLUGIN = `// ${HOOK_MARKER} opencode — installed by \`envshield hooks install\`; remove with \`envshield hooks uninstall opencode\`.
// Masks protected .env values in every tool result before the model sees it.
${PLUGIN_HELPER}
export const EnvShield = async ({ directory }) => ({
  'tool.execute.after': async (input, output) => {
    const redacted = await envshieldRedact('opencode', directory, {
      output: output.output,
      metadata: output.metadata,
    })
    if (!redacted) return
    output.output = redacted.output
    output.metadata = redacted.metadata
  },
})
`

export type InstallState = 'installed' | 'not installed'

export function hookStatus(agent: Agent, paths: AgentPaths): InstallState {
  const file = configFile(agent, paths)
  if (agent === 'pi' || agent === 'opencode') {
    return fs.existsSync(file) ? 'installed' : 'not installed'
  }
  let config: Json
  try {
    config = readJson(file)
  } catch {
    return 'not installed'
  }
  const text = JSON.stringify(config.hooks ?? {})
  return text.includes(`${HOOK_MARKER} ${agent}`) ? 'installed' : 'not installed'
}

/** Install (idempotently) the envshield hook for one agent; returns the file written. */
export function installHook(agent: Agent, paths: AgentPaths): string {
  const file = configFile(agent, paths)
  switch (agent) {
    case 'pi':
      writeFileAtomic(file, PI_EXTENSION)
      return file
    case 'opencode':
      writeFileAtomic(file, OPENCODE_PLUGIN)
      return file
    case 'cursor': {
      const config = readJson(file)
      config.version ??= 1
      for (const [event, entry] of [
        ['postToolUse', { command: `${HOOK_MARKER} cursor`, matcher: 'MCP:.*', timeout: 30 }],
        ['beforeReadFile', { command: `${HOOK_MARKER} cursor`, timeout: 30 }],
      ] as const) {
        const hooks = (config.hooks && typeof config.hooks === 'object' ? config.hooks : {}) as Json
        const list = Array.isArray(hooks[event]) ? (hooks[event] as Json[]).filter((h) => !isOurs(h)) : []
        hooks[event] = [...list, entry]
        config.hooks = hooks
      }
      writeFileAtomic(file, `${JSON.stringify(config, null, 2)}\n`)
      return file
    }
    default: {
      const config = readJson(file)
      const event = EVENT[agent]
      const groups = withoutOurGroups((config.hooks as Json | undefined)?.[event])
      setGroups(config, event, [...groups, matcherHook(agent)])
      writeFileAtomic(file, `${JSON.stringify(config, null, 2)}\n`)
      return file
    }
  }
}

/** Remove the envshield hook for one agent, leaving every other setting intact. */
export function uninstallHook(agent: Agent, paths: AgentPaths): boolean {
  const file = configFile(agent, paths)
  if (agent === 'pi' || agent === 'opencode') {
    if (!fs.existsSync(file)) return false
    fs.rmSync(file)
    return true
  }
  if (hookStatus(agent, paths) !== 'installed') return false
  const config = readJson(file)
  const hooks = (config.hooks ?? {}) as Json
  if (agent === 'cursor') {
    for (const [event, list] of Object.entries(hooks)) {
      if (!Array.isArray(list)) continue
      const kept = (list as Json[]).filter((h) => !isOurs(h))
      if (kept.length > 0) hooks[event] = kept
      else delete hooks[event]
    }
    config.hooks = hooks
  } else {
    setGroups(config, EVENT[agent], withoutOurGroups(hooks[EVENT[agent]]))
  }
  writeFileAtomic(file, `${JSON.stringify(config, null, 2)}\n`)
  return true
}

export function agentConfigFile(agent: Agent, paths: AgentPaths): string {
  return configFile(agent, paths)
}
