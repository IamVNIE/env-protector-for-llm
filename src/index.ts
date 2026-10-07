export {
  MIN_PROTECTED_LENGTH,
  MASK_RATIO,
  isProtectable,
  maskSecret,
  redactText,
  StreamRedactor,
} from './redact.js'
export {
  ENC_PREFIX,
  generateKey,
  isEncryptedValue,
  encryptValue,
  decryptValue,
} from './crypto.js'
export { Keystore, keystoreDir, keyId, normalizeProjectDir } from './keystore.js'
export type { KeystoreEntry } from './keystore.js'
export {
  parseEnvPairs,
  transformEnvValues,
  addPreamble,
  removePreamble,
  PREAMBLE_MARKER,
} from './envfile.js'
export type { EnvPair } from './envfile.js'
export { runCommand } from './runner.js'
export type { RunOptions } from './runner.js'
export { cliMain } from './commands.js'
export type { CliIo } from './commands.js'
export { collectSecrets, redactDeep } from './secrets.js'
export {
  AGENTS,
  handleHook,
  installHook,
  uninstallHook,
  hookStatus,
  detectAgents,
} from './hooks.js'
export type { Agent, AgentPaths, HookResult } from './hooks.js'
