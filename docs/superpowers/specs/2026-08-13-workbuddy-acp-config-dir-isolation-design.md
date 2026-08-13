# WorkBuddy ACP Configuration Directory Isolation Design

## Context

`feishu-task-agent start` launches the embedded WorkBuddy CLI directly through
`codebuddy --acp`. The desktop applications inject a product-specific
`CODEBUDDY_CONFIG_DIR`, but the Task Agent currently omits that environment
variable. A direct CLI launch therefore falls back to `~/.codebuddy` instead
of reading the selected desktop application's authentication state.

Local A/B probes established the behavior:

- WorkBuddy fails with `Authentication required` when launched without the
  desktop configuration directory;
- the same WorkBuddy binary creates and closes an ACP session when only
  `CODEBUDDY_CONFIG_DIR=~/.workbuddy` is added;
- the WorkBuddy AI bundle declares `dataFolderName: ".workbuddy-ai"` and its
  desktop bootstrap derives `CODEBUDDY_CONFIG_DIR` from that value;
- a bare WorkBuddy AI launch currently succeeds through unrelated legacy
  state in `~/.codebuddy`, while a launch against `~/.workbuddy-ai` correctly
  reports that the international application is not authenticated.

The two products must therefore use separate authentication and runtime state.

## Goals

1. Launch WorkBuddy ACP with `~/.workbuddy` as its configuration directory.
2. Launch WorkBuddy AI ACP with `~/.workbuddy-ai` as its configuration
   directory.
3. Upgrade existing saved bindings that still contain the exact old generated
   bare command.
4. Preserve explicitly customized ACP commands.
5. Keep the two products safe under concurrent multi-Agent startup.

## Non-goals

- Sharing authentication state between WorkBuddy and WorkBuddy AI.
- Falling back to `~/.codebuddy` when an application-specific login is absent.
- Automating either application's login flow.
- Adding a generic environment map to the bridge configuration schema.
- Changing readiness-probe or authentication-error wording.
- Modifying the npm release skill changes already present in the worktree.

## Considered Approaches

### Product-specific environment prefix (selected)

Serialize each native default command with an `env CODEBUDDY_CONFIG_DIR=...`
prefix. This follows the existing string-based ACP command contract, remains
local to the spawned child, and is compatible with concurrent startup.

### Per-Agent environment configuration

Add a structured environment field to the bridge schema and thread it through
discovery, persistence, `acpx`, and child-process launch. This is a cleaner
general abstraction but is unnecessarily broad for two fixed macOS bundles and
would require a configuration migration.

### Mutate the Task Agent process environment

Set `process.env.CODEBUDDY_CONFIG_DIR` before starting each bridge. This is not
safe because WorkBuddy and WorkBuddy AI can start concurrently in the same
process and could observe one another's directory.

## Command Contract

The resolver derives the current user's home directory at runtime and emits a
shell-safe command for each product:

```text
workbuddy:
env CODEBUDDY_CONFIG_DIR=<home>/.workbuddy /Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy --acp

workbuddy_ai:
env CODEBUDDY_CONFIG_DIR=<home>/.workbuddy-ai '/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy' --acp
```

Only `CODEBUDDY_CONFIG_DIR` is required. A live probe showed that adding this
single variable is sufficient; the Task Agent does not copy the desktop
process's other environment variables.

The executable constants remain raw absolute paths for filesystem checks and
version probing. Quoting applies only to serialized shell command arguments.

## Existing Binding Migration

The resolver recognizes exactly two legacy generated commands:

```text
/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy --acp

'/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy' --acp
```

When discovery or JSON initialization receives one of these exact commands for
the corresponding canonical Agent type, it replaces it with the new
product-specific default. Any other nonblank previous command is considered a
user customization and remains byte-for-byte unchanged.

An `acpCommand` explicitly supplied in the current JSON initialization request
continues to win, even when it equals a legacy command. Migration applies when
the caller omits the field and relies on the saved/default command.

This requires no schema or binding-identity change. The next normal Task Agent
preparation updates the generated ACP configuration while retaining the
existing binding and mailbox identity.

## Error Handling

- A logged-in WorkBuddy installation starts through `~/.workbuddy`.
- A WorkBuddy AI installation without a valid `~/.workbuddy-ai` login fails
  its existing readiness check and tells the user to sign in to WorkBuddy AI.
- The runtime never silently borrows `~/.codebuddy` credentials.
- Custom commands remain the caller's responsibility and are not rewritten.

## Verification

Test-driven implementation will add regression coverage before production
changes:

1. Resolver defaults and native detection contain the correct directory for
   each canonical Agent.
2. Shell parsing keeps both configuration directory and executable path as
   single arguments, including the space in `WorkBuddy AI.app`.
3. Exact legacy defaults migrate for both products.
4. Custom commands remain unchanged.
5. Discovery upgrades an existing legacy command.
6. JSON initialization upgrades a saved legacy command when the request omits
   `acpCommand`, while preserving an explicitly supplied command.
7. The affected ACP Bridge test suite and TypeScript build pass.

Manual verification uses fresh temporary ACP sessions and immediately closes
successful probes:

- WorkBuddy succeeds through its generated command on the authenticated local
  installation.
- WorkBuddy AI is confirmed to write/read under `~/.workbuddy-ai`; on the
  current machine it may remain an expected authentication failure until the
  international application is logged in.

## Delivery

Implementation stays on `feat/one-click-script`. Only files for this fix and
the already requested npm release skill change are included in final history;
unrelated `.agents/.run_state.json` state remains untracked. Before push, the
new work is consolidated into the single commit requested by the user.
