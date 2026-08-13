# One-click Branch Integration and WorkBuddy Detection Design

## Background

The repository currently has two feature lines based on the same `main`
commit (`7fd750875f4da2417672b91aa39eb30d4d7c80d3`):

- `origin/feat/acp-bridge-agent-integrations` adds native Traex and WorkBuddy
  support to `aamp-acp-bridge`. Its tip is
  `82100119bbb3e68155ae886c12361745ee3dff45`.
- `origin/feat/traecli-acp-support` adds the Feishu Task Agent one-click flow,
  Task step improvements, release tooling, and its own Traex integration. Its
  tip is `db39f6884b639cf0af86f9a24ebc32da72f42982`.

The second branch contains 55 commits and modifies some of the same ACP Bridge
files as the first branch. The target branch must preserve the native agent
contracts from the first branch while retaining the newer Task Agent, logging,
streaming, and error-handling behavior from the second branch.

## Goals

1. Create `feat/one-click-script` from `origin/main`.
2. Apply the two source branches in the requested order: ACP integrations
   first, then the Trae/one-click branch.
3. Consolidate the 55 commits from `feat/traecli-acp-support` into one logical
   cherry-pick without changing that source branch.
4. Resolve overlapping ACP Bridge changes semantically so native Traex and
   WorkBuddy support coexist with the later bridge improvements.
5. Add WorkBuddy detection and startup support to
   `aamp-feishu-task-agent`.
6. Preserve all existing Codex, Cursor, legacy Trae, and Traex behavior and
   saved bindings.

## Non-goals

- Publishing npm packages or changing package versions.
- Adding WorkBuddy support outside macOS.
- Discovering arbitrary `codebuddy` or `cbc` executables from `PATH`.
- Installing WorkBuddy or automating its authentication.
- Migrating or renaming existing Task Agent bindings.
- Refactoring the one-click script into a general agent registry.

## Branch and Commit Integration

The target branch starts from `origin/main`. Integration happens in this order:

1. Cherry-pick the two commits from
   `origin/feat/acp-bridge-agent-integrations` in their original order:
   - `7f63d4a feat(acp-bridge): add native Traex support`
   - `8210011 feat(acp-bridge): add WorkBuddy ACP support`
2. Create a temporary single-parent commit whose tree is the exact tip tree of
   `origin/feat/traecli-acp-support` and whose parent is the common `main`
   commit. Cherry-pick that synthetic commit onto the target branch. This
   represents the full second-branch diff as one logical commit and does not
   rewrite the source branch.
3. Resolve conflicts using the policy below.
4. Add the Feishu Task Agent WorkBuddy changes as a focused commit.

The final branch therefore keeps the two reviewable native ACP integration
commits, one consolidated one-click/Trae commit, and one focused WorkBuddy
one-click commit. Design and implementation documentation will be included
with the focused WorkBuddy commit when final history is cleaned up.

## Conflict Resolution Policy

Conflict resolution is based on behavior, not blanket `ours` or `theirs`
selection.

- For Task Agent, Feishu Bridge, CLI Bridge, release tooling, logging, stream
  events, and step rendering, preserve the second branch implementation.
- For ACP Bridge agent discovery and resolution, preserve the second branch's
  later runtime/error-handling structure, then reapply the first branch's
  canonical `traex` and `workbuddy` contracts.
- Preserve WorkBuddy as a single known agent with the standard macOS embedded
  CLI and `--acp` command.
- Preserve Traex as the native Trae CLI 2.0 agent expected by the first branch,
  while keeping the Task Agent's legacy `trae` compatibility and guided
  upgrade behavior from the second branch.
- Reconcile tests and documentation to describe the final combined behavior,
  rather than accepting duplicate or obsolete assertions.
- For package manifests and lockfiles, retain dependencies and scripts required
  by both sides; use the later branch version only where version metadata
  conflicts and no release bump is part of this work.

After conflict resolution, the combined tree is reviewed against both source
branch diffs to ensure no non-conflicting file was accidentally omitted.

## WorkBuddy Detection Contract

`workbuddy` is the canonical Task Agent type. Automatic detection is supported
only on macOS and only at the standard application-bundled executable:

```text
/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy
```

The executable must exist and be executable. The one-click flow does not fall
back to `codebuddy`, `cbc`, or any other command on `PATH`.

When detected, the generated native ACP command is exactly:

```text
/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy --acp
```

This matches the `aamp-acp-bridge` resolver contract from the first source
branch and avoids having two definitions of WorkBuddy runtime behavior.

## Feishu Task Agent Changes

### Bootstrap

The bootstrap script will:

- accept `workbuddy` in `--agent` validation and help text;
- expose a small resolver for the standard WorkBuddy executable;
- include `workbuddy` in interactive and internal discovery only when the
  resolver succeeds;
- validate that the executable remains available during agent preparation;
- skip login status and login commands for WorkBuddy;
- build the exact native ACP command defined above;
- include WorkBuddy in no-agent and invalid-agent guidance where relevant.

No WorkBuddy command is run during discovery. Discovery only performs platform
and executable checks.

### Controller and persistence

The controller will include `workbuddy` in its canonical agent type allowlist.
New bindings store `agent_type: "workbuddy"`; existing configuration remains
unchanged. Install, add, start, list, and remove flows accept and display the
canonical `workbuddy` name. WorkBuddy requires no alias normalization or legacy
binding migration.

On `install` or `start`, the controller invokes the existing internal agent
preparation contract. The bootstrap returns the WorkBuddy ACP command, and the
controller passes that command into ACP Bridge initialization just as it does
for other agents.

### Authentication behavior

The Task Agent does not run a WorkBuddy login-status or login command. WorkBuddy
is expected to reuse the local authentication state established in the desktop
application. If ACP startup fails because the application is not authenticated,
the surfaced guidance tells the user to open WorkBuddy, complete login, and
retry. The launcher must not claim that authentication was verified merely
because the executable was detected.

## Runtime Data Flow

1. `feishu-task-agent install` or `add` asks the bootstrap to discover agents.
2. On macOS, the bootstrap checks whether the standard WorkBuddy executable is
   executable and returns `workbuddy` when it is.
3. The user selects `workbuddy`, and the controller stores that canonical type
   in the pending binding.
4. During `install` or the first `start`, the controller calls
   `__prepare-agent --agent workbuddy`.
5. The bootstrap revalidates the executable, skips login automation, and
   returns the absolute `codebuddy --acp` command.
6. The controller supplies that command to `aamp-acp-bridge init`, then starts
   the existing ACP and Feishu Task Bridge processes.
7. Later `start` calls repeat executable validation before starting the saved
   WorkBuddy binding.

## Error Handling

- Explicit `--agent workbuddy` on a non-macOS platform fails with a concise
  unsupported-platform message.
- Missing or non-executable standard CLI fails agent preparation and tells the
  user to install WorkBuddy in `/Applications`.
- An ACP startup/authentication failure preserves the existing run-log path and
  adds actionable guidance to open WorkBuddy, log in, and retry.
- One WorkBuddy binding failure remains isolated by the existing per-agent and
  per-binding failure handling; other selected bindings continue according to
  current Task Agent behavior.
- No error path invokes an undocumented WorkBuddy login command.

## Compatibility

- Existing `codex`, `cursor`, `trae`, and `traex` records remain valid.
- Existing ready legacy `trae` bindings retain their identity and mailbox.
- WorkBuddy uses the same per-host agent grouping, lease, ACP pairing, and
  Feishu Task runtime lifecycle as the other canonical agent types.
- No configuration schema or version change is required because `agent_type`
  is already a validated string enum and the new value has no extra fields.

## Verification

### Merge verification

- Confirm the target contains both original ACP integration commits followed
  by the consolidated second-branch change.
- Compare changed-file sets against both source branches and inspect every
  conflict resolution.
- Search the combined ACP resolver, tests, and documentation for duplicate or
  contradictory Traex/WorkBuddy definitions.

### Automated verification

- ACP Bridge resolver tests for native Traex and WorkBuddy discovery, missing
  app behavior, non-macOS behavior, and explicit command preservation.
- Task Agent bootstrap tests for WorkBuddy discovery success/failure,
  `--agent workbuddy`, exact ACP command generation, and absence of login
  command execution.
- Controller tests for allowlist validation, persistence, display, and saved
  WorkBuddy startup preparation.
- Existing Task Agent Trae/Traex, bootstrap, controller, step-stream, and
  package tests.
- Builds for the Node SDK, ACP Bridge, Feishu Task Agent, and affected bridge
  packages.

### Manual smoke verification

On a macOS host with WorkBuddy installed and authenticated:

1. Run `feishu-task-agent install` and confirm `workbuddy` appears.
2. Select WorkBuddy and a Feishu Bot.
3. Confirm the ACP Bridge starts through the embedded `codebuddy --acp`
   command and the binding becomes ready.
4. Stop the process and run `feishu-task-agent start`; confirm the saved
   WorkBuddy binding is selectable and starts again.

On a host without the standard WorkBuddy executable, confirm the interactive
list omits WorkBuddy and explicit `--agent workbuddy` fails with the documented
installation guidance.

## Acceptance Criteria

- `feat/one-click-script` contains the complete behavior of both source
  branches in the requested order, with the second branch represented as one
  consolidated cherry-pick.
- Native Traex and WorkBuddy ACP Bridge tests pass after conflicts are resolved.
- Feishu Task Agent detects standard macOS WorkBuddy installations and can
  create, persist, display, and restart `workbuddy` bindings.
- The Task Agent never executes a WorkBuddy login command and never reports
  login as verified solely from executable detection.
- Existing Codex, Cursor, Trae, and Traex automated tests remain green.
