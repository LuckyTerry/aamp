# AIME Feishu Task end-to-end release gate

Status: **BLOCKED / NOT RUN**.

This is a release-gate report, not a live test result. No Feishu Task, AIME
authentication, `doctor`, deployment, pairing, task cancellation, or existing
bridge process was contacted in this run.

`aamp-feishu-task-bridge` is deprecated. The current implementation boundary
is the merged `aamp-feishu-bridge` package; this report does not use the
deprecated package as a runtime, artifact, or deployment target.

## Evidence that is available

| Component | Verified identity | Evidence scope |
| --- | --- | --- |
| `aime-acp` final candidate | `0.1.0`; tarball SHA-256 `723c15fa63e28d68c2621b859af7f25b2b7115c2aad01d01843c7b30105cf8b1`; npm shasum `fdfb89fa5abf7ffadbcd78a9225e2a5dfed5a89f`; integrity `sha512-pQUImtXGIdYiO6hi1+KrOtJRBC1Kn4M46pDd3+oVgWrzkK/2C1sWKz6OwnAVARBHtVAglfjJTrKHyMZ9LotSZQ==`; 66 entries, 60421 bytes, 286665 unpacked bytes | Two matching fresh package builds on 2026-08-14; packaged generic proof only. |
| Generic AAMP/ACP bridge | `@zengxingyuan/aamp-acp-bridge@0.1.28-dev.21`; production bridge source `b3c43ae9e2c3a8d8fa14ef4ef207e09cb079305d`; AIME core source `17119558e9df225707e288320b2fea2a1baaa5bf` | Deterministic packaged proof; not a deployed binding identity. |
| ACP runner | `acpx@0.11.2` | A05 clean-project proof. |
| AIME Node API | `@bytedance-dev/bytedcli@0.123.0` | A05 installed package proof; no global CLI was used. |
| One-click Feishu bridge | `@zengxingyuan/aamp-feishu-bridge@0.1.51`; integrity `sha512-kWm+jqc7wBzTjbaYuAxmjUVK4PPzJUm7h7TqCiW6PzjAR8WyxjLDsQ8qWKf3AReBnFxJ+eKsEBc6Pt80/VG35A==`; shasum `7b7864c3e40a255f64f078f07257b17d2c425a85` | A06 registry artifact evidence. |
| Feishu artifact-reproducing source | `d75dd15f1979f9b6bc5b2a3fe22a6610894f902f` | A06 rebuilt 96 `dist/**` paths and matched all 96 registry paths byte-for-byte. |
| Feishu registry metadata | `gitHead=2ef97ddcdc9f604b262c5e7683963451cab8b673` | Metadata only: its package rebuild identifies as `0.1.49` and differs from the 0.1.51 artifact in 14 of 96 `dist/**` paths. It is not the artifact source. |

The current worktree's `aamp-feishu-bridge@0.1.52` is later/unpublished
comparison only. It is not evidence for the 0.1.51 one-click artifact or a
live deployment.

The final candidate identity above corrects a stale package pin. Six
production AIME source commits landed after that pin and before this task;
two fresh current-source packs matched the identity shown above. The AIME
artifact identity is unchanged; the ACP Bridge provenance now points to the
final production source shown in the table.

## Generic proof versus this release gate

**Generic AAMP candidate evidence: COMPLETE.** A05 ran a real package lifecycle,
clean install, real `acpx@0.11.2`, real `AcpxClient`, and real generic
`AgentBridge`. Its AIME and AAMP boundaries were deterministic test fakes. The
packaged proof passed 4/4 and covered streaming, HELP continuation, attachment
rejection, cancellation, same-session serialization, and the remote first-turn/
follow-up prompt contract with zero owned-process cleanup. Its successful fake
responses use the real visible nested `AAMP_RESULT_JSON` /
`FEISHU_TASK_RESULT_JSON` contract. The installed generic bridge emits the
inner marker as `task.result.output`, and the merged Feishu production
classifier selects the `answered`, Bridge-comment-required, Task-completion
disposition for both normal same-session turns. This is deterministic
parser/disposition evidence, not a live Feishu comment or status write.

That evidence proves a generic candidate contract. It is not evidence of a
Feishu Task event, a managed-user AIME session, an approved tenant, deployed
one-click configuration, user-visible comment/status, or real Feishu/AIME
end-to-end chain.

## Required AIME binding for an approved test deployment

The approved isolated deployment must record this agent object exactly (plus
the separately approved non-secret host, sender policy, and artifact identity):

```json
{
  "name": "aime",
  "acpCommand": "aime-acp",
  "executionLocation": "remote",
  "attachmentPolicy": "reject",
  "taskDispatchConcurrency": 1
}
```

This JSON was **not** applied to a live deployment in this run. Current
one-click metadata/controller deterministic coverage supplies the explicit
`attachmentPolicy: reject` and concurrency-one values for AIME; the packaged
generic proof independently verifies rejection before download or ACP dispatch.
Those deterministic checks do not prove that an approved live deployment is
running the same configuration.

## Remote execution-location gate

Status: **NOT RUN**.

The exact approved live scenario is:

```text
总结一下 lark mind 群昨天的消息
```

Acceptance requires a completed first turn, a completed follow-up on the same
stable remote AIME session, and a comment/status written only by the local
Feishu Bridge. The remote Agent must use its own remote-native Feishu/Lark
identity for reads; it must not need local `lark-cli`, local OAuth, a local
profile, caller path, App Secret, or raw ACP command. Incoming remote
attachments and local file delivery are unsupported; text and HTTP(S) links
are the supported output forms. AIME `auth` or `doctor` readiness does not
prove access to this group. This gate remains NOT RUN until that exact live
chain is observed with an approved deployment identity.

## Scenario matrix

| Scenario | Required observable chain | Result | Reason / evidence location |
| --- | --- | --- | --- |
| `text` | Feishu Task event → `task.dispatch` → ACP/AIME session → streamed `text.delta` → user-visible Task comment/status → outer `task.result` → completed Task | **NOT RUN** | No approved Feishu Task deployment identity/tenant, no approved AIME managed-user test auth/site, and no authorized test binding. No event IDs, hashes, or logs exist. |
| `HELP / reply` | AIME asks for help → Feishu comment plus waiting status → user reply → new dispatch with the same `feishu-task:${guid}` session key → restored AIME/ACP session → final comment and completed Task | **NOT RUN** | Same deployment/auth/tenant blockers. The published 0.1.51 source maps the paths, but its direct `task.help_needed` handler is source-mapped rather than directly tested. |
| `attachment rejection` | Harmless attachment → `task.help_needed` before blob download, temp directory, ACP prompt, or AIME session/message → visible comment/waiting status; sanitized logs have no filename or temporary path | **NOT RUN** | Deterministic one-click and packaged gates cover the explicit reject policy and pre-download rejection, but no approved live deployment mapping or visible Feishu comment/waiting-status chain was exercised. |
| `cancel` | Not a v0.1 Feishu/AAMP release scenario. If a future release claims cancellation, it must prove Feishu Task cancel → AAMP active-task map → `AcpxClient.cancel` → ACP `session/cancel` → no late completed/rejected result → drained/reusable session. | **UNSUPPORTED / NOT RUN** | The merged 0.1.51 Feishu bridge has no `task.cancel` handler or forwarding path. Cancellation is scoped out of the v0.1 Feishu/AAMP claim; generic direct ACP/acpx cancellation evidence does not change that. |

No scenario timestamp, Task ID, session ID/hash, tenant, account, pairing value,
attachment name, or log location is recorded because none was run.

## Safe prerequisites to unblock

1. Supply an approved isolated Feishu Task test deployment identity: tenant,
   Task Agent/Feishu bridge artifact or image, semantic version, source/build
   ID, startup protocol version, and authorized test sender/bot policy. Do not
   substitute an already-running local bridge.
2. Supply an approved isolated AIME managed-user test home and supported site,
   with authorization for the controlled auth flow. Run `auth status` and
   `doctor` only inside that approved environment; they are prerequisites, not
   acceptance.
3. Configure and retain the exact binding JSON above, particularly
   `attachmentPolicy: reject` and `taskDispatchConcurrency: 1`; capture only
   non-secret configuration confirmation.
4. Run text, HELP/reply, and attachment-rejection scenarios with unique benign
   nonces. Save only redacted timestamps, component versions, event/task/session
   salted short hashes, status transitions, and safe log locations.
5. Cancellation is scoped out of the v0.1 Feishu/AAMP claim. Only if a future
   release claims support must it add and demonstrate the full forwarding chain;
   a direct generic ACP/acpx cancellation test is not a substitute.

## Redaction and retention rules

Persist only version strings, artifact hashes/integrities, Git/build IDs, safe
event/task/session salted short hashes, timestamps, scenario status, and
redacted log/report paths. Do not persist or publish any task body, prompt,
response, attachment contents or filename, local/temporary path, raw tool
payload, tenant/account/user identity, mailbox address, credentials, token,
cookie, pairing URL/code, auth payload, or raw session ID. Delete owned raw
smoke logs after extracting the redacted evidence.

## Release decision

**Generic AAMP candidate evidence: COMPLETE.**

**Feishu/AIME v0.1 production release: BLOCKED.** Release blockers:
deployment/tenant, managed-user auth/site, exact explicit binding, and required
text/HELP-reply/attachment/final comment-status live scenarios not run.
Cancellation is scoped out of this v0.1 claim, not a current release blocker.
This report does not claim end-to-end acceptance, deployment, publication, or
production readiness.
