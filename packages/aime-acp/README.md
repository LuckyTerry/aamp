# aime-acp

`aime-acp` exposes ByteDance's remote AIME agent as an Agent Client Protocol
(ACP) stdio server. AIME does the work remotely: `aime-acp` does not access the caller's local workspace and does not connect to MCP servers.

This package is internal and unpublished until the release checklist is fully
approved. The examples below describe the intended `0.1.0` contract; they are
not proof that a registry release, AAMP integration, or Feishu Task end-to-end
flow has completed.

## Requirements and installation

- Standalone `aime-acp` requires Node.js 20 or newer.
- `acpx@0.11.2` and AAMP launch it with Node.js 22.13 or newer.
- Supported AIME sites are exactly `cn` and `i18n-tt`.
- The caller needs network access to the selected AIME site. `aime-acp` does not detect the corporate network, and DNS resolution alone is not an access
  check. Use `doctor` to test the authenticated API path.

Install from the ByteDance npm registry:

```bash
npm install -g @tengchengwei/aime-acp@0.1.0 --registry=https://bnpm.byted.org
```

The package embeds the exact-pinned `@bytedance-dev/bytedcli@0.123.0` Node API.
It does not execute a global `bytedcli` executable and does not require one. When a compatible global bytedcli exists, both programs can use compatible same-user/site managed auth state; coexistence is not guaranteed across arbitrary versions. `aime-acp` does not copy, move, print, or persist the raw
managed credential.

Until controlled real-auth coexistence evidence is recorded for a release and
site, use one active `aime-acp` ACP process per OS user and site; stop it before login/logout/account changes.

## Authenticate and diagnose

Use the package-owned commands; there is no `logout` command. Authentication
mutation must be serialized with active ACP processes.

```bash
aime-acp auth login --site cn
aime-acp auth status --site cn --json
aime-acp doctor --site cn --json
```

The non-JSON status/login commands print a one-word status to stdout and safe
progress to stderr. Machine-readable commands print exactly one JSON line.
The exit contract is:

| Command | Exit codes | stdout |
| --- | --- | --- |
| `auth status` | `0` authenticated, `1` unauthenticated/error | `authenticated` or `unauthenticated`; errors use stderr |
| `auth login` | `0` authenticated, `2` pending, `1` error | `authenticated` or `pending`; errors use stderr |
| `auth login --begin` | `0` challenge, `1` error | Use `--json`; the opaque resume token is not useful in the one-word rendering. |
| `auth login --complete` | `0`, `2`, `1` | Authenticated, pending, or safe error respectively; use `--resume-token-stdin`. |
| `doctor` | `0` healthy, `1` failed | Exactly one JSON line, with or without `--json`. |

### `auth status --json`

Exit `0` means authenticated; exit `1` means unauthenticated or a safe error.

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "auth.status",
  "site": "cn",
  "status": "authenticated",
  "authSource": "bytecloud_auth",
  "authType": "user",
  "expiresAt": "2030-01-02T03:04:05.000Z"
}
```

For an unauthenticated status, `ok` remains `true`, `status` is
`unauthenticated`, and credential metadata is absent.

### `auth login --json`

Exit `0` means authenticated, exit `2` means login is still pending, and exit
`1` means a safe error. A successful result uses the authenticated status
schema above with `command: "auth.login"`; a pending result is:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "auth.login",
  "site": "cn",
  "status": "pending"
}
```

The explicit resumable flow is `aime-acp auth login --begin --json`, followed
by `aime-acp auth login --complete --resume-token-stdin --json`. The begin
result may contain `url`, `displayCode`, `expiresAt`, and an opaque
`resumeToken`. Supply that token as the only stdin line to the completion
command; it is rejected in argv and environment variables.

The begin result schema is:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "auth.login.begin",
  "site": "cn",
  "status": "pending",
  "url": "https://approved-login-host.example/verify",
  "displayCode": "ABCD-EFGH",
  "expiresAt": "2030-01-02T03:04:05.000Z",
  "resumeToken": "opaque-resume-token"
}
```

`url`, `displayCode`, `expiresAt`, and `resumeToken` are optional because the
managed login provider controls the challenge shape. Completion uses the
authenticated/pending schema with `"command": "auth.login.complete"`:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "auth.login.complete",
  "site": "cn",
  "status": "authenticated",
  "authSource": "bytecloud_auth",
  "authType": "user",
  "expiresAt": "2030-01-02T03:04:05.000Z"
}
```

All auth-command failures use exit `1` and, with `--json`, this schema on
stdout:

```json
{
  "schemaVersion": 1,
  "ok": false,
  "command": "auth.login.complete",
  "site": "cn",
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "Authentication did not complete.",
    "retryable": false
  }
}
```

Configuration failures detected before command routing use exit `1` and one
safe JSON line on stderr instead:

```json
{
  "code": "AUTH_CONFIGURATION_UNSUPPORTED",
  "message": "The runtime authentication configuration is unsupported.",
  "retryable": false,
  "safeMetadata": {}
}
```

### `doctor --json`

Exit `0` means the pinned SDK is compatible, managed-user auth is ready, and a
real AIME space lookup succeeded. Exit `1` means at least one stage failed.

```json
{
  "schemaVersion": 1,
  "ok": true,
  "site": "cn",
  "packageVersion": "0.1.0",
  "bytedcliVersion": "0.123.0",
  "acpSdkVersion": "0.28.1",
  "compatible": true,
  "authenticated": true,
  "aimeReachable": true,
  "spaceHash": "salted-sha256"
}
```

Failure results keep the same version, compatibility, authentication, and
reachability fields and add:

```json
{
  "error": {
    "code": "AIME_NETWORK_UNREACHABLE",
    "message": "AIME is unreachable over the network.",
    "retryable": true,
    "stage": "space-resolve",
    "host": "safe-host-if-known",
    "errno": "safe-errno-if-known"
  }
}
```

## Run through ACP

Examples with the pinned `acpx@0.11.2` client:

```bash
acpx aime-acp "summarize this HTTP link"
acpx --agent "aime-acp --site i18n-tt" "answer this question"
```

The ACP server accepts text and HTTP(S) links only. Images, audio, embedded
resources, local file paths, and non-HTTP URLs return
`AIME_UNSUPPORTED_CONTENT`. ACP `cwd`, `additionalDirectories`, and
`mcpServers` inputs are intentionally inert. Remote AIME may emit remote tool
events, but those events do not authorize local file, terminal, or MCP access.

ACP cancellation is soft cancellation: `aime-acp` promptly returns
`cancelled`, drains the already-sent remote turn, and permits a later prompt.
It does not claim server-side AIME cancellation.

ACP application failures use the standard JSON-RPC error envelope. The
numeric code is stable for this package version; clients should branch on the
stable string in `error.data.code`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32001,
    "message": "Managed user authentication is required. Run `aime-acp auth login --site cn`.",
    "data": {
      "code": "AUTH_REQUIRED",
      "retryable": false
    }
  }
}
```

## Proxy configuration

Use `--proxy https://proxy.example` or `AIME_ACP_PROXY` only when the selected
site requires an approved HTTP(S) proxy. The value must be an origin-only
`http://` or `https://` URL with no username, password, path, query, or
fragment. Process-wide `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and bytedcli
proxy variables are ignored so an ambient proxy cannot silently change the
boundary. Proxy configuration is not an internal-network detector.

## Stable errors

JSON commands and ACP errors expose only a stable code, safe message,
retryability, and allowlisted metadata. Troubleshooting by code:

| Code | Meaning and action |
| --- | --- |
| `AUTH_REQUIRED` | Run `aime-acp auth login --site <site>`, then retry. |
| `AUTH_SOURCE_UNSUPPORTED` | Remove external/service-account auth configuration and use managed-user login. |
| `AUTH_IDENTITY_UNAVAILABLE` | Managed auth lacks a stable user identity; re-authenticate or contact the auth owner. |
| `AUTH_IDENTITY_CHANGED` | Stop the process and start a new ACP session after the account change. |
| `AUTH_CONFIGURATION_UNSUPPORTED` | Remove forbidden auth env/options; tokens are never accepted in argv/env. |
| `AIME_ACCESS_DENIED` | Request access to AIME or the selected space/model. |
| `AIME_SESSION_NOT_FOUND` | The remote session cannot be loaded; create a new session or check the ID. |
| `SESSION_BUSY` | Wait for the active prompt or cancel it before sending another. |
| `AIME_UNSUPPORTED_CONTENT` | Send only text or an HTTP(S) link. |
| `AIME_MODEL_NOT_FOUND` | Select a model advertised by the chosen space/site. |
| `AIME_SEND_FAILED` | The remote send failed before a safe completion; inspect safe stderr and retry only if appropriate. |
| `AIME_STREAM_INTERRUPTED` | The event stream exceeded recovery limits; load the remote session before continuing. |
| `AIME_PROTOCOL_DRIFT` | The pinned AIME response/event contract changed; update and requalify the adapter. |
| `AIME_EMPTY_RESPONSE` | AIME completed without agent text; retry or inspect the remote session. |
| `AIME_SDK_INCOMPATIBLE` | Installed SDK surface does not match the pin; reinstall the exact `@tengchengwei/aime-acp` version selected by the Task Agent bootstrap. |
| `AIME_NETWORK_UNREACHABLE` | Check approved network/proxy access with `doctor`; DNS alone is not sufficient. |

Server stdout is reserved for newline-delimited ACP JSON-RPC. Safe operational
logs use stderr and never include raw prompts, identity, credentials, cwd,
session IDs, or raw tool payloads.

## Release evidence

Local fake smoke proves the packaged ACP contract without credentials. Real
AIME for both sites, auth coexistence, AAMP/Feishu Task end-to-end behavior,
and package publishing remain separate credentialed or owner-approved gates in
[`docs/release-checklist.md`](docs/release-checklist.md).
