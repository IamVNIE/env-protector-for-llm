import { describe, expect, it } from 'vitest'
import { parseEnvPairs, transformEnvValues } from '../src/envfile.js'

const SAMPLE = [
  '# Database settings',
  'DB_HOST=localhost',
  'DB_PASSWORD="p@ss word=42"',
  '',
  "QUOTED='single quoted'",
  'export EXPORTED=exported-value',
  'PORT=8080',
  'WITH_HASH=value # trailing comment',
  'EMPTY=',
].join('\n')

describe('parseEnvPairs', () => {
  it('parses keys and values in order', () => {
    const pairs = parseEnvPairs(SAMPLE)
    expect(pairs.map((p) => p.key)).toEqual([
      'DB_HOST',
      'DB_PASSWORD',
      'QUOTED',
      'EXPORTED',
      'PORT',
      'WITH_HASH',
      'EMPTY',
    ])
  })

  it('strips quotes and keeps special chars inside them', () => {
    const byKey = Object.fromEntries(parseEnvPairs(SAMPLE).map((p) => [p.key, p.value]))
    expect(byKey['DB_PASSWORD']).toBe('p@ss word=42')
    expect(byKey['QUOTED']).toBe('single quoted')
  })

  it('supports export prefix, empty values, first-= splitting, inline comments', () => {
    const byKey = Object.fromEntries(parseEnvPairs(SAMPLE).map((p) => [p.key, p.value]))
    expect(byKey['EXPORTED']).toBe('exported-value')
    expect(byKey['EMPTY']).toBe('')
    expect(byKey['WITH_HASH']).toBe('value')
    expect(parseEnvPairs('A=b=c')[0]).toEqual({ key: 'A', value: 'b=c' })
  })

  it('ignores comments and garbage lines', () => {
    expect(parseEnvPairs('# X=1\n  # Y=2\nnot a pair\nZ=3')).toEqual([{ key: 'Z', value: '3' }])
  })
})

describe('transformEnvValues', () => {
  it('rewrites only transformed pairs, preserving comments, blanks, order', () => {
    const out = transformEnvValues(SAMPLE, (key, value) =>
      key === 'DB_PASSWORD' ? 'ENCRYPTED' : undefined,
    )
    const lines = out.split('\n')
    expect(lines[0]).toBe('# Database settings')
    expect(lines[1]).toBe('DB_HOST=localhost')
    expect(lines[2]).toBe('DB_PASSWORD="ENCRYPTED"') // original quote style kept
    expect(lines[3]).toBe('')
    expect(lines[4]).toBe("QUOTED='single quoted'")
    expect(lines[5]).toBe('export EXPORTED=exported-value')
  })

  it('keeps the export prefix on transformed lines', () => {
    const out = transformEnvValues('export A=longvalue', () => 'NEW')
    expect(out).toBe('export A=NEW')
  })

  it('preserves CRLF line endings', () => {
    const crlf = 'A=12345\r\n# comment\r\nB=67890\r\n'
    const out = transformEnvValues(crlf, () => 'X')
    expect(out).toBe('A=X\r\n# comment\r\nB=X\r\n')
  })

  it('preserves a trailing newline (and absence of one)', () => {
    expect(transformEnvValues('A=1\n', () => 'X')).toBe('A=X\n')
    expect(transformEnvValues('A=1', () => 'X')).toBe('A=X')
  })

  it('returning undefined keeps the raw line verbatim', () => {
    const raw = 'SPACED = "weird  value"'
    expect(transformEnvValues(raw, () => undefined)).toBe(raw)
  })
})
