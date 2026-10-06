# llm-envshield

[![npm version](https://img.shields.io/npm/v/llm-envshield.svg)](https://www.npmjs.com/package/llm-envshield)

Like dotenvx, but built for the age of AI coding agents: your `.env` stays encrypted in the
project, the **key lives outside the project**, and command output is **automatically redacted**
so secrets never reach the terminal — or the LLM reading it.

## Install

```sh
npm install -g llm-envshield   # requires Node >= 22.13; installs the `envshield` command
```

## Quick start

```sh
cd my-project
envshield encrypt                  # encrypts values in .env, in place
envshield run -- npm start         # runs with decrypted env, output redacted
```

Your `.env` now looks like this — safe to leave in the repo an agent works on:

```dotenv
OPENAI_API_KEY=enc:gcm:Mylncwi/ckLh8qwCvDkcUxdFuiL4EDdT...
DB_PASSWORD="enc:gcm:BLvFH180xMOoA7srcUOn23AGV13qxbNq..."
PORT=8080
```

And if your app (or an agent) prints a secret, the output is masked — first 90% hidden:

```sh
$ envshield run -- node -e "console.log(process.env.OPENAI_API_KEY)"
**************************CD
```

## Commands

| Command | What it does |
|---|---|
| `envshield encrypt [-f <file>]` | Encrypt all values (≥ 5 chars) in place |
| `envshield run [-f <file>] -- <cmd>` | Run a command with decrypted env; secrets redacted in stdout/stderr |
| `envshield decrypt [-f <file>] [--stdout]` | Restore plaintext (for humans; `--stdout` doesn't touch the file) |
| `envshield keys list` | Show which projects have keys (never the keys themselves) |
| `envshield keys path` | Show the keystore location |
| `envshield hooks install [agent...]` | Redact secrets from every tool result in your coding agents |
| `envshield hooks uninstall [agent...]` | Remove those hooks (other settings untouched) |
| `envshield hooks status` | Show where hooks are installed |

### Running commands

`envshield run` spawns your command as a **child process** with the decrypted env injected,
so it works with `.cmd`/`.bat` shims on Windows (`npm`, `npx`, `nodemon`, …) too:

```sh
envshield run -- nodemon server.js
envshield run -- docker compose up
```

It cannot, however, work like the shell builtin `source` — a separate process can't push env
vars back into your shell, so `envshield source .env && docker compose up` is impossible by
design (and would defeat output redaction). To chain commands, **quote the whole line** and let
the shell run it under the injected env:

```sh
envshield run -- "npm run migrate && docker compose up"
```

Without quotes, your shell splits on `&&` before envshield sees it, so only the first command
gets the secrets.

## Agent hooks: redact every tool result

`envshield run` only protects output of commands you route through it. To make sure an agent
*never* sees a secret — even when it `cat`s a log your app wrote, reads a decrypted file, or
calls an MCP tool that echoes a key — install a post-tool-call hook:

```sh
envshield hooks install            # every supported agent detected on this machine
envshield hooks install claude pi  # or pick agents explicitly
```

After each tool call the agent hands the result to `envshield hook <agent>`, which masks every
protected value of the project being worked on (looked up via the keystore, including from
subdirectories) before the model sees it. Projects you haven't encrypted are left alone.

| Agent | Installed into | What gets redacted |
|---|---|---|
| Claude Code | `~/.claude/settings.json` (`PostToolUse`) | All tool output, replaced in place |
| Codex CLI | `~/.codex/hooks.json` (`PostToolUse`) | All tool output, returned to the model as a blocked result¹ |
| pi | `~/.pi/agent/extensions/envshield.js` | All tool output, replaced in place |
| OpenCode | `~/.config/opencode/plugins/envshield.js` | All tool output, replaced in place |
| Gemini CLI | `~/.gemini/settings.json` (`AfterTool`) | All tool output, returned to the model as a blocked result |
| Cursor | `~/.cursor/hooks.json` | MCP output redacted; reads of files that contain secrets are denied. Cursor can't rewrite shell output, so use `envshield run` there |

¹ Codex asks you to review and trust new hooks before they run.

Install merges into your existing config (a `.envshield-backup` copy is kept), is idempotent, and
refuses to touch a config file it can't parse. Hooks fail open: if something goes wrong, the
agent keeps working with the original output. Restart the agent after installing.

## How it works

- Each `(project directory, env file)` pair gets its own AES-256-GCM key, stored in
  `~/.envshield/keystore.db` — **never inside the project** (no `.env.keys` file to steal).
- `envshield run` decrypts in memory only, injects the env into your command, and streams its
  output through a redactor that masks every protected value, even across chunk boundaries.
- Values **shorter than 5 characters** (ports, flags like `DEBUG=1`) are left as-is: not
  encrypted, not redacted.
- Comments, ordering, quoting, and line endings in your `.env` are preserved; encrypt → decrypt
  restores the file byte-for-byte.

## Threat model, honestly

envshield protects against an agent *reading project files* or *reading command output*. An
agent running unrestricted with your full OS account could still read `~/.envshield/`. So deny
it: e.g. in Claude Code, add `~/.envshield` to the deny list in your permission settings, and
never let agents run `envshield decrypt`.

## License

Apache-2.0
