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

- Personal local trial: create local `.tgz` artifacts under the authenticated
  user's npm scope. Do not publish. Use this when the user wants to test before
  remote publishing.
- Personal remote trial: publish to the authenticated user's npm scope, for
  example `@luckyterry`, with `tag=dev`. Use this for real-device validation
  before asking an official scope owner to publish.
- `@larktask` official prerelease: publish dev/prerelease versions under
  `@larktask`, with `tag=dev`.
- `@larktask` official stable: publish stable semver versions under
  `@larktask`, with `tag=latest`. Confirm each target version explicitly.

Do not rewrite repository source package names for personal packages. The helper
rewrites package names and internal bridge pins only in `.aamp-npm-release/`
staging directories.

## Choose packages from the change set

Before packing or publishing, decide which npm packages are actually affected:

- `packages/aamp-acp-bridge/**` changed: pass `--package acpBridge`. The helper
  automatically includes `taskAgent` so the one-click script pins the new ACP
  bridge version.
- `packages/aamp-feishu-bridge/**` changed: pass `--package feishuBridge`. The
  helper automatically includes `taskAgent` so the one-click script pins the new
  Feishu bridge version.
- `packages/aamp-feishu-task-agent/**` changed: pass `--package taskAgent`.
- Multiple package paths changed: pass one `--package` per changed package.
- Only docs, skills, or unrelated files changed: do not assume npm packages are
  needed; ask the user before packing or publishing.

Use `--package all` only when all three packages changed or the user explicitly
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
3. If the user has not specified the release type, ask a concise question with
   the four package-type choices above. Recommend personal remote trial for
   validation and official stable only after validation passes.
4. For official stable releases, ask the user or scope owner to confirm target
   stable versions. Do not blindly reuse a personal `-dev.N` version.
5. Run the helper with non-interactive flags. The helper computes remote
   versions, builds package `dist` output where needed, stages rewritten
   packages, packs tgz artifacts, publishes if requested, and verifies npm
   metadata after publish.
6. Remote publishing must use npm browser authentication only. Run publish
   commands in a TTY, do not pass `--otp`, and keep `auth-type=web` so npm prints
   an `https://www.npmjs.com/auth/cli/...` URL. Share that URL when the user must
   complete auth, press Enter to open it when available, then let the same
   publish process continue.
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

If the user identifies a personal scope, pass it explicitly:

```bash
node .agents/skills/aamp-npm-release/scripts/aamp-npm-release.mjs \
  --mode trial \
  --scope @luckyterry \
  --pm npm \
  --package feishuBridge \
  --publish \
  --confirm-publish
```

Use additional `--package` flags when multiple packages changed. The helper
accepts `acpBridge`, `feishuBridge`, `taskAgent`, and `all`, plus package-name
aliases such as `aamp-feishu-bridge`.

Publish official prerelease packages:

```bash
node .agents/skills/aamp-npm-release/scripts/aamp-npm-release.mjs \
  --mode trial \
  --scope @larktask \
  --pm npm \
  --package feishuBridge \
  --tag dev \
  --publish \
  --confirm-publish
```

Publish official stable packages after explicit version confirmation:

```bash
node .agents/skills/aamp-npm-release/scripts/aamp-npm-release.mjs \
  --mode final \
  --scope @larktask \
  --pm npm \
  --package all \
  --tag latest \
  --publish \
  --confirm-publish \
  --version acpBridge=0.1.29 \
  --version feishuBridge=0.1.52 \
  --version taskAgent=0.1.0
```

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
- For remote publish, run the helper from a TTY so npm can print and open the
  browser auth URL. In Codex desktop this means using a terminal tool call with
  TTY enabled.
- Never ask the user for an npm 6-digit OTP and never pass `--otp`; browser auth
  is the only supported publish flow for this skill.
- Never publish without `--confirm-publish`.
- Preserve existing local `.tgz` artifacts unless the user asks to remove them.
- For personal trial mode, non-dev source versions become `x.y.z-dev.N`, so
  trial packages do not look like final releases.
- If a target version already exists, the helper increments the matching
  `-dev.N` suffix. For final stable versions that already exist, stop and ask
  for an explicit version decision.
- For Task Agent releases, the packaged bootstrap script's
  `AAMP_TASK_AGENT_VERSION` must match the target Task Agent package version.
  Treat any mismatch as a broken package and do not share its one-click command.
- If a raw tarball URL can be fetched but `npm view <package>@<version>` returns
  404, treat the package as not published. Re-run publish after npm auth
  succeeds; do not use that tarball URL as release evidence.
