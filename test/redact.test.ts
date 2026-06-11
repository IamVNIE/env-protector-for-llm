import { describe, expect, it } from 'vitest'
import { StreamRedactor, isProtectable, maskSecret, redactText } from '../src/redact.js'

describe('maskSecret', () => {
  it('masks the first 90% of the value', () => {
    const secret = 'sk-proj-abcdefghij1234567890' // 28 chars -> ceil(25.2) = 26 masked
    const masked = maskSecret(secret)
    expect(masked).toBe('*'.repeat(26) + '90')
    expect(masked).toHaveLength(secret.length)
  })

  it('always leaves at least one char visible', () => {
    expect(maskSecret('abcde')).toBe('****e')
  })
})

describe('isProtectable', () => {
  it('does not protect values shorter than 5 chars', () => {
    expect(isProtectable('8080')).toBe(false)
    expect(isProtectable('true')).toBe(false)
    expect(isProtectable('abcde')).toBe(true)
  })
})

describe('redactText', () => {
  const secrets = ['sk-live-SECRETVALUE', 'pw123']

  it('masks every occurrence of every secret', () => {
    const out = redactText('key=sk-live-SECRETVALUE again sk-live-SECRETVALUE and pw123', secrets)
    expect(out).not.toContain('sk-live-SECRETVALUE')
    expect(out).not.toContain('pw123')
    expect(out.match(/\*+E/g)).toHaveLength(2)
  })

  it('leaves short values untouched', () => {
    expect(redactText('PORT=8080 DEBUG=1', ['8080', '1'])).toBe('PORT=8080 DEBUG=1')
  })

  it('masks a secret that contains another secret as a whole', () => {
    const out = redactText('token: ABCDEFGHIJ', ['ABCDEFGHIJ', 'DEFGH'])
    expect(out).toBe('token: *********J')
  })
})

describe('StreamRedactor', () => {
  it('redacts a secret split across chunk boundaries', () => {
    const r = new StreamRedactor(['sk-live-SECRETVALUE'])
    const out = r.process('key is sk-live-SEC') + r.process('RETVALUE done\n') + r.flush()
    expect(out).toBe('key is ******************E done\n')
  })

  it('redacts a secret delivered one char at a time', () => {
    const secret = 'topsecret42'
    const r = new StreamRedactor([secret])
    let out = r.process('value: ')
    for (const ch of secret) out += r.process(ch)
    out += r.process('\n') + r.flush()
    expect(out).toBe('value: **********2\n')
  })

  it('flushes held-back text that turned out not to be a secret', () => {
    const r = new StreamRedactor(['sk-live-SECRETVALUE'])
    const out = r.process('prefix sk-liv') + r.flush()
    expect(out).toBe('prefix sk-liv')
  })

  it('never leaks plaintext for random secrets across random chunkings', () => {
    for (let i = 0; i < 50; i++) {
      const secret = 'S'.repeat(1) + (i * 2654435761).toString(36).repeat(3) + 'end' + i
      if (!isProtectable(secret)) continue
      const r = new StreamRedactor([secret])
      const input = `log line with ${secret} embedded twice ${secret}\n`
      let out = ''
      let pos = 0
      const step = (i % 7) + 1
      while (pos < input.length) {
        out += r.process(input.slice(pos, pos + step))
        pos += step
      }
      out += r.flush()
      expect(out).not.toContain(secret)
      expect(out.length).toBe(input.length)
    }
  })
})
