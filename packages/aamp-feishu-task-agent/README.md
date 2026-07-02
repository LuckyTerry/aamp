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
- ACP bridge: `@zengxingyuan/aamp-acp-bridge@0.1.28-dev.14`
- CLI bridge: `@zengxingyuan/aamp-cli-bridge@0.1.7-dev.5`
- Feishu bridge: `@zengxingyuan/aamp-feishu-bridge@0.1.14` with `--enable-task`
- Authorization method: `pairing-code`
- Debug mode: disabled by default; pass `--debug` to enable bridge debug logs
- Codex ACP command: refreshed on every launch; macOS prefers the signed Codex.app binary and pins `@agentclientprotocol/codex-acp`

The launcher writes its embedded environment helper to `~/lark-env-task.sh` on
every run, overwriting any existing file with the same name.

Environment examples:

```bash
bash aamp-feishu-task-agent-bootstrap.sh \
  --env boe \
  --agent codex \
  --app-id cli_xxx \
  --app-secret xxx
```
