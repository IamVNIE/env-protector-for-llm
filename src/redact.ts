/**
 * Output redaction: masks protected secret values in command output so they
 * never reach the terminal, logs, or an LLM agent reading either.
 */

/** Values shorter than this are not protected (not encrypted, not redacted). */
export const MIN_PROTECTED_LENGTH = 5

/** Fraction of each secret that gets masked, counted from the start. */
export const MASK_RATIO = 0.9

export function isProtectable(value: string): boolean {
  return value.length >= MIN_PROTECTED_LENGTH
}

/**
 * Mask the first 90% of a secret, e.g. `sk-proj-abc123XYZ` -> `****************Z`.
 * Always leaves at least 1 trailing char visible so output stays correlatable.
 */
export function maskSecret(value: string): string {
  const maskLen = Math.min(Math.ceil(value.length * MASK_RATIO), value.length - 1)
  return '*'.repeat(maskLen) + value.slice(maskLen)
}

/** Replace every occurrence of every protectable secret in `text`. */
export function redactText(text: string, secrets: readonly string[]): string {
  let out = text
  // Longest first, so a secret that contains another secret is masked as a whole.
  for (const secret of [...secrets].filter(isProtectable).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join(maskSecret(secret))
  }
  return out
}

/**
 * Streaming redactor for piped child-process output. Secrets can be split
 * across chunk boundaries, so after redacting we hold back the longest suffix
 * of the emitted text that is still a prefix of some secret, and prepend it to
 * the next chunk. Call `flush()` at stream end to release the held-back tail.
 */
export class StreamRedactor {
  private readonly secrets: readonly string[]
  private carry = ''

  constructor(secrets: readonly string[]) {
    this.secrets = secrets.filter(isProtectable).sort((a, b) => b.length - a.length)
  }

  process(chunk: string): string {
    const text = redactText(this.carry + chunk, this.secrets)
    const holdLen = this.partialMatchLength(text)
    this.carry = holdLen > 0 ? text.slice(-holdLen) : ''
    return text.slice(0, text.length - holdLen)
  }

  flush(): string {
    const rest = this.carry
    this.carry = ''
    return rest
  }

  /** Length of the longest suffix of `text` that is a proper prefix of any secret. */
  private partialMatchLength(text: string): number {
    const maxLen = this.secrets.length ? this.secrets[0]!.length - 1 : 0
    for (let k = Math.min(maxLen, text.length); k > 0; k--) {
      const tail = text.slice(text.length - k)
      if (this.secrets.some((s) => s.startsWith(tail))) return k
    }
    return 0
  }
}
