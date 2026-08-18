# AIME packaged generic-bridge smoke

Status: PASS.

This proof packages the current `aime-acp`, installs the tarball and exact
`acpx` version in a clean project, and then exercises the installed executable
through the real generic ACP bridge. It does not use a globally installed
`bytedcli` or `acpx`.

The artifact table below records two matching fresh package builds on
2026-08-14. It supersedes the earlier candidate identity: six production
`packages/aime-acp/src` commits after the prior identity changed the packaged
bytes. The AIME artifact identity is therefore corrected to the current source,
while the ACP Bridge provenance advances to the final production source that
enforces the remote public and serialization boundaries.

## Verified artifact boundary

| Item | Verified value |
| --- | --- |
| `aime-acp` | `0.1.0` |
| `acpx` | `0.11.2` |
| `@bytedance-dev/bytedcli` | `0.123.0` |
| Production bridge source | `b3c43ae9e2c3a8d8fa14ef4ef207e09cb079305d` |
| AIME core source | `17119558e9df225707e288320b2fea2a1baaa5bf` |
| Tarball SHA-256 | `723c15fa63e28d68c2621b859af7f25b2b7115c2aad01d01843c7b30105cf8b1` |
| npm shasum | `fdfb89fa5abf7ffadbcd78a9225e2a5dfed5a89f` |
| npm integrity | `sha512-pQUImtXGIdYiO6hi1+KrOtJRBC1Kn4M46pDd3+oVgWrzkK/2C1sWKz6OwnAVARBHtVAglfjJTrKHyMZ9LotSZQ==` |
| Packed entries | `66` |
| Packed size | `60421 bytes` |
| Unpacked size | `286665 bytes` |

The pack lifecycle ran the package's real `prepack` checks and build. The
clean install resolved the CommonJS package lookup to its installed real
`bytedcli`, while a test-only external ESM loader supplied deterministic AIME
responses. The configured ACP command was the absolute installed executable;
the child `PATH` contained only bins from the clean project and its Node
runtime.

## Scenarios

- Text streaming preserved user correlation, thought, plan/step, running and
  completed tool updates, assistant chunks, and the waiting terminal. The
  bridge emitted ordered `text.delta`, `todo`, and `tool_call` events followed
  by one completed result.
- A normal first turn and follow-up on the same stable session each returned a
  visible `AAMP_RESULT_JSON` outer object whose `output` was a compact
  `FEISHU_TASK_RESULT_JSON` v2 `answered` result. The installed generic bridge
  removed the outer envelope and emitted the inner marker as
  `task.result.output`. The merged Feishu production classifier then classified
  both actual emitted results as `answered` with the exact summaries and
  `reply_written=false`, which selects Bridge-written comments followed by Task
  completion. This is parser/disposition evidence only; no Feishu write was
  performed.
- HELP used a new task ID with the same stable session key for continuation.
  The stream closed before one `task.help_needed`; continuation reused the same
  ACP process and remote AIME session without another remote create, then
  completed successfully.
- Attachment rejection sent one help response before stream or ACP dispatch.
  It performed no blob download, prompt, result, or ACP session-state growth.
- Cancellation traversed real `AcpxClient.cancel` and ACP `session/cancel`.
  The stream closed exactly as cancelled with no result. The fake remote drain
  exposed `waiting_for_next`; a new task ID on the same stable session then
  completed successfully.
- Same-session concurrency was configured to exactly one dispatch. While the
  first prompt stream was gated, the second task did not create a stream,
  ensure a session, send a remote message, or prompt ACP. It ran only after the
  first result completed, independently of acpx queueing.

The run observed 9 task streams, 7 results, 2 help responses, 6 remote creates
(one startup session plus five isolated scenario sessions), 9 remote sends,
and 1 remote cancel. Remote create IDs were unique across scenarios and stable
inside each continuation group. Observed terminal outcomes covered ACP
`end_turn` and bridge `completed`, `help_needed`, and `cancelled` paths.

## Safety and cleanup

The AAMP evidence, test-only transport trace, and complete captured bridge logs
were scanned for credential, workspace, raw-tool, and temporary-path
sentinels. No sentinel or local path was present. Every child operation had a
120-second boundary with TERM-to-KILL escalation, and cleanup verified zero
owned processes before removing the owned temporary root.

`npm run test:aime-packaged` passed 4 of 4 tests. The generic bridge's default
test command remains the lightweight suite; this network-backed packaged proof
is deliberately opt-in.

The remote AIME API and AAMP client in this proof are deterministic test fakes.
The package, clean install, `acpx`, ACP server process, and generic bridge are
real. This result is not live Feishu or live AIME acceptance. The packaged
prompt checks keep full prompt text only in deterministic test-process memory;
the recorded result contains only fingerprints and boolean contract evidence.
