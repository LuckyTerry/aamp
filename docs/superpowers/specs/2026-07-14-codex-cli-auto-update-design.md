# Codex CLI Auto-Update Design

## Goal

Before starting the Codex ACP bridge, update the Codex CLI selected by the one-click launcher so newly required models are not rejected by an outdated client.

## Scope

- Run only after the user selects Codex and before Codex login validation and ACP command construction.
- Resolve the same Codex executable used by login checks and `CODEX_PATH`.
- Read the selected executable version and query the latest npm version.
- Print the current/latest version line and the update-start line in the terminal.
- Invoke the selected executable's native `codex update` command only when the latest version is newer.
- Resolve the executable and version again after the update so a replaced binary or symlink is observed.
- Keep detailed update diagnostics in the run log; only the requested version and update-start lines are added to normal terminal output.
- If update fails, log a warning and continue with the originally selected executable.
- Do not install Codex when no Codex CLI is detected.
- Do not modify the Codex desktop application bundle.

## Data Flow

1. Agent selection resolves Codex through `resolve_codex_cli_for_acp`.
2. `ensure_codex_cli_updated` captures its path/current version and queries the latest `@openai/codex` version.
3. The launcher prints the current/latest version line and compares them using semantic-version ordering.
4. When the latest version is newer, the launcher prints that the Codex CLI is being updated and runs `update` without an interactive confirmation; stdout and stderr are redirected to the one-click log.
5. When the current version is already latest (or newer), the launcher skips the update command and update-start terminal line.
6. On success, the resolver and version check run again.
7. Login validation and ACP command construction use the refreshed resolution.
8. On version-query, comparison, or update failure, startup continues and the ACP command uses the available resolved executable.

## Concurrency And Errors

- Serialize Codex updates with a dedicated directory lock so simultaneous launchers do not update the same installation concurrently.
- A lock timeout or update failure is non-fatal under the approved lenient policy.
- Update success without a usable executable is treated as a warning; normal detection then decides whether startup can continue.

## Verification

- A source-level regression test verifies update ordering before login and ACP construction.
- A shell behavior test uses a fake Codex executable to verify update invocation and re-resolution.
- A failure case verifies non-zero update status does not abort startup.
- Run the full task-agent test suite, Bash syntax validation, diff validation, and package dry-run.
