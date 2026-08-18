# Feishu Task bridge contract for AIME

Status: release-candidate/source-and-artifact evidence only. This is not a
live Feishu Task acceptance result.

`aamp-feishu-task-bridge` is deprecated: its implementation has been merged
into `aamp-feishu-bridge`. This document intentionally does not treat the
deprecated package as an implementation, test, publication, or deployment
target.

## Identity and evidence boundary

| Item | Verified value | Meaning |
| --- | --- | --- |
| One-click package pin | `@zengxingyuan/aamp-feishu-bridge@0.1.51` | The bootstrap and controller both select this package by default. |
| Registry metadata `gitHead` | `2ef97ddcdc9f604b262c5e7683963451cab8b673` | Publisher-supplied registry metadata only; a fresh package-local-lock rebuild identified itself as `0.1.49` and differed from the `0.1.51` registry `dist/**` in 14 of 96 paths. |
| Artifact-reproducing tracked source | `d75dd15f1979f9b6bc5b2a3fe22a6610894f902f` | Package version `0.1.51`; its package-local lockfile builds a byte-for-byte match for all published `dist/**` files. |
| Registry artifact | npm integrity `sha512-kWm+jqc7wBzTjbaYuAxmjUVK4PPzJUm7h7TqCiW6PzjAR8WyxjLDsQ8qWKf3AReBnFxJ+eKsEBc6Pt80/VG35A==`; shasum `7b7864c3e40a255f64f078f07257b17d2c425a85` | `npm pack --ignore-scripts` retrieved 98 tarball files (168804 bytes, 938020 unpacked bytes). |
| Reproduction | `npm ci`, then `npm run build`, from the `d75…` package archive | 96 generated `dist/**` files vs. 96 registry `dist/**` files; 0 path or SHA-256 mismatches. |
| Worktree package | `0.1.52` at `e5bfb7f90856aee0c6491df4edbc0e0767324421` | Later/unpublished comparison only. Registry version listing ends at `0.1.51` and contains no `0.1.52`; the worktree is not evidence for the `0.1.51` artifact or a deployed identity. |
| Deployment mapping | **BLOCKED / NOT PROVIDED** | No approved non-secret Feishu Task test deployment identity (artifact/image, semantic version, Git SHA/build ID, startup protocol version) was supplied. A locally existing bridge process was neither contacted nor inspected. |

Do not conflate the registry `gitHead` with the artifact-reproducing source
commit. The former is registry metadata; the latter is the source used for the
release-candidate contract below. Ignored worktree `dist/**` was not used as
evidence.

## Event-to-Feishu contract at source `d75…`

| Input / condition | Source mapping | Feishu side effect | Coverage / qualification |
| --- | --- | --- | --- |
| `task_create`, reminder, or comment event | `src/task/events.ts:3-22`; `runtime.ts:1986-2062` | Reads Task context, constructs an AAMP task, and sends it to the selected target agent. Comment events are classified as `task_comment`. | `runtime.test.ts:803-843` covers unreadable-reply failure wording. |
| Initial dispatch or a user comment reply | `dispatch.ts:22-24, 445-463`; `runtime.ts:2008-2075` | AAMP task ID is event-specific, but session key is stable: `feishu-task:${guid}`. `dispatchContext.aamp_session_key` is the same value. Therefore every reply for the same Task GUID gets a new dispatch task ID but the same session key. | `dispatch.test.ts:159-165` directly asserts stable session context; the comment-result fixture is at `runtime.test.ts:845-890`. |
| `task.stream.opened` | `runtime.ts:1641-1653, 2096-2132` | Persists `streamId` and subscribes to the AAMP stream. | Stream tests below use the fake subscription; no live Feishu evidence. |
| `text.delta` | `runtime.ts:1213-1317, 2152-2209, 2270-2286` | Cleaned human-readable text is buffered and appended through `appendTaskSteps`; execution signals set Feishu `agent_task_status=2` / `正在执行`. | `runtime.test.ts:504-716`; API mapping `feishu.ts:643-647,655-658`. |
| `todo`, status/progress, error, or `tool_call` | `runtime.ts:73-75, 1260-1316, 2180-2204` | **Not a user-visible Task-step contract in 0.1.51.** `WRITE_STATUS_STREAM_TASK_STEPS=false` drops todo/status/error. `WRITE_TOOL_STREAM_TASK_STEPS=false` drops tool steps after they serve as internal text-boundary markers. | `runtime.test.ts:402-502,718-760` explicitly keeps tool calls and ACP-start markers out of Task steps. Do not describe these consumed updates as visible progress. |
| Direct AAMP `task.help_needed` event | `runtime.ts:1654-1663,2377-2419,2929-2967` | Adds the help question/comment (or oversized-comment fallback), marks bridge state `help_needed`, and patches Feishu `agent_task_status=3`, `待确认`. | Source-mapped but **directly untested** in the exact 0.1.51 task suite: its fake client registers a handler but does not emit this event. |
| AAMP outer `task.result.status=completed`; inner `FEISHU_TASK_RESULT_JSON.status=answered` | `runtime.ts:841-905,2421-2459,2792-2810` | If inner `reply_written=false`, writes the summary as a comment; then completes parent/children using `agent_task_status=4`, `执行完成`. | Directly covered by `runtime.test.ts:845-890`; completion API `feishu.ts:650-653,832-852`. |
| AAMP outer `task.result.status=completed`; inner `FEISHU_TASK_RESULT_JSON.status=succeeded` | `runtime.ts:888-892,2478-2508,2604-2654` | Applies structured `outputs` (`reply_comment`, `file_delivery`, `link_delivery`, `text_delivery`), then completes the Task. Inner `succeeded` without `outputs` is a final-protocol failure. | Direct result parsing/comment/delivery coverage is at `runtime.test.ts:898-1119`. |
| AAMP outer `task.result.status=completed`; inner `FEISHU_TASK_RESULT_JSON.status=need_help` or `needs_input` | `runtime.ts:894-895,2461-2475,2767-2790` | Converts the inner result into a help comment and Feishu waiting status (`agent_task_status=3`). | Source-mapped; the exact 0.1.51 task suite has no direct inner `need_help` / `needs_input` fixture. This is distinct from the direct AAMP `task.help_needed` event above. |
| AAMP outer `task.result.status=completed`; inner `failed`, missing/invalid final protocol, or a Feishu write failure | `runtime.ts:841-905,2511-2601,2812-2839` | Writes a brief failure comment and completes the Task status; internal bridge state is `failed` (or records a Feishu-write failure as completed). | Invalid/missing inner-final-protocol and write-failure cases are directly covered at `runtime.test.ts:1068-1209`. |
| AAMP outer `task.result.status=rejected` | `runtime.ts:841-848,2511-2601,2812-2839` | Treats the outer rejection as `agent_failed`, writes the failure comment, and completes the Feishu Task. | Source-mapped but **directly untested** in the exact 0.1.51 task suite; do not infer this coverage from inner-final-protocol tests. |
| `task.cancel` | Complete literal event search of `d75… -- packages/aamp-feishu-bridge` | **No handler, forwarding call, or `task.cancel` event exists in the 0.1.51 merged package.** | AIME cancellation must not be promised through this one-click artifact. The later worktree is outside this artifact contract. |

## Attachment boundary for AIME

The published `0.1.51` artifact mapping above is historical: that source
collects task, delivery, and child-task attachments, downloads up to 20, and
passes in-memory `AampAttachment` bytes to `aamp.sendTask`
(`runtime.ts:1897-1983,2016-2062` at `d75…`). It must not be presented as the
current candidate's remote attachment policy or as live deployment evidence.

Current deterministic one-click/controller/bootstrap coverage supplies
`attachmentPolicy: reject` and `taskDispatchConcurrency: 1` for AIME from the
shared metadata source. The bootstrap reads the same JSON metadata, and the
controller's tested ACP-init object contains both exact values
(`bin/agent-metadata.mjs:12-16`;
`bootstrap/aamp-feishu-task-agent-bootstrap.sh:4742-4750`;
`bin/feishu-task-agent-controller.mjs:1731-1739`;
`test/aime-one-click.test.mjs:549-560,635-647`). The generic ACP Bridge also
rejects configured attachments before task locking, stream creation, blob
download, or ACP calls (`agent-bridge.ts:1186-1192,1771-1797`;
`agent-bridge.test.ts:2321-2385`).

Separately, the current merged remote Feishu runtime rejects incoming
attachment metadata before download, AAMP, or ACP dispatch. Parent-task,
delivery, child-task, and child-delivery metadata all take this early
`REMOTE_ATTACHMENTS_UNSUPPORTED` path; deterministic tests assert zero
attachment downloads, AAMP tasks, stream handlers, and uploaded deliveries
(`runtime.ts:2218-2269`; `runtime.test.ts:1521-1585,1587-1653`). Rejection text
must name only the unsupported capability and never an attachment name,
credential, temporary path, or local path.

This proves configuration wiring and deterministic pre-dispatch behavior only.
Deployment mapping remains **BLOCKED / NOT PROVIDED**, and the live visible
Feishu attachment-rejection chain remains **BLOCKED / NOT RUN**. No approved
deployed artifact identity, real attachment event, Bridge-written help comment,
or waiting-status transition was observed, so this source contract does not
claim live deployment or end-to-end acceptance.

## Test result and known historical inconsistency

The exact artifact-mirror command was:

```sh
npm exec -- tsx --test src/task/*.test.ts
```

It ran 31 tests: 30 passed and one failed at
`runtime.test.ts:1213-1237`. The failing assertion expects
`dispatchContext.feishu_lark_cli_profile` to be absent. In the same `d75…`
commit, `dispatch.test.ts:149-157` explicitly requires that profile and binary
to be present, and the implementation does so. This is a stale contradictory
historical assertion, not a random failure or an artifact mismatch. The
separate non-runtime task suites passed 12/12. No historical source or current
production source was changed to make that assertion pass.

Consequently the artifact and source mapping are sufficient for a
release-candidate contract, but not for a live Feishu Task E2E signoff. The
deterministic AIME attachment configuration and pre-dispatch privacy behavior
are covered in current source. The unresolved gates are an approved deployment
identity, the live visible Feishu attachment-rejection chain (BLOCKED / NOT
RUN), and an explicitly supported cancellation path.
