# AAMP macOS Menu Bar App Design

Date: 2026-07-09
Status: Approved for specification; awaiting implementation plan

## Goal

Build a distributable macOS menu bar app for the AAMP Feishu Task one-click launcher. The app should let a user start, stop, inspect, and diagnose the local AAMP task connection without opening a terminal, while preserving the existing bash launcher as the source of truth for bridge setup and runtime behavior.

The first version targets an internal distributable `.app` or `.dmg`, with the project structure and build scripts ready for Developer ID signing and notarization when credentials are available.

## Non-Goals

- Do not rewrite `aamp-feishu-task-agent-bootstrap.sh` in Swift.
- Do not change the AAMP protocol, bridge package behavior, pairing flow, or Feishu task runtime behavior.
- Do not build a full log viewer in the first version.
- Do not auto-run newly downloaded code without explicit user confirmation.
- Do not require this repository path to exist on an end user's machine.

## Recommended Approach

Use a native Swift/AppKit macOS app:

- `NSStatusItem` provides the menu bar item.
- `Process` launches and supervises the bootstrap script.
- `URLSession` downloads npm package tarballs for optional launcher updates.
- `/usr/bin/tar` extracts `package/bootstrap/aamp-feishu-task-agent-bootstrap.sh` from the downloaded package.
- `UserDefaults` stores non-secret app preferences.
- `~/Library/Application Support/AAMP Menu Bar/` stores cached launcher scripts and app-managed run metadata.
- Existing AAMP runtime state remains under `~/.aamp/`.

This keeps the app small, native, and straightforward to sign later.

## First-Version User Experience

The menu bar item shows one of four states:

- `Stopped`: no app-managed launcher process is running.
- `Starting`: the app has spawned the launcher and is waiting for a success or failure signal.
- `Running`: the launcher printed the success message or the Feishu bridge log indicates readiness.
- `Error`: the launcher exited early or readiness timed out.

The menu contains:

- `Start`: launches AAMP with the selected settings.
- `Stop`: sends `SIGTERM` to the launcher process. The bash script's existing `cleanup` trap stops child bridge processes.
- `Restart`: stops the current run, then starts a new one after process exit.
- `Open Logs`: opens `~/.aamp/logs/latest` in Finder when available.
- `Collect Latest Logs`: runs `~/.aamp/bin/aamp-logs collect --latest` and reveals the resulting archive.
- `Settings...`: opens a small settings window.
- `Check for Launcher Update`: checks npm and lets the user download a newer bootstrap script.
- `Quit`: stops the app-managed launcher process, then quits.

The settings window contains:

- Agent: `codex`, `cursor`, `claude`, `gemini`, or `codem`.
- Environment: `online`, `pre`, or `boe`.
- BOE environment name, enabled only when Environment is `boe`.
- Debug mode toggle. Default is enabled for parity with the user's current command.
- Launcher version/channel. Default bundled version is `0.1.0-dev.138`.
- AAMP host. Default is `https://meshmail.ai`.
- Start at login toggle, implemented with `SMAppService` when available.

## Launcher Source and Update Policy

The app ships with a bundled, known-good bootstrap script extracted from:

```text
@zengxingyuan/aamp-feishu-task-agent@0.1.0-dev.138
package/bootstrap/aamp-feishu-task-agent-bootstrap.sh
```

The bundled script is the offline fallback. A startup failure must not occur solely because npm or the public internet is unavailable.

The app can check npm for updates using package metadata for `@zengxingyuan/aamp-feishu-task-agent`. When a newer acceptable version is found, the app shows the version and asks the user before downloading. After confirmation, it downloads the tarball to Application Support, extracts the bootstrap script, validates that it is non-empty and starts with a bash shebang or bash-compatible header, then stores it as the active cached script.

Start order:

1. Use the active cached script if it exists and passed validation.
2. Otherwise use the bundled script.
3. Never pipe a network response directly into `bash`.

The cached script path includes its package version so the app can roll back to the bundled script if the cached script fails validation.

## Process Lifecycle

The app launches:

```text
/bin/bash <validated-bootstrap-script> --agent <agent> --env <env> --aamp-host <host> [--boe-env-name <name>] [--debug]
```

The app captures stdout and stderr into an app-side run log under Application Support. The bootstrap script still writes its own authoritative logs under `~/.aamp/logs/runs/<run-id>/`.

Readiness detection uses these signals in order:

1. stdout contains `已接入飞书任务，可以开始对话 & 派发任务`.
2. the latest Feishu bridge log contains existing readiness markers such as `bridge.task_runtime.running`, `[feishu] listener started`, or `[feishu ws] connected`.
3. the app-managed process is still alive while startup timeout has not elapsed.

The startup timeout is 180 seconds. If the process exits before readiness or the timeout expires, the state becomes `Error` and the menu offers `Open Logs` and `Collect Latest Logs`.

Stopping sends `SIGTERM` to the launcher process and waits up to 15 seconds. If the process remains alive, the app sends `SIGKILL` to the parent process only. The bootstrap script is expected to terminate its own child processes through its `cleanup` trap on normal termination.

## State and Storage

App-owned storage:

```text
~/Library/Application Support/AAMP Menu Bar/
  launcher/
    bundled-version.json
    cached/<version>/aamp-feishu-task-agent-bootstrap.sh
    active.json
  runs/
    <timestamp>-<pid>/
      app.log
      stdout.log
      stderr.log
      metadata.json
```

AAMP-owned storage remains unchanged:

```text
~/.aamp/logs/
~/.aamp/bin/aamp-logs
~/.aamp/feishu-bridge/
~/.lark-cli-aamp-one-click-v1
```

Preferences stored in `UserDefaults`:

- selected agent
- selected environment
- BOE environment name
- AAMP host
- debug mode
- active cached launcher version
- update check preference
- start at login preference

The app does not store Feishu app secrets or user auth tokens. Existing launcher and `lark-cli` flows continue to own credentials.

## Error Handling

Errors are surfaced as concise menu state and a detail item in the settings window:

- missing or invalid cached launcher: fall back to bundled launcher
- network update failure: keep current launcher and show a non-blocking error
- npm tarball extraction failure: discard the downloaded archive
- startup timeout: set state to `Error`, keep logs, and offer diagnostics
- `aamp-logs` missing: offer `Open Logs`; the next successful launcher run should install `~/.aamp/bin/aamp-logs`
- permission or quarantine issues from underlying agent CLIs: let the bootstrap script handle them and show the resulting log location

The app should avoid modal alerts during normal start/stop flows. Use modal confirmation only before running a newly downloaded launcher version.

## Security and Privacy

- Downloaded launcher scripts are never executed until the user approves using the downloaded version.
- The app executes only validated local script files.
- Diagnostic bundles stay local. `aamp-logs collect` already redacts sensitive values before packaging.
- The app does not upload logs.
- The app does not read or display full secret-bearing config files.
- Future signed builds should enable hardened runtime for notarization.

## Distribution and Build

Add a new app project under:

```text
apps/aamp-menubar-mac/
```

The first implementation can use Xcode project files or Swift Package Manager plus a small app bundle assembly script. The build output should support:

- unsigned internal `.app`
- optional `.dmg`
- optional Developer ID signing when `APPLE_DEVELOPER_ID_APPLICATION` is set
- optional notarization when `APPLE_ID`, `APPLE_TEAM_ID`, and an app-specific password or keychain profile are set

The build script must work without signing credentials and clearly print that the output is unsigned.

## Testing Strategy

Unit tests:

- launcher source selection chooses cached script before bundled script
- invalid cached script falls back to bundled script
- npm metadata comparison identifies a newer version
- command arguments are built correctly for each agent/environment/debug combination
- log readiness parser recognizes the existing success and bridge readiness markers

Integration or smoke tests:

- launching `/bin/bash` with a fake bootstrap transitions from `Starting` to `Running`
- fake bootstrap failure transitions to `Error`
- stop action terminates the fake bootstrap process
- `Collect Latest Logs` invokes `~/.aamp/bin/aamp-logs collect --latest` when present

Manual verification:

- build unsigned `.app`
- launch on macOS
- start with `codex`, debug enabled, online environment
- confirm `~/.aamp/logs/latest` is created
- stop from menu bar and confirm child bridge processes exit
- disconnect network and confirm bundled launcher can still start

## Rollout

Phase 1: Build internal app with bundled launcher and basic start/stop/log actions.

Phase 2: Add update check, cached launcher version management, and confirmation flow.

Phase 3: Add `.dmg` packaging and signing/notarization hooks.

Phase 4: Polish settings, login item support, and diagnostics affordances after internal use.

## Implementation Boundaries

The first implementation should keep code boundaries small:

- `LauncherStore`: resolves bundled and cached launcher scripts.
- `LauncherUpdater`: checks npm metadata, downloads tarballs, extracts bootstrap scripts.
- `LauncherProcess`: starts, stops, and observes the bootstrap process.
- `RuntimeStatus`: maps process/log signals into `Stopped`, `Starting`, `Running`, and `Error`.
- `AampDiagnostics`: opens logs and runs `aamp-logs collect`.
- `SettingsStore`: reads and writes user preferences.
- `MenuBarController`: owns `NSStatusItem` and menu actions.
- `SettingsWindowController`: owns settings UI.

Each unit should be testable without launching real AAMP bridges by using fake script paths and temporary directories.
