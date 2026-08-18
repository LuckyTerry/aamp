---
name: aamp-npm-release
description: >
  Prepare, pack, publish, or diagnose AAMP npm package releases from this
  repository. Use when the agent needs to check npm identity, choose or confirm
  trial/prerelease/stable package type, compute next safe versions, build local
  tgz packages, publish personal trial packages, prepare official @larktask
  packages, or produce the matching Feishu Task Agent startup command.
---

# AAMP npm release

Use this skill as an agent-facing runbook. Do the release work yourself with
the bundled helper script. Do not make the user run `node ...` as the normal
path; only show commands when handing off a browser auth step or reporting the
final startup commands.

The helper script is:

```bash
node .agents/skills/aamp-npm-release/scripts/aamp-npm-release.mjs
```

Generated one-click startup commands omit `--agent` so the Task Agent installer
opens its interactive multi-select and lets the user choose one or more detected
agents. The helper still accepts `--agent` as a deprecated compatibility option,
but it does not change printed startup commands. The removed `trae` type is not
accepted.

## Release model

- Source versions are the release version truth. First run `--prepare-source`,
  review and test the source changes, and commit them. Pack and publish then
  reuse those exact source versions and never increment again.
- Trial from stable `x.y.z` defaults to `x.y.(z+1)-dev.0`. `--bump minor`
  and `--bump major` select the next minor or major line. Trial from
  `x.y.z-dev.N` always becomes `x.y.z-dev.(N+1)`. Trial source sequencing is
  independent of npm/BNPM identities and independent of any remote max version.
- When an explicitly requested release line must be aligned across packages,
  `--prepare-source --version key=x.y.z-dev.N` may set that package's exact
  trial source version. This is a deliberate source-preparation exception, not
  a pack/publish override: the exact version is written to source, reviewed and
  committed first; subsequent pack/publish commands must omit `--version` and
  reuse the committed source versions. It is appropriate for adopting an
  already-published dependency version as a Task Agent pin while publishing
  only the missing packages.
- Final keeps the existing mode name `final`. Final preparation requires
  `npm whoami` on the public npm registry to be exactly `larktask`, plus
  `--bump patch|minor|major`. From `x.y.z-dev.N`, `patch` becomes `x.y.z`,
  `minor` becomes `x.(y+1).0`, and `major` becomes `(x+1).0.0`. From a stable
  source version, final preparation applies a normal semver bump.
- Personal local trial: after source preparation and commit, create local
  `.tgz` artifacts under the authenticated user's npm scope. Do not publish.
- Personal remote trial: publish AIME to BNPM and other packages to the
  authenticated user's public npm scope, for example `@luckyterry`, with
  `tag=dev`. Public npm scope comes from public `npm whoami`.
- Official stable: prepare deterministic stable source versions with
  `--mode final --prepare-source --bump ...`, commit them, then publish AIME to
  BNPM and `@larktask` packages to public npm with `tag=latest`.

Do not rewrite repository source package names for personal packages. Source
preparation changes versions, lockfiles, and Task Agent source pins only.
Package `package.json.name` stays canonical in source; only versions change.
The helper may rename staged package `package.json` / lock identity to the
target name, but source Task Agent pins, staged Task Agent pins, and packed tgz
Task Agent pins must stay identical.

## Two-phase release contract

Mutating `aamp-npm-release` and `aamp-local-release` runs use one shared release lock
under the Git common directory. Run them serially. Concurrent mutating runs fail fast
with the live owner details.
`--help` and `--plan-only` do not take the lock.

1. Run the helper with `--prepare-source` and the exact package selection.
   It computes every version before writing package/lock versions and
   actual release Task Agent pins. It does not build, stage, pack, publish, commit,
   or push.
2. Review the source diff and run the relevant tests and builds.
3. Commit the implementation and prepared source versions.
4. Run the same package selection with `--pack` or `--publish`. The helper
   must use the exact source versions. If a target version already exists,
   stop instead of silently computing another version.
5. Publish dependencies before Task Agent, verify registry metadata and
   tarballs, then share the one-click command.

If publishing partially succeeds, retain the prepared source versions and rerun
the original package selection with `--resume-publish --confirm-publish`. The
helper repacks the same reviewed sources, verifies already-published artifacts,
preserves the original Task Agent dependency-pin plan, and publishes only
missing packages. If only artifact propagation timed out, use
`--verify-published` with the original selection. Do not run `--prepare-source`
again for a registry, authentication, or propagation error.

`aimeAcp` is a separate release target from the public npm packages. Public npm
and BNPM identities are independent:

- AIME ACP always publishes to `https://bnpm.byted.org`, tag `dev` for trials
  and `latest` for finals, with target name `@<bnpm whoami>/aime-acp`.
- Public ACP / Feishu / Task Agent trial packages always publish to the
  authenticated user's public npm scope, `https://registry.npmjs.org/`, tag
  `dev`.
- Public final packages always publish to `@larktask` on
  `https://registry.npmjs.org/`, tag `latest`, and require `npm whoami` to be
  `larktask`.

Never publish AIME ACP to the public npm registry or public AAMP packages to
BNPM. `--scope` is assertion-only and, when present, must equal
`@<public npm whoami>`. `--aime-scope` is assertion-only and, when present,
must equal `@<bnpm whoami>`. `--aime-registry https://bnpm.byted.org` remains
accepted only as the canonical compatibility flag. Selecting `aimeAcp`
automatically includes `taskAgent`, because the Task Agent bootstrap must pin
the same AIME ACP target version and registry.

AIME keeps using the shared `$HOME/.aamp/npm-global` prefix while it is under
active development. The installer removes the obsolete unscoped
`aime-acp` package and conflicting `bin/aime-acp` entry, then runs the scoped
package's `lib/node_modules/<resolved-aime-scope>/aime-acp/dist/bin.js` directly. Do not
install or publish the unscoped `aime-acp` package.

## Choose packages from the change set

Before packing or publishing, decide which npm packages are actually affected:

- `packages/aamp-acp-bridge/**` changed: pass `--package acpBridge`. The helper
  automatically includes `taskAgent` so the one-click script pins the new ACP
  bridge version.
- `packages/aime-acp/**` changed: pass `--package aimeAcp`. The helper
  automatically includes `taskAgent`, pins the AIME ACP package and its BNPM
  registry in the staged Task Agent bootstrap, and publishes AIME ACP to its
  own registry.
- `packages/aamp-feishu-bridge/**` changed: pass `--package feishuBridge`. The
  helper automatically includes `taskAgent` so the one-click script pins the new
  Feishu bridge version.
- `packages/aamp-feishu-task-agent/**` changed: pass `--package taskAgent`.
- Multiple package paths changed: pass one `--package` per changed package.
- Only docs, skills, or unrelated files changed: do not assume npm packages are
  needed; ask the user before packing or publishing.

Use `--package all` only when all four packages changed or the user explicitly
asks for all packages. If the changed package set is unclear, ask the user which
package(s) to release before running the helper. The helper rejects real
pack/publish runs without an explicit `--package`; `--plan-only` may omit it
only when you intentionally want to inspect all package versions.

## Agent workflow

1. Inspect repository state and identify the intended worktree. Preserve
   unrelated dirty files and untracked `.tgz` artifacts.
   Determine the changed package set from relevant `git diff --name-only` /
   `git status --short` output, then pass the matching `--package` flags.
2. Resolve an authenticated npm-compatible package manager by running the
   helper; it prefers logged-in `pnpm` and falls back to logged-in `npm`.
3. If the user has not specified the release type, ask whether this is a
   personal trial or official stable release. Recommend personal remote trial
   for validation and official stable only after validation passes.
4. For official stable releases, confirm the intended bump (`patch`, `minor`,
   or `major`) and verify the public npm identity is `larktask`.
5. Run the helper with non-interactive flags. The helper computes remote
   versions, builds package `dist` output where needed, stages rewritten
   packages, packs tgz artifacts, publishes if requested, and verifies npm
   metadata after publish.
6. Public npm publishing must use npm browser authentication. Run publish
   commands in a TTY, do not pass `--otp`, and keep `auth-type=web` so npm can
   print its authentication URL. BNPM uses the already-authenticated internal
   npm credentials for its fixed registry; never send credentials in chat.
7. If npm asks for a 6-digit OTP instead of printing a browser auth URL, stop
   and rerun in browser-auth mode/TTY. Do not request or pass OTP codes.
8. Only report remote commands after publish succeeds and npm metadata confirms
   every package version is visible.
9. For local-only packages, report the local tgz startup command printed by the
   helper.
10. In the final reply after a successful pack or publish, include a compact
    release summary with these exact sections in this order:
    1. Upgrade information: repeat every source `name@version -> target
       name@version` from the helper's `version plan`. Link each target package
       to its npm versions page using Markdown:
       `[target name@version](https://www.npmjs.com/package/<target name>?activeTab=versions)`.
    2. One-click startup command: use the remote one-click command for published
       packages, or the local tgz startup command for local-only packages. Do not
       append `--agent`; let the installer open its interactive multi-select.
    3. Follow-up start command: include `feishu-task-agent start` and the
       `$HOME/.aamp/bin/feishu-task-agent start` fallback.

## Helper commands for agents

Prepare trial source versions before any trial pack or publish:

```bash
node .agents/skills/aamp-npm-release/scripts/aamp-npm-release.mjs \
  --mode trial \
  --package aimeAcp \
  --package acpBridge \
  --package taskAgent \
  --prepare-source
```

After this command, review and test the source changes, then commit them.
Use `--bump minor` or `--bump major` only when a selected stable source
package should start a non-patch development line.

Source example:
- `1.2.3 -> 1.2.4-dev.0`
- `1.2.3-dev.7 -> 1.2.3-dev.8`
- The helper does not look at remote `dev.N` maxima when computing the next
  source version.

Prepare final source versions from source only:

```bash
node .agents/skills/aamp-npm-release/scripts/aamp-npm-release.mjs \
  --mode final \
  --bump patch \
  --package acpBridge \
  --package taskAgent \
  --prepare-source
```

Final source example:
- `1.2.3-dev.7 --bump patch -> 1.2.3`
- `1.2.3-dev.7 --bump minor -> 1.3.0`
- `1.2.3 --bump patch -> 1.2.4`

Resume a partial publish without changing versions or dependency pins:

```bash
node .agents/skills/aamp-npm-release/scripts/aamp-npm-release.mjs \
  --mode trial \
  --pm npm \
  --package aimeAcp \
  --package acpBridge \
  --package taskAgent \
  --resume-publish \
  --confirm-publish
```

Plan personal trial versions without building:

```bash
node .agents/skills/aamp-npm-release/scripts/aamp-npm-release.mjs \
  --mode trial \
  --plan-only
```

Pack personal local trial packages:

```bash
node .agents/skills/aamp-npm-release/scripts/aamp-npm-release.mjs \
  --mode trial \
  --package feishuBridge \
  --pack
```

Publish personal remote trial packages:

```bash
node .agents/skills/aamp-npm-release/scripts/aamp-npm-release.mjs \
  --mode trial \
  --package feishuBridge \
  --publish \
  --confirm-publish
```

For audited releases, `--scope` and `--aime-scope` may assert the expected
identities. Each assertion must equal the corresponding registry's current
`whoami`; omit both flags in normal operation.

Use additional `--package` flags when multiple packages changed. The helper
accepts `aimeAcp`, `acpBridge`, `feishuBridge`, `taskAgent`, and `all`, plus package-name
aliases such as `aamp-feishu-bridge`.

Source preparation writes actual Task Agent source pins:
- Selected public packages are pinned with the actual public target scope and
  version.
- Selected AIME is pinned with the actual BNPM target scope, version, and
  `https://bnpm.byted.org`.
- Unselected ACP / Feishu / AIME pins must stay semantically unchanged and must
  still resolve in their encoded registries.
- `AAMP_TASK_AGENT_NAME` in Task Agent source becomes the actual public target
  package name when `taskAgent` is selected.
- Trial source preparation freezes `AAMP_TASK_AGENT_CHANNEL` and Task Agent
  self-install references in bootstrap/controller/README to `dev`.
- Final source preparation freezes `AAMP_TASK_AGENT_CHANNEL` and Task Agent
  self-install references in bootstrap/controller/README to `latest`.

Pack / publish / resume never increment versions or rewrite pins. If a target
version already exists at pack/publish time, fail and instruct the user to run
`--prepare-source` again only when a new source version is actually needed.

Pack the complete AIME ACP chain locally:

```bash
node .agents/skills/aamp-npm-release/scripts/aamp-npm-release.mjs \
  --mode trial \
  --pm npm \
  --aime-registry https://bnpm.byted.org \
  --package aimeAcp \
  --package acpBridge \
  --package taskAgent \
  --pack
```

Publish the complete AIME ACP trial chain. This deliberately uses two
registries: AIME ACP goes to BNPM, while ACP Bridge and Task Agent go to public
npm. Run it in a TTY so npm browser authentication can complete:

```bash
node .agents/skills/aamp-npm-release/scripts/aamp-npm-release.mjs \
  --mode trial \
  --pm npm \
  --aime-registry https://bnpm.byted.org \
  --package aimeAcp \
  --package acpBridge \
  --package taskAgent \
  --publish \
  --confirm-publish
```

Publish official stable source versions after explicit bump confirmation:

```bash
node .agents/skills/aamp-npm-release/scripts/aamp-npm-release.mjs \
  --mode final \
  --pm npm \
  --package all \
  --prepare-source \
  --bump patch
```

After testing and committing those stable source versions, run the same
selection with `--tag latest --publish --confirm-publish` and without
`--prepare-source`. Final preparation rejects `--version`; use `--bump patch`,
`--bump minor`, or `--bump major` instead.

Remote publish uses `npm` web auth only. Pass `--pm npm` for publish commands
or let the helper auto-detect; it will prefer `npm` when publishing. Local
planning/packing can still use an authenticated `pnpm` or `npm`.

Pass `--allow-dirty` only after explaining which tracked files are dirty and why
they are in scope for this package attempt.

The helper has an interactive `--wizard` mode for manual debugging, but it is
not the normal agent workflow. Prefer asking the user in chat and executing the
non-interactive command yourself.

## Safety rules

- Always report package manager, `whoami`, target scope, tag, and version plan
  before publishing. After success, repeat the version plan as the final
  reply's upgrade information.
- If no authenticated package manager is available, ask the user to run
  `npm login` or `pnpm login`; do not request credentials directly.
- For remote publish, run the helper from a TTY so public npm can print and open
  its browser auth URL. BNPM reuses existing internal npm authentication.
- Never ask the user for an npm 6-digit OTP and never pass `--otp`; public npm
  uses browser auth, and BNPM credentials stay local.
- Never publish without `--confirm-publish`.
- Preserve existing local `.tgz` artifacts unless the user asks to remove them.
- For personal trial mode, stable `x.y.z` source versions become
  `x.y.(z+1)-dev.0`; an existing `x.y.z-dev.N` becomes `x.y.z-dev.(N+1)` from
  source only.
- Ordinary pack/publish never increments or accepts `--version`. It rejects
  an existing target and requires a new source preparation.
- Before pack/publish, package/lock versions and all selected prepared-source Task
  Agent pins must still match the prepared source. Treat drift as a broken
  release and stop before build or staging.
- For Task Agent releases, the packaged bootstrap script's
  `AAMP_TASK_AGENT_VERSION` must match the target Task Agent package version.
  Treat any mismatch as a broken package and do not share its one-click command.
- If a raw tarball URL can be fetched but `npm view <package>@<version>` returns
  404, treat the package as not published. Re-run publish after npm auth
  succeeds; do not use that tarball URL as release evidence.
