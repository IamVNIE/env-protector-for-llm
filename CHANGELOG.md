# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `envshield encrypt` adds a comment preamble at the top of encrypted env files telling
  AI agents what the file is and how to work with it (`envshield run -- <cmd>`, don't try
  to decrypt). Added once, only when the file has encrypted values; `decrypt` strips it, so
  encrypt → decrypt still restores the file byte-for-byte.

## [0.2.0] - 2026-10-07

### Added
- `envshield hooks install|uninstall|status [agent...]`: installs post-tool-call hooks into
  Claude Code, Codex CLI, pi, OpenCode, Gemini CLI, and Cursor so protected `.env` values are
  masked in every tool result before the model sees it — not just in `envshield run` output.
  With no agents named, installs for every agent detected on the machine.
- `envshield hook <agent>`: the hook entry point the agents call. Secrets are looked up via
  the keystore for the project the agent is working in (and its sub/parent directories); it
  fails open and never creates a keystore.
- Library exports: `collectSecrets`, `redactDeep`, `handleHook`, `installHook`,
  `uninstallHook`, `hookStatus`, `detectAgents`, `AGENTS`.

## [0.1.4] - 2026-06-16

### Internal
- Bump `actions/checkout` and `actions/setup-node` to v5 (Node 24 runtime) in the
  CI and Release workflows, clearing the Node 20 deprecation warnings. No change to
  the published package contents.

## [0.1.3] - 2026-06-16

### Changed
- `envshield source` now fails with a clear explanation instead of a generic
  "unknown command": `source` is a shell builtin that loads vars into the current
  shell, which a separate process cannot do on any OS. The error points to the
  supported `envshield run -- <cmd>` form (and the quoted-line pattern for chaining).

## [0.1.2] - 2026-06-16

### Fixed
- `envshield run -- <cmd>` now works with `.cmd`/`.bat` shims on Windows (`npm`,
  `npx`, `nodemon`, …). Modern Node (≥ 22, the CVE-2024-27980 fix) refuses to spawn
  batch files with `shell: false`, throwing `EINVAL`; the runner only retried on
  `ENOENT`, so these commands failed outright. Bare names and batch shims are now
  resolved through `cmd.exe` (via `PATHEXT`) with explicit argument quoting.

### Added
- Command chaining through the shell: `envshield run -- "npm run migrate && docker compose up"`.
  Quote the whole line so the shell runs it under the injected, decrypted env. A
  single argument-less command string is executed via the platform shell.

### Documentation
- Clarified that `envshield source .env && ...` is impossible by design — a child
  process cannot push env vars back into the parent shell (and it would defeat output
  redaction). Use `envshield run -- <cmd>` instead, and quote the line to chain commands.

## [0.1.1]

- Release only tags whose commit is on main.
- Switch npm publish to OIDC trusted publishing, drop `NPM_TOKEN`.
- Add repository metadata required for npm provenance verification.
- Rename package to `llm-envshield` (CLI command unchanged).

[0.2.0]: https://github.com/IamVNIE/env-protector-for-llm/releases/tag/v0.2.0
[0.1.4]: https://github.com/IamVNIE/env-protector-for-llm/releases/tag/v0.1.4
[0.1.3]: https://github.com/IamVNIE/env-protector-for-llm/releases/tag/v0.1.3
[0.1.2]: https://github.com/IamVNIE/env-protector-for-llm/releases/tag/v0.1.2
[0.1.1]: https://github.com/IamVNIE/env-protector-for-llm/releases/tag/v0.1.1
