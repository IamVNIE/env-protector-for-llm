# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.3]: https://github.com/IamVNIE/env-protector-for-llm/releases/tag/v0.1.3
[0.1.2]: https://github.com/IamVNIE/env-protector-for-llm/releases/tag/v0.1.2
[0.1.1]: https://github.com/IamVNIE/env-protector-for-llm/releases/tag/v0.1.1
