/**
 * Minimal .env reader/rewriter. Rewrites only the lines whose values change,
 * preserving comments, blank lines, unknown lines, ordering, and line endings.
 */

const PAIR_RE = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/

export interface EnvPair {
  key: string
  value: string
}

interface ParsedLine {
  raw: string
  pair?: EnvPair & { exportPrefix: boolean; quote: string }
}

function unquoteValue(rawValue: string): { value: string; quote: string } {
  const trimmed = rawValue.trim()
  for (const q of ['"', "'"]) {
    if (trimmed.length >= 2 && trimmed.startsWith(q) && trimmed.endsWith(q)) {
      return { value: trimmed.slice(1, -1), quote: q }
    }
  }
  // unquoted: strip inline comments (a # preceded by whitespace)
  const hash = trimmed.search(/\s#/)
  return { value: hash === -1 ? trimmed : trimmed.slice(0, hash).trim(), quote: '' }
}

function parseLine(raw: string): ParsedLine {
  if (raw.trimStart().startsWith('#')) return { raw }
  const m = PAIR_RE.exec(raw)
  if (!m) return { raw }
  const { value, quote } = unquoteValue(m[4]!)
  return {
    raw,
    pair: { key: m[3]!, value, quote, exportPrefix: m[2] !== undefined },
  }
}

export function parseEnvPairs(content: string): EnvPair[] {
  return content
    .split(/\r?\n/)
    .map(parseLine)
    .filter((l) => l.pair !== undefined)
    .map((l) => ({ key: l.pair!.key, value: l.pair!.value }))
}

/**
 * Rewrite pair values via `fn(key, value)`. Returning `undefined` keeps the
 * original line byte-for-byte; returning a string replaces the line with
 * `KEY=<newValue>`, keeping any `export ` prefix and the original quote style
 * so encrypt -> decrypt restores the file byte-for-byte.
 */
export function transformEnvValues(
  content: string,
  fn: (key: string, value: string) => string | undefined,
): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  return content
    .split(/\r?\n/)
    .map((raw) => {
      const { pair } = parseLine(raw)
      if (!pair) return raw
      const next = fn(pair.key, pair.value)
      if (next === undefined) return raw
      const q = next.includes(pair.quote) ? '' : pair.quote
      return `${pair.exportPrefix ? 'export ' : ''}${pair.key}=${q}${next}${q}`
    })
    .join(eol)
}
