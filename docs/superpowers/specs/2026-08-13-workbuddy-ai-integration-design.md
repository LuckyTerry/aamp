# WorkBuddy AI Native and Task Agent Integration Design

## Context

The repository already supports the macOS `WorkBuddy.app` bundle as the
canonical Agent type `workbuddy`. The installed international application is a
separate bundle:

```text
/Applications/WorkBuddy AI.app
```

Local inspection confirms:

- bundle identifier: `com.workbuddy.workbuddy-ai`;
- application version: `5.3.11`;
- embedded CLI version: `2.115.0`;
- embedded CLI entrypoint:

  ```text
  /Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy
  ```

- the embedded CLI exposes the same `--acp` mode as the existing WorkBuddy
  runtime.

The existing native WorkBuddy commit is:

```text
8210011 feat(acp-bridge): add WorkBuddy ACP support
```

The implementation starts from `feat/one-click-script@38528e2` in an isolated
worktree. The source branch and its existing worktree remain unchanged.

## Goals

1. Add `workbuddy_ai` as a new canonical Agent type.
2. Detect and run the international macOS application through its embedded ACP
   CLI.
3. Preserve `workbuddy` and `workbuddy_ai` as distinct, concurrently usable
   Agent types.
4. Extend the Feishu Task Agent one-click flow to discover, select, persist,
   display, prepare, start, and restart `workbuddy_ai` bindings.
5. Produce two newly authored feature commits with the native commit directly
   after the existing WorkBuddy native commit.

## Non-goals

- Renaming or migrating existing `workbuddy` bindings.
- Treating `workbuddy_ai` as an alias for `workbuddy`, or vice versa.
- Searching `PATH` for `codebuddy` or `cbc`.
- Supporting non-macOS automatic detection.
- Installing WorkBuddy AI or automating its desktop authentication.
- Publishing packages, pushing the branch, or creating a pull request.
- Changing package versions or dependency lockfiles.

## Canonical Identity and Display Contract

`workbuddy_ai` is the exact canonical value everywhere the other Agent types
are shown or persisted:

- `--agent workbuddy_ai`;
- `binding.agent_type: "workbuddy_ai"`;
- interactive discovery and selection;
- binding lists and startup summaries;
- runtime grouping and failure summaries.

There is no separate display-name layer. User-facing Agent lists show the
literal value `workbuddy_ai`. Product-specific installation and authentication
instructions may refer to the application by its proper name, `WorkBuddy AI`.

No input normalization accepts `workbuddy ai`, `workbuddy-ai`, or
`workbuddyai`. Existing `workbuddy` behavior and persisted records remain
unchanged.

The canonical Agent type remains `workbuddy_ai`, while its default AAMP mailbox
slug is the schema-safe `workbuddy-ai-bridge`. Slug normalization is limited to
mailbox registration and does not alias or rewrite the canonical Agent name.

## Branch and Commit Topology

The final linear history is organized as follows:

```text
7f63d4a  feat(acp-bridge): add native Traex support
8210011  feat(acp-bridge): add WorkBuddy ACP support
NEW-A    feat(acp-bridge): add WorkBuddy AI native support
          replay the existing 11 commits from 3859168 through 38528e2
NEW-B    feat(task-agent): add WorkBuddy AI integration
```

The implementation creates `NEW-A` on top of `8210011`, then replays the
existing `feat/one-click-script` commits after it. This changes the replayed
commit IDs only on the new branch; their patch content and order are preserved.
The source branch is not rebased or force-updated.

There are exactly two newly authored feature commits:

### NEW-A: native ACP support

This commit contains the native ACP Bridge contract available at the historical
`8210011` tree:

- registration of `workbuddy_ai` as a known Agent;
- the WorkBuddy AI embedded CLI constant;
- macOS executable detection and version probing;
- the quoted ACP command for a path containing a space;
- missing-application and unsupported-platform guidance;
- native resolver tests and ACP setup documentation.

### NEW-B: remaining integration

This commit contains everything that depends on the later one-click branch:

- Task Agent bootstrap detection and preparation;
- controller allowlist, validation, persistence, and literal display;
- readiness and authentication failure handling in the current ACP runtime;
- one-click documentation, design and implementation-plan documents;
- Task Agent and current-runtime regression tests.

The design document may exist temporarily as a standalone review commit before
implementation. Final history cleanup folds it into `NEW-B`, leaving the two
feature commits above as the only newly authored commits.

## Native ACP Bridge Design

### Runtime paths

The existing and new paths remain separate constants:

```text
workbuddy:
/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy

workbuddy_ai:
/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy
```

Detection is macOS-only and succeeds only when the exact selected path is an
executable file. Discovery performs no model call and does not start ACP.

### ACP command quoting

The WorkBuddy AI application path contains a space. The executable path used
for direct filesystem and version checks remains the raw absolute path, while
the serialized ACP command quotes that path as one shell argument before
appending `--acp`:

```text
'/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy' --acp
```

Tests must exercise command parsing, not merely compare a string, so a
regression cannot split the executable into `/Applications/WorkBuddy` and
`AI.app/...`.

### Independent discovery

`workbuddy` and `workbuddy_ai` are evaluated independently:

| Installed applications | Discovered Agent types |
| --- | --- |
| WorkBuddy only | `workbuddy` |
| WorkBuddy AI only | `workbuddy_ai` |
| Both | `workbuddy`, `workbuddy_ai` |
| Neither | neither type |

Neither type falls back to the other application path. Explicit initialization
of a missing type reports the path for that exact application.

## Feishu Task Agent Design

### Bootstrap

The bootstrap adds a dedicated WorkBuddy AI path constant and resolver. It:

- accepts the literal `workbuddy_ai` value in validation and help output;
- detects the application without invoking its CLI;
- adds it to interactive discovery only when the exact executable is present;
- revalidates the executable during preparation;
- skips login-status and login commands, matching current WorkBuddy behavior;
- builds a shell-safe quoted ACP command;
- returns `agent_type: "workbuddy_ai"` without normalization.

If both applications are installed, both canonical types appear once in the
stable discovery order, with `workbuddy_ai` immediately after `workbuddy`.

### Controller and persistence

The controller extends its exact allowlist with `workbuddy_ai`. New bindings
store the literal value. List, selection, startup, and summary paths continue to
render raw canonical Agent types, so no display mapping is added.

The existing stable runtime key includes `agent_type`. Therefore a `workbuddy`
binding and a `workbuddy_ai` binding for the same AAMP host remain distinct and
can share the existing multi-Agent ACP Bridge lifecycle without overwriting one
another.

### Readiness and authentication

Both WorkBuddy products require the existing startup ACP readiness probe. The
probe creates and closes a temporary ACP session without sending a model
prompt. Shared authentication-error classification is reused, but the
user-facing action names the selected application:

- `workbuddy`: open WorkBuddy and sign in;
- `workbuddy_ai`: open WorkBuddy AI and sign in.

A detected executable is not treated as proof of authentication. Readiness or
authentication failure prevents that Agent from being reported as running and
preserves the underlying diagnostic cause in local logs.

## Runtime Flow

1. Discovery checks both fixed application paths independently.
2. The user selects the literal `workbuddy_ai` entry.
3. The controller persists a pending binding with
   `agent_type: "workbuddy_ai"`.
4. Preparation rechecks the WorkBuddy AI executable, skips login automation,
   and returns the quoted `codebuddy --acp` command.
5. ACP Bridge initializes the distinct `workbuddy_ai` Agent configuration.
6. Startup performs the temporary ACP readiness probe.
7. After ACP readiness, the existing Feishu binding startup and status flow
   proceeds unchanged.
8. Later `start` calls repeat preparation and readiness checks for the saved
   canonical type.

## Error Handling

- On non-macOS platforms, automatic WorkBuddy AI preparation fails with a
  concise unsupported-platform message and suggests explicit `acpCommand`
  configuration only where the ACP Bridge already supports it.
- A missing or non-executable bundle reports the exact WorkBuddy AI CLI path.
- ACP authentication failures tell the user to open WorkBuddy AI and sign in.
- Other ACP startup failures retain their diagnostic details and do not become
  misleading login errors.
- No error path invokes an undocumented WorkBuddy AI login command.
- One failed `workbuddy_ai` binding remains isolated under the existing
  per-Agent and per-binding failure behavior.

## Compatibility

- Existing `workbuddy` bindings and behavior are unchanged.
- Existing canonical values `codex`, `cursor`, `coco`, `traex`, and `traecli`
  remain unchanged.
- No configuration schema or version change is required.
- No compatibility alias is introduced for the new value.
- The new path-with-space quoting must not alter quoting of explicit custom ACP
  commands for other Agent types.

## Test Strategy

Implementation follows red-green-refactor separately for each commit.

### NEW-A tests

- `KNOWN_AGENTS` contains `workbuddy` and `workbuddy_ai` exactly once.
- WorkBuddy AI resolves only from its exact executable path on macOS.
- Its raw command path and quoted ACP command are distinct and correct.
- Both installed products are discovered independently.
- Missing-app and non-macOS warnings name the correct canonical type/path.
- An execution fixture proves the path containing a space remains one argument.
- Existing WorkBuddy and representative Agent resolver tests remain green.

### NEW-B tests

- Bootstrap help and validation accept the literal `workbuddy_ai` value.
- Interactive discovery returns both products independently and invokes
  neither CLI.
- Preparation builds a round-trippable quoted ACP command and skips login
  commands.
- Controller validation, persistence, list output, and startup summaries retain
  `workbuddy_ai` verbatim.
- Saved pending and ready WorkBuddy AI bindings can be loaded and selected.
- Readiness probing applies to both WorkBuddy types.
- Authentication messages name WorkBuddy AI only for `workbuddy_ai`.
- Existing WorkBuddy, Trae-family, concurrency, and binding tests remain green.

### Final verification

- Full `aamp-acp-bridge` test suite and TypeScript build.
- Full `aamp-feishu-task-agent` test suite.
- Shell syntax validation for the bootstrap script.
- Discovery JSON/manual preparation check on the installed applications.
- A temporary ACP session create/close smoke test for WorkBuddy AI without a
  model prompt, if the installed desktop authentication state permits it.
- Final history inspection proving `NEW-A` follows `8210011`, the replayed
  commits preserve order, and `NEW-B` is the final commit.
- Final diff and status checks proving no package version, lockfile, credential,
  or unrelated worktree change is included.

## Acceptance Criteria

1. `workbuddy_ai` is the only accepted and displayed canonical value for the
   international application.
2. The exact WorkBuddy AI bundle CLI is discovered and started with a
   correctly quoted `--acp` command.
3. Existing WorkBuddy and WorkBuddy AI can both be discovered, persisted, and
   started as separate bindings.
4. Missing application and authentication failures are actionable and
   product-specific.
5. Affected full test suites and builds pass with no regression.
6. Final branch history contains the two newly authored feature commits in the
   required position, without modifying `feat/one-click-script`.
