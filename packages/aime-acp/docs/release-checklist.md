# aime-acp release checklist

Record evidence in an approved release report. A checked box requires the
named artifact and command output; startup or authentication alone is not an
end-to-end result.

## Artifact identity

- [ ] Git revision: `<full commit>`
- [ ] Node/npm/platform: `<versions and platform>`
- [ ] Registry: `https://bnpm.byted.org`
- [ ] Package: `tengchengwei-aime-acp-<version>.tgz`
- [ ] Tarball SHA-256: `<sha256>`
- [ ] `npm pack --json` integrity: `<integrity>`
- [ ] Published `dist.integrity`: `<not published until approval>`
- [ ] Exact dependencies: `@bytedance-dev/bytedcli@0.123.0`,
      `@agentclientprotocol/sdk@0.28.1`, and smoke client `acpx@0.11.2`

## Local deterministic gates

- [ ] `npm run format`
- [ ] `npm run check`
- [ ] `npm run build`
- [ ] `npm run verify:package`
- [ ] `node test/smoke/fake-acpx.mjs`
- [ ] `npm pack --json --registry=https://bnpm.byted.org`
- [ ] The packed allowlist is only `LICENSE`, `README.md`, `dist/**`, and
      `package.json`; no tests, source, logs, credentials, or generated reports.
- [ ] Fake acpx emitted strict ordered JSON containing thought, plan, tool
      create/update, and final text exactly `AIME_ACP_OK` with no sentinel leak.
- [ ] The fake child PATH contained no global `bytedcli`; injection used only
      the test loader and the installed tarball.

## Credentialed AIME gates: cn

- [ ] Approved isolated managed-user `auth status`/browser `auth login` ran
      without JWT, token argument, or token environment variable.
- [ ] `doctor --site cn --json` proved compatible, authenticated, and
      `aimeReachable` against the real API.
- [ ] `node test/smoke/auth-coexistence.mjs --site cn ...` completed with its
      operator-witnessed cleanup.
- [ ] `node test/smoke/real-aime.mjs --approve-real-aime-smoke --test-home <isolated-home> --tool-profile public-http-lookup` proved live
      delta/wait, fresh-process load and second turn, allowlisted safe tool
      create/update/final, timed cancel/drain/next prompt, and privacy scan.
- [ ] Only a salted short session hash remains; the raw local smoke log was
      deleted.

## Credentialed AIME gates: i18n-tt

- [ ] Approved isolated managed-user `auth status`/browser `auth login` ran
      without JWT, token argument, or token environment variable.
- [ ] `doctor --site i18n-tt --json` proved compatible, authenticated, and
      `aimeReachable` against the real API.
- [ ] `node test/smoke/auth-coexistence.mjs --site i18n-tt ...` completed with
      its operator-witnessed cleanup.
- [ ] The release-only real smoke proved the same live delta/load/tool/cancel
      and privacy contract for `i18n-tt`.
- [ ] Only a salted short session hash remains; the raw local smoke log was
      deleted.

## AAMP and Feishu Task end-to-end gate

- [ ] Record exact AAMP, Task Agent, Feishu Task bridge revisions and installed
      `aime-acp` tarball SHA-256.
- [ ] A real Feishu Task event routed to AIME, streamed progress/results back,
      forwarded cancellation to acpx, and produced the expected Task
      comment/status.
- [ ] Attachment rejection occurred before materialization and AIME dispatch
      concurrency remained pinned to one.

Do not call AAMP/Feishu support complete from package installation, auth,
doctor, ACP initialize, bridge startup, or deterministic fake results.

## Package-owner publish approval

- [ ] Present the full artifact identity, dry-run file list, both-site real
      AIME/auth results, AAMP/Feishu end-to-end report, and unresolved risks to
      the package owner.
- [ ] Package owner explicitly approved the exact tarball SHA-256.

Do not publish without explicit package-owner approval.

Only after approval:

```bash
npm publish tengchengwei-aime-acp-<version>.tgz --registry=https://bnpm.byted.org --tag latest
npm view @tengchengwei/aime-acp@<version> version dist.integrity --registry=https://bnpm.byted.org
```

Verify the registry version and match `dist.integrity` to the approved
artifact before announcing a release.
