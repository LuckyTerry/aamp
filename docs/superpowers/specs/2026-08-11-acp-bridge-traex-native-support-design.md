# Native Traex Support in AAMP ACP Bridge

Status: approved for implementation planning

## Background

`aamp-acp-bridge` can already execute a user-provided raw ACP command. A manual
configuration with `"acpCommand": "traex acp serve"` therefore works through
the existing AcpxClient path, but `traex` is not a native agent profile: it is
not discovered, cannot be selected with `init --agent traex`, and is not given
the correct default ACP command by JSON init.

An earlier feature branch mixed Traex support with Feishu Task Agent behavior
and modeled Traex through the canonical name `trae` with `traecli` fallback.
This design intentionally does not reuse that product model.

## Goal

Add a minimal native `traex` profile to `packages/aamp-acp-bridge` so users can:

- discover an installed `traex` executable;
- run `aamp-acp-bridge init --agent traex`;
- omit `acpCommand` from JSON init and receive `traex acp serve`;
- start Traex through the existing AcpxClient raw-command path.

## Non-goals

- No changes to `aamp-feishu-task-agent`, `aamp-feishu-bridge`, or
  `aamp-cli-bridge`.
- No Coco, `trae`, or `traecli` detection, aliasing, fallback, migration, or
  upgrade flow.
- No Traex installation or login orchestration.
- No changes to AcpxClient streaming or permission handling.
- No package-version bump or npm publication in the feature implementation
  commit.

## Branch and Isolation

Implementation uses an isolated worktree:

- base: current `main` at `7fd750875f4da2417672b91aa39eb30d4d7c80d3`;
- branch: `feat/acp-bridge-traex`;
- worktree: `aamp-worktrees/feat-acp-bridge-traex`.

The final branch diff must be limited to `packages/aamp-acp-bridge/**` plus this
design and its implementation plan under `docs/superpowers/`.

## Native Profile Contract

| Field | Value |
|---|---|
| Agent name | `traex` |
| Executable | `traex` |
| Version probe | `traex --version` |
| ACP command | `traex acp serve` |
| Default slug | `traex-bridge` |

The generated ACP command deliberately omits `--yolo`. ACP Bridge continues to
use its existing AcpxClient approval behavior and does not disable the Traex
sandbox.

## Architecture and Data Flow

```text
init --agent traex
  -> validate traex as a known native agent
  -> locate traex on PATH
  -> probe traex --version
  -> resolve acpCommand to "traex acp serve"
  -> write the ordinary ACP Bridge agent config
  -> AcpxClient sees a raw command containing whitespace
  -> acpx receives --agent "traex acp serve"
  -> Traex starts its ACP stdio server
```

`discover --json` uses the same resolver and returns a candidate with:

- `id` and `displayName`: `traex`;
- `command`: `traex`;
- `acpCommand`: `traex acp serve`;
- the normal detected/configured confidence and warning fields.

JSON init already calls `defaultAcpCommand`; once the resolver knows the Traex
mapping, an input agent containing only `"name": "traex"` receives the native
ACP command without a separate JSON-init code path.

## Code Changes

### `src/agent-resolver.ts`

- Export the single native-agent list used by interactive init and discovery.
- Add `traex` to that list.
- Resolve `traex` only from the executable named `traex` on PATH.
- Map `traex` to `traex acp serve`.
- Return the existing missing-on-PATH warning with the explicit Traex name.

The resolver must not search for `trae`, `traecli`, or `coco`.

### `src/cli/init.ts`

- Reuse the resolver's native-agent list instead of maintaining a second list.
- Accept `--agent traex` through the normal known-agent validation path.
- When a forced `traex` scan finds no executable, print the explicit resolver
  warning and stop before registration.

No login command is invoked by init.

### `src/discovery.ts`

- Reuse the resolver's native-agent list.
- Let the existing candidate builder report the Traex resolution and default
  ACP command.

### `src/json-init.ts`

No production change is expected. Add regression coverage proving that the
existing default-command path writes `traex acp serve` when `acpCommand` is
omitted.

### `package.json` and tests

- Add a package-local test script using the existing `tsx` dependency and
  Node's test runner.
- Add focused tests under `packages/aamp-acp-bridge/test/`.
- Do not add a new runtime or development dependency.

### `README.md`

Document the minimal flow:

```bash
traex login
npx aamp-acp-bridge init --agent traex
```

Include the generated configuration shape and state that the default command
does not include `--yolo`.

## Compatibility

Existing configuration files are not migrated or rewritten. The config schema
continues to permit arbitrary user-provided agent names and ACP commands, so a
previous custom entry remains governed by the generic config mechanism. This
feature does not advertise, detect, or add special behavior for any legacy
Trae or Coco name.

All existing native profiles must retain their current executable detection and
default ACP commands. AcpxClient is unchanged because `main` already passes a
command containing whitespace through `acpx --agent`.

## Error Handling

- `traex` absent from PATH: discovery returns an undetected candidate with an
  explicit warning; forced interactive init stops before registration.
- Traex not logged in: the Traex/acpx startup error is preserved and surfaced
  by the existing runtime path.
- `traex acp serve` exits or emits invalid data: existing AcpxClient error and
  fallback behavior remains authoritative.
- Unknown `--agent` value: existing known-agent validation remains unchanged.

## Verification

Automated coverage must prove:

1. the native-agent list contains `traex` and excludes `trae`, `traecli`, and
   `coco`;
2. an executable named `traex` is detected and produces
   `traex acp serve`;
3. no alternative Trae/Coco executable is used as fallback;
4. discovery reports installed and missing Traex states correctly;
5. interactive-init target resolution accepts `traex` and rejects an unknown
   native name;
6. JSON init without `acpCommand` persists `traex acp serve` while reusing
   fixture credentials and making no network registration call;
7. representative existing native agents retain their current command mapping.

Required repository checks:

```bash
cd packages/sdks/nodejs && npm ci && npm run build
cd packages/aamp-acp-bridge && npm ci && npm test && npm run build
git diff --check
```

A local, non-CI smoke test may use an installed and logged-in Traex binary to
run `traex acp serve` through AcpxClient with a bounded timeout. It must observe
ACP initialization, incremental output, a final result, and clean session
closure. This smoke is additional evidence, not a substitute for deterministic
tests.

## Acceptance Criteria

- `init --agent traex` creates an agent named `traex` with
  `acpCommand: "traex acp serve"` when Traex is installed.
- `discover --json` exposes native Traex detection.
- JSON init supplies the same default command.
- No implementation diff appears in any Feishu package or in
  `aamp-cli-bridge`.
- Coco, `trae`, and `traecli` receive no native support.
- Tests, TypeScript build, and diff checks pass.
