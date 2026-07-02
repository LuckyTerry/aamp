# aamp-feishu-task-bridge

Local bridge daemon for dispatching Feishu task events to a target AAMP Agent.

## Shape

This package is intentionally thin:

- Feishu task event -> AAMP `task.dispatch` -> target Agent
- AAMP `task.ack` -> one default Feishu task comment
- AAMP `task.help_needed` -> one Feishu task comment with the help question,
  then mark the Feishu task and child tasks blocked/waiting for human input
- AAMP `task.stream.opened` + stream events -> mark the Feishu task and child
  tasks in progress on the first effective event; selected stream events are
  throttled into Feishu task steps on the parent task
- AAMP `task.result` -> parse `FEISHU_TASK_RESULT_JSON`, write result outputs
  as comments, text deliveries, or task_delivery attachments, then complete or
  block child tasks before the parent task
- `card.*`, cancel, and delete are not consumed by this bridge

The bridge dispatches only trusted task execution triggers from
`task.task.update_user_access_v2`:

- `task_create`
- `task_comment_create`
- `task_comment_reply`
- `task_comment_update`
- `task_reminder_fire`

Other task update event types are recorded as ignored and are not dispatched.
After loading the task, the bridge also owns execution filtering that used to
live in the event producer: task execution events no longer require current-app
assignee metadata and do not suppress deleted or hidden tasks. Completed or
archived task statuses are still ignored. Comment events require a latest
non-empty comment, skip comments explicitly authored by the configured Feishu
app (`comment.creator.type=app` and `comment.creator.id` equals the configured
Feishu app id), and trust human comments only when `comment.creator.id` equals
the configured Feishu app owner returned by
`GET /open-apis/application/v6/applications/:app_id` with the configured
`user_id_type`; rejected human comments receive one app-authored permission
notice per comment. Non-current-app app comments remain effective. Only after
this author gate does the bridge load task details and dispatch when the loaded
`agent_task_status` is in an execution-relevant state.

The dispatched prompt treats handled Feishu events as execution of an existing
Feishu task, not as a plain chat question. It carries
`source=feishu-task`, task guid/id/status, event id/types, event kind, and
whether the task has children in dispatch context. The dispatched `bodyText`
is also sent as `rawBodyText`; it contains only Feishu task context facts: the
parent task text, source message context from `origin.refer_resources`, detected
source Feishu document links, child task text, loaded task comments, latest
effective comment, and event metadata. This lets the target Agent infer intent
directly without installing a Feishu task skill.

For ACP agents, the bridge also sends `promptRules` on `task.dispatch` so
`aamp-acp-bridge` replaces its default task rules with a complete Feishu task
rule prompt. Feishu execution constraints, environment-switch commands, result
schema, and deliverable rules live in `promptRules`, not in `bodyText`. This
keeps task context focused while preventing Feishu task events from being
treated as simple direct-answer questions. Current-task flow writes are owned by
the bridge:

- Do not write current-task comments, status, steps, or deliverables directly.
- The bridge marks parent and child tasks in progress from stream events.
- The bridge writes `reply_comment`, `link_delivery`, `file_delivery`, and
  `text_delivery` outputs to the parent task.
- The bridge completes or blocks parent and child tasks after parsing the final
  result.

The final result must be an `AAMP_RESULT_JSON` object containing only `output`,
and `output` must start with `FEISHU_TASK_RESULT_JSON:` followed by compact JSON:

```text
AAMP_RESULT_JSON: {"output":"FEISHU_TASK_RESULT_JSON: {\"schema\":\"feishu_task_result.v2\",\"status\":\"succeeded\",\"summary\":\"...\",\"outputs\":[{\"kind\":\"reply_comment\",\"content\":\"...\"}]}"}
```

Use `status=succeeded` when the bridge should write one or more outputs and
complete the Feishu task flow. Supported outputs are:

- `reply_comment`: write a Feishu task comment with `content`.
- `link_delivery`: append `url` to parent task `text_deliveries`.
- `file_delivery`: upload an absolute local `path` as a `task_delivery`
  attachment.
- `text_delivery`: write `content` with `format=markdown` or
  `format=plain_text` to a temporary file and upload it as `task_delivery`.

Use `status=need_help` when human input is required before continuing. Use
`status=failed` for exceptional execution failures; the bridge still completes
the Feishu task flow after writing the failure comment.

Default ACK comments are scenario-specific:

- `task_create`: `已收到任务派发请求，正在转交智能体处理。`
- `task_comment_*`: `已收到您的回复，正在转交智能体处理。`

When the target Agent returns a `HELP:` response, `aamp-acp-bridge` converts it
to `task.help_needed`. This bridge writes the help `question` body back to the
Feishu task exactly once for the corresponding AAMP task id, then marks the task
and child tasks blocked/waiting for human input. When the target Agent returns
`task.result`, the bridge applies v2 `FEISHU_TASK_RESULT_JSON` outputs and then
completes or blocks the Feishu task flow. Rejected or malformed results are
treated as failures and completed with an error summary.

## Usage

```bash
cd ../sdks/nodejs
npm install
npm run build

cd ../aamp-feishu-task-bridge
npm install
npm run build

node dist/index.js init \
  --aamp-host https://meshmail.ai \
  --target-agent agent@meshmail.ai \
  --app-id cli_xxx \
  --app-secret xxx
```

For ByteDance BOE debugging, start the bridge with runtime-only overrides:

```bash
node dist/index.js start \
  --boe \
  --env boe_task_event
```

For ByteDance PRE + PPE debugging, start the bridge with runtime-only overrides:

```bash
node dist/index.js start \
  --pre \
  --env ppe_task_event
```

For PPE debugging on the normal configured domain, omit `--pre`:

```bash
node dist/index.js start --env ppe_task_event
```

Environment mode behavior:

- `--boe --env boe_task_event`: uses `https://open.feishu-boe.cn`, sends
  `x-tt-env: boe_task_event`, and tells the target agent to run
  `source ~/lark-env.sh boe --boe-env-name boe_task_event`.
- `--pre --env ppe_task_event`: uses `https://open.feishu-pre.cn`, sends
  `x-use-ppe: 1` and `x-tt-env: ppe_task_event`, and tells the target agent to
  run `source ~/lark-env.sh pre --ppe-env-name ppe_task_event`.
- `--env ppe_task_event`: keeps the configured/default domain, sends
  `x-use-ppe: 1` and `x-tt-env: ppe_task_event`, and tells the target agent to
  run `source ~/lark-env.sh --ppe-env-name ppe_task_event`.

Environment mode flags (`--domain`, `--boe`, `--pre`, `--env`) are runtime-only.
They are applied to the current `start` process but are not persisted in
`config.json`.

`init` writes the config and starts the local bridge immediately. Use
`--no-start` when you only want to write the config.

If the target Agent prints a pairing URL:

```bash
node dist/index.js init \
  --pairing-url "aamp://connect?mailbox=agent@meshmail.ai&pair_code=abc123" \
  --app-id cli_xxx \
  --app-secret xxx
```

The bridge sends `pair.request` with
`dispatchContextRules={ "source": ["feishu-task"] }`.

## Options

- `--event-name NAME`: register a Feishu event name. Can be repeated.
- `--boe`: use ByteDance BOE OpenAPI domain.
- `--pre`: use ByteDance PRE OpenAPI domain.
- `--env NAME`: add `x-tt-env: NAME` to Feishu OpenAPI requests. With `--pre`
  or without `--boe`, also add `x-use-ppe: 1`.
- `--debug`: print detailed logs and write detailed ACK comments.
- `--task-api-version v1|v2`: choose Feishu task API version. Defaults to `v2`.
  When v2 lookup/comment fails, the OAPI client tries the v1 task API as a
  fallback because the currently generated SDK task events expose v1
  `task_id`.
- `--no-ack-comment`: disable the default Feishu comment on AAMP `task.ack`.
- `--config-dir DIR`: use a custom config/state directory.

Default event name is `task.task.update_user_access_v2`. The event normalizer
requires `event_id` and accepts `task_guid`, `guid`, `task_id`, `resource_id`,
or `object_id` as the task identifier.
