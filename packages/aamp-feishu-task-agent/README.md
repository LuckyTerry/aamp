# aamp-feishu-task-agent

One-click launcher for running the AAMP ACP/CLI bridge and unified Feishu
bridge with task support together. Use the standalone script as the single
entrypoint:

```bash
bash aamp-feishu-task-agent-bootstrap.sh \
  --agent codex \
  --app-id cli_xxx \
  --app-secret xxx
```

`--agent` can be `codex`, `cursor`, `claude`, `gemini`, or `codem`. For Cursor, the
launcher installs the official Cursor Agent CLI when it is missing, adds
`~/.local/bin` to PATH for the current run, clears macOS quarantine attributes
when possible, and runs `agent login` when login is required.

For Codem, the launcher uses `aamp-cli-bridge` instead of `aamp-acp-bridge`,
installs Codem through ByteDance's official installer when it is missing, and
runs `codem login` and `codem service start` when the CLI is not authenticated.
Codem requires ByteDance RD network access. Non-R&D users must apply for RD
network permission before binding CodeM:
https://netsegment.bytedance.net/apply/rd-network

The script checks `npm`/`npx` at runtime. If they are missing, it checks
Homebrew, Volta, fnm, and nvm, installs Node.js/npm automatically when possible,
and prints manual installation steps if automatic installation fails.

When installed from npm, the package bin uses the same script.

Defaults:

- Environment: `online`
- AAMP host: `https://meshmail.ai`
- ACP bridge: `@zengxingyuan/aamp-acp-bridge@0.1.28-dev.16`
- CLI bridge: `@zengxingyuan/aamp-cli-bridge@0.1.7-dev.11`
- Feishu bridge: `@zengxingyuan/aamp-feishu-bridge@0.1.42` with `--enable-task`
- lark-cli minimum version: `1.0.64`
- Authorization method: `pairing-code`
- Debug mode: disabled by default; pass `--debug` to enable more detailed bridge logs on disk
- Codex ACP command: refreshed on every launch; macOS prefers the signed Codex.app binary and pins `@agentclientprotocol/codex-acp`

The launcher writes its embedded environment helper to `~/lark-env-task.sh` on
every run, overwriting any existing file with the same name.

## Local logs and diagnostics

Each launch creates a local log run under:

```text
~/.aamp/logs/runs/<timestamp>-<pid>/
```

The launcher writes component logs separately so the terminal stays readable:

```text
one-click.log
feishu-bridge.jsonl
acp-bridge.jsonl      # when the selected agent uses ACP
cli-bridge.jsonl      # when the selected agent uses CLI mode
codem-preflight.log   # when CodeM preflight runs
errors.jsonl
manifest.json
```

The terminal prints concise progress, a clear success message, short errors,
and the log collection command. Detailed launcher and bridge output is written
to files. To show detailed one-click launcher messages on the terminal, start
with `AAMP_ONE_CLICK_VERBOSE=true`. To mirror bridge logs to the terminal while
debugging, start with `AAMP_TAIL_BRIDGE_LOGS=true`.

The launcher installs the local diagnostics command at:

```bash
~/.aamp/bin/aamp-logs
```

Useful commands:

```bash
~/.aamp/bin/aamp-logs collect --task-id <Task ID>
~/.aamp/bin/aamp-logs collect --task-guid <Feishu task guid>
~/.aamp/bin/aamp-logs collect --latest
~/.aamp/bin/aamp-logs collect --since 2h
~/.aamp/bin/aamp-logs list-runs
~/.aamp/bin/aamp-logs tail --task-id <Task ID>
```

`collect` creates a local `.tar.gz` bundle under `~/.aamp/logs/archives/`.
It does not upload anything. Task-scoped collection includes matching log
fragments by default. Add `--include-content` only when the full matching run
logs are needed. Sensitive fields such as secrets, tokens, passwords,
authorization headers, cookies, credentials, `appSecret`, `smtpPassword`,
`mailboxToken`, `access_token`, and `device_code` are redacted before
packaging.

Task-level troubleshooting uses the existing Task ID as the cross-component
correlation key. `--task-id` matches one exact task event. `--task-guid`
builds the stable Task ID prefix `feishu-task-<task_guid>-` and searches all
component logs with that prefix, so ACP/CLI logs do not need to understand
Feishu-specific fields. When exact Task IDs can be parsed from the matching
lines, they are listed in the bundle README.

Environment examples:

```bash
bash aamp-feishu-task-agent-bootstrap.sh \
  --env boe \
  --agent codex \
  --app-id cli_xxx \
  --app-secret xxx
```
