#!/usr/bin/env bash
set -euo pipefail

AGENT=""
APP_ID=""
APP_SECRET=""
BOT_NAME=""
LARK_CLI_PROFILE=""
ENV_NAME="online"
BOE_ENV_NAME="boe_task_event"
AAMP_HOST="https://meshmail.ai"
DEBUG_MODE="false"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"
NPM_CACHE_DIR="${NPM_CONFIG_CACHE:-${npm_config_cache:-${TMPDIR:-/tmp}/aamp-one-click-npm-cache}}"
NPM_GLOBAL_PREFIX="${NPM_GLOBAL_PREFIX:-$HOME/.aamp/npm-global}"
BOT_CONFIG_FILE="${BOT_CONFIG_FILE:-$HOME/.aamp/feishu-bridge/task-runtime/task-profiles-v2.json}"
CURRENT_RUN_FILE="${CURRENT_RUN_FILE:-$HOME/.aamp/feishu-bridge/task-runtime/runs/current.json}"
ACTIVE_RUNS_FILE="${ACTIVE_RUNS_FILE:-$HOME/.aamp/feishu-bridge/task-runtime/runs/active.json}"
BOT_RESERVATIONS_FILE="${BOT_RESERVATIONS_FILE:-$HOME/.aamp/feishu-bridge/task-runtime/runs/reservations.json}"
BOT_SELECTION_LOCK_DIR="${BOT_SELECTION_LOCK_DIR:-$HOME/.aamp/feishu-bridge/task-runtime/runs/selection.lock}"
AAMP_LARK_CLI_CONFIG_DIR="${AAMP_LARK_CLI_CONFIG_DIR:-${LARKSUITE_CLI_CONFIG_DIR:-$HOME/.lark-cli-aamp-one-click-v1}}"
AAMP_LARK_CLI_BOE_CONFIG_DIR="${AAMP_LARK_CLI_BOE_CONFIG_DIR:-$HOME/.lark-cli-aamp-one-click-boe-v1}"
CODEM_SERVER_URL="${CODEM_SERVER_URL:-https://codem.feishu.cn}"
CODEM_INSTALLER_URL="${CODEM_INSTALLER_URL:-https://sf-unpkg-src.bytedance.net/@byted-meego/codem-installer@latest/install.sh}"
CODEM_INSTALLER_CONFIRM="${CODEM_INSTALLER_CONFIRM:-}"
CODEM_PROVIDER_PREFLIGHT="${CODEM_PROVIDER_PREFLIGHT:-true}"
CODEM_PROVIDER_PREFLIGHT_TIMEOUT_SECONDS="${CODEM_PROVIDER_PREFLIGHT_TIMEOUT_SECONDS:-60}"
CODEX_APP_CLI="/Applications/Codex.app/Contents/Resources/codex"
CODEX_ACP_PKG="${CODEX_ACP_PKG:-@agentclientprotocol/codex-acp@1.0.2}"
LARK_REGISTER_APP_SDK="${LARK_REGISTER_APP_SDK:-@larksuiteoapi/node-sdk@1.68.0}"
LARK_CLI_MIN_VERSION="${LARK_CLI_MIN_VERSION:-1.0.64}"
FEISHU_APP_SCOPES_TENANT="${FEISHU_APP_SCOPES_TENANT:-im:message,im:message:send_as_bot,im:message:readonly,im:resource,cardkit:card:write,task:task,task:comment,task:task:readonly,task:comment:readonly,task:attachment:delete,task:attachment:file:download,task:attachment:read,task:attachment:upload,task:attachment:write,task:comment:delete,task:comment:read,task:comment:write,task:comment:writeonly,task:task:delete,task:task:read,task:task:write,task:task:writeonly,task:tasklist:delete,task:tasklist:read,task:tasklist:write,task:tasklist:writeonly,search:docs:read,base:app:copy,base:app:create,base:app:read,base:app:update,base:block:create,base:block:delete,base:block:read,base:block:update,base:dashboard:create,base:dashboard:delete,base:dashboard:read,base:dashboard:update,base:field:create,base:field:delete,base:field:read,base:field:update,base:form:create,base:form:delete,base:form:read,base:form:update,base:history:read,base:record:create,base:record:delete,base:record:read,base:record:update,base:role:create,base:role:delete,base:role:read,base:role:update,base:table:create,base:table:delete,base:table:read,base:table:update,base:view:read,base:view:write_only,base:workflow:create,base:workflow:read,base:workflow:update,board:whiteboard:node:create,board:whiteboard:node:read,calendar:calendar.event:create,calendar:calendar.event:delete,calendar:calendar.event:read,calendar:calendar.event:reply,calendar:calendar.event:update,calendar:calendar.free_busy:read,calendar:calendar:create,calendar:calendar:delete,calendar:calendar:read,calendar:calendar:update,contact:user.base:readonly,contact:user.basic_profile:readonly,docs:document.media:download,docs:document.media:upload,docs:document:export,docs:document:import,docx:document:create,docx:document:readonly,docx:document:write_only,drive:drive.metadata:readonly,drive:file:download,drive:file:upload,im:chat.managers:write_only,im:chat.members:read,im:chat.members:write_only,im:chat.moderation:read,im:chat:moderation:write_only,im:message.pins:read,im:message.pins:write_only,im:message.reactions:read,im:message.reactions:write_only,im:message:recall,mail:user_mailbox.event.mail_address:read,mail:user_mailbox.mail_contact:read,mail:user_mailbox.message.address:read,mail:user_mailbox.message.body:read,mail:user_mailbox.message.subject:read,mindnote:node:create,mindnote:node:read,minutes:minutes.basic:read,minutes:minutes.media:export,minutes:minutes:readonly,sheets:spreadsheet.meta:read,sheets:spreadsheet.meta:write_only,sheets:spreadsheet:create,sheets:spreadsheet:read,sheets:spreadsheet:write_only,slides:presentation:create,slides:presentation:read,slides:presentation:update,slides:presentation:write_only,task:custom_field:read,task:custom_field:write,task:section:read,task:section:write,vc:meeting.bot.join:write,vc:meeting.meetingevent:read,vc:meeting.message:write,vc:record:readonly,wiki:member:create,wiki:member:retrieve,wiki:member:update,wiki:node:copy,wiki:node:create,wiki:node:move,wiki:node:read,wiki:node:retrieve,wiki:space:read,wiki:space:retrieve,wiki:space:write_only}"
FEISHU_APP_SCOPES_USER="${FEISHU_APP_SCOPES_USER:-im:message,im:message:readonly,im:resource,cardkit:card:write,task:task,task:comment,task:task:readonly,task:comment:readonly,task:attachment:delete,task:attachment:file:download,task:attachment:read,task:attachment:upload,task:attachment:write,task:comment:delete,task:comment:read,task:comment:write,task:comment:writeonly,task:task:delete,task:task:read,task:task:write,task:task:writeonly,task:tasklist:delete,task:tasklist:read,task:tasklist:write,task:tasklist:writeonly,search:docs:read,search:message,base:app:copy,base:app:create,base:app:read,base:app:update,base:block:create,base:block:delete,base:block:read,base:block:update,base:dashboard:create,base:dashboard:delete,base:dashboard:read,base:dashboard:update,base:field:create,base:field:delete,base:field:read,base:field:update,base:form:create,base:form:delete,base:form:read,base:form:update,base:history:read,base:record:create,base:record:delete,base:record:read,base:record:update,base:role:create,base:role:delete,base:role:read,base:role:update,base:table:create,base:table:delete,base:table:read,base:table:update,base:view:read,base:view:write_only,base:workflow:create,base:workflow:read,base:workflow:update,board:whiteboard:node:create,board:whiteboard:node:read,calendar:calendar.event:create,calendar:calendar.event:delete,calendar:calendar.event:read,calendar:calendar.event:reply,calendar:calendar.event:update,calendar:calendar.free_busy:read,calendar:calendar:create,calendar:calendar:delete,calendar:calendar:read,calendar:calendar:update,contact:user.base:readonly,contact:user.basic_profile:readonly,contact:user:search,docs:document.media:download,docs:document.media:upload,docs:document:export,docs:document:import,docx:document:create,docx:document:readonly,docx:document:write_only,drive:drive.metadata:readonly,drive:file:download,drive:file:upload,im:chat.managers:write_only,im:chat.members:read,im:chat.members:write_only,im:chat.moderation:read,im:chat.nickname:read,im:chat.nickname:write,im:chat.user_setting:read,im:chat.user_setting:write,im:chat:read,im:chat:update,im:chat:create_by_user,im:chat:moderation:write_only,im:feed.flag:read,im:feed.flag:write,im:feed.shortcut:read,im:feed.shortcut:write,im:feed_group_v1:read,im:feed_group_v1:write,im:message.group_msg:get_as_user,im:message.p2p_msg:get_as_user,im:message.pins:read,im:message.pins:write_only,im:message.reactions:read,im:message.reactions:write_only,im:message:recall,mail:event,mail:user_mailbox.event.mail_address:read,mail:user_mailbox.mail_contact:read,mail:user_mailbox.message.address:read,mail:user_mailbox.message.body:read,mail:user_mailbox.message.subject:read,mindnote:node:create,mindnote:node:read,minutes:minutes.artifacts:read,minutes:minutes.basic:read,minutes:minutes.media:export,minutes:minutes.search:read,minutes:minutes.upload:write,minutes:minutes:readonly,minutes:minutes:update,profile:user_profile:read,sheets:spreadsheet.meta:read,sheets:spreadsheet.meta:write_only,sheets:spreadsheet:create,sheets:spreadsheet:read,sheets:spreadsheet:write_only,slides:presentation:create,slides:presentation:read,slides:presentation:update,slides:presentation:write_only,task:custom_field:read,task:custom_field:write,task:section:read,task:section:write,vc:meeting.bot.join:write,vc:meeting.meetingevent:read,vc:meeting.message:write,vc:meeting.search:read,vc:note:read,vc:record:readonly,wiki:member:create,wiki:member:retrieve,wiki:member:update,wiki:node:copy,wiki:node:create,wiki:node:move,wiki:node:read,wiki:node:retrieve,wiki:space:read,wiki:space:retrieve,wiki:space:write_only}"
FEISHU_APP_EVENTS_TENANT="${FEISHU_APP_EVENTS_TENANT:-task.task.update_user_access_v2}"
FEISHU_APP_EVENTS_USER="${FEISHU_APP_EVENTS_USER:-task.task.update_user_access_v2}"
FEISHU_USER_AUTH_DOMAINS="${FEISHU_USER_AUTH_DOMAINS:-base,calendar,contact,docs,im,mail,mindnotes,minutes,note,sheets,slides,task,vc,wiki}"
FEISHU_USER_AUTH_EXCLUDES="${FEISHU_USER_AUTH_EXCLUDES:-im:message.send_as_user,mail:user_mailbox.message:send,mail:user_mailbox.rule:read,mail:user_mailbox.folder:write,mail:user_mailbox.rule:write,mail:user_mailbox.message:modify,mail:user_mailbox.message:readonly,mail:user_mailbox.folder:read,mail:user_mailbox.mail_contact:write,mail:user_mailbox:readonly}"
FEISHU_USER_AUTH_REQUIRED_SCOPES="${FEISHU_USER_AUTH_REQUIRED_SCOPES:-im:message im:message:readonly im:resource cardkit:card:write task:task task:comment task:task:readonly task:comment:readonly task:attachment:delete task:attachment:file:download task:attachment:read task:attachment:upload task:attachment:write task:comment:delete task:comment:read task:comment:write task:comment:writeonly task:task:delete task:task:read task:task:write task:task:writeonly task:tasklist:delete task:tasklist:read task:tasklist:write task:tasklist:writeonly search:docs:read search:message base:app:copy base:app:create base:app:read base:app:update base:block:create base:block:delete base:block:read base:block:update base:dashboard:create base:dashboard:delete base:dashboard:read base:dashboard:update base:field:create base:field:delete base:field:read base:field:update base:form:create base:form:delete base:form:read base:form:update base:history:read base:record:create base:record:delete base:record:read base:record:update base:role:create base:role:delete base:role:read base:role:update base:table:create base:table:delete base:table:read base:table:update base:view:read base:view:write_only base:workflow:create base:workflow:read base:workflow:update board:whiteboard:node:create board:whiteboard:node:read calendar:calendar.event:create calendar:calendar.event:delete calendar:calendar.event:read calendar:calendar.event:reply calendar:calendar.event:update calendar:calendar.free_busy:read calendar:calendar:create calendar:calendar:delete calendar:calendar:read calendar:calendar:update contact:user.base:readonly contact:user.basic_profile:readonly contact:user:search docs:document.media:download docs:document.media:upload docs:document:export docs:document:import docx:document:create docx:document:readonly docx:document:write_only drive:drive.metadata:readonly drive:file:download drive:file:upload im:chat.managers:write_only im:chat.members:read im:chat.members:write_only im:chat.moderation:read im:chat.nickname:read im:chat.nickname:write im:chat.user_setting:read im:chat.user_setting:write im:chat:read im:chat:update im:chat:create_by_user im:chat:moderation:write_only im:feed.flag:read im:feed.flag:write im:feed.shortcut:read im:feed.shortcut:write im:feed_group_v1:read im:feed_group_v1:write im:message.group_msg:get_as_user im:message.p2p_msg:get_as_user im:message.pins:read im:message.pins:write_only im:message.reactions:read im:message.reactions:write_only im:message:recall mail:event mail:user_mailbox.event.mail_address:read mail:user_mailbox.mail_contact:read mail:user_mailbox.message.address:read mail:user_mailbox.message.body:read mail:user_mailbox.message.subject:read mindnote:node:create mindnote:node:read minutes:minutes.artifacts:read minutes:minutes.basic:read minutes:minutes.media:export minutes:minutes.search:read minutes:minutes.upload:write minutes:minutes:readonly minutes:minutes:update profile:user_profile:read sheets:spreadsheet.meta:read sheets:spreadsheet.meta:write_only sheets:spreadsheet:create sheets:spreadsheet:read sheets:spreadsheet:write_only slides:presentation:create slides:presentation:read slides:presentation:update slides:presentation:write_only task:custom_field:read task:custom_field:write task:section:read task:section:write vc:meeting.bot.join:write vc:meeting.meetingevent:read vc:meeting.message:write vc:meeting.search:read vc:note:read vc:record:readonly wiki:member:create wiki:member:retrieve wiki:member:update wiki:node:copy wiki:node:create wiki:node:move wiki:node:read wiki:node:retrieve wiki:space:read wiki:space:retrieve wiki:space:write_only}"
ACP_BRIDGE_PKG="${ACP_BRIDGE_PKG:-@zengxingyuan/aamp-acp-bridge@0.1.28-dev.16}"
CLI_BRIDGE_PKG="${CLI_BRIDGE_PKG:-@zengxingyuan/aamp-cli-bridge@0.1.7-dev.11}"
FEISHU_BRIDGE_PKG="${FEISHU_BRIDGE_PKG:-@zengxingyuan/aamp-feishu-bridge@0.1.42}"
AAMP_STALE_PROCESS_CLEANUP="${AAMP_STALE_PROCESS_CLEANUP:-false}"
AAMP_STALE_PROCESS_SECONDS="${AAMP_STALE_PROCESS_SECONDS:-86400}"

ACP_PID=""
CLI_PID=""
FEISHU_PID=""
ACP_TAIL_PID=""
CLI_TAIL_PID=""
FEISHU_TAIL_PID=""
ACP_LOG=""
CLI_LOG=""
FEISHU_LOG=""
CODEM_LOGIN_LOG=""
CODEM_SERVICE_START_OUTPUT=""
CODEM_AUTO_UPDATE_DONE="false"
CODEM_FORCE_LOGIN_DONE="false"
CODEM_PROVIDER_RECOVERY_DONE="false"
PAIRING_URL=""
FEISHU_ENV_ARGS=()
ACP_AGENT_COMMAND=""
STARTED_BRIDGE_PID=""
ONE_CLICK_RUN_ID="$(date +%s)-$$"
BOT_RESERVED="false"
NPM_BIN=""
NPX_BIN=""
CURSOR_LOCAL_BIN="$HOME/.local/bin"
CODEM_LOCAL_BIN="$HOME/.codem/bin"

sanitize_inherited_npm_exec_env() {
  local key lower
  while IFS='=' read -r key _; do
    lower="$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')"
    case "$lower" in
      npm_config_*|npm_package_*|npm_lifecycle_*|npm_command|npm_execpath|npm_node_execpath|init_cwd)
        unset "$key"
        ;;
    esac
  done < <(env)
}

usage() {
  cat <<'USAGE'
Usage:
  aamp-feishu-task-agent [options]

Options:
  --agent codex|cursor|codem  Agent to launch. If omitted, choose interactively.
  --env online|pre|boe       Runtime environment. Default: online
  --boe-env-name NAME        BOE x-tt-env value. Default: boe_task_event
  --aamp-host URL            AAMP service URL. Default: https://meshmail.ai
  --debug                    Enable debug mode for bridge processes
  -h, --help                 Show this help
USAGE
}

agent_log() {
  printf '[aamp-one-click] %s\n' "$*"
}

agent_fail() {
  printf '[aamp-one-click] ERROR: %s\n' "$*" >&2
  exit 1
}

kill_process_tree() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0

  local children child
  children="$(pgrep -P "$pid" 2>/dev/null || true)"
  for child in $children; do
    kill_process_tree "$child"
  done

  kill "$pid" 2>/dev/null || true
}

start_logged_bridge() {
  local log_file="$1"
  local tail_var="$2"
  local mode="$3"
  shift 3

  if [ "$mode" = "append" ]; then
    "$@" >>"$log_file" 2>&1 &
  else
    "$@" >"$log_file" 2>&1 &
  fi
  STARTED_BRIDGE_PID=$!

  if [ "$mode" = "append" ]; then
    tail -n 0 -f "$log_file" &
  else
    tail -n +1 -f "$log_file" &
  fi
  printf -v "$tail_var" '%s' "$!"
}

acquire_bot_selection_lock() {
  local attempt owner owner_pid
  mkdir -p "$(dirname "$BOT_SELECTION_LOCK_DIR")"
  for attempt in $(seq 1 300); do
    if mkdir "$BOT_SELECTION_LOCK_DIR" 2>/dev/null; then
      printf '%s\n' "$ONE_CLICK_RUN_ID" >"$BOT_SELECTION_LOCK_DIR/owner" 2>/dev/null || true
      return 0
    fi
    owner="$(cat "$BOT_SELECTION_LOCK_DIR/owner" 2>/dev/null || true)"
    owner_pid="${owner##*-}"
    if [ -n "$owner_pid" ] && [ "$owner_pid" != "$owner" ] && ! kill -0 "$owner_pid" 2>/dev/null; then
      rm -f "$BOT_SELECTION_LOCK_DIR/owner" 2>/dev/null || true
      rmdir "$BOT_SELECTION_LOCK_DIR" 2>/dev/null || true
      continue
    fi
    sleep 0.2
  done
  agent_fail "timed out waiting for Feishu bot selection lock"
}

release_bot_selection_lock() {
  local owner
  owner="$(cat "$BOT_SELECTION_LOCK_DIR/owner" 2>/dev/null || true)"
  [ "$owner" = "$ONE_CLICK_RUN_ID" ] || return 0
  rm -f "$BOT_SELECTION_LOCK_DIR/owner" 2>/dev/null || true
  rmdir "$BOT_SELECTION_LOCK_DIR" 2>/dev/null || true
}

cleanup_stale_one_click_processes() {
  [ "$AAMP_STALE_PROCESS_CLEANUP" = "true" ] || return 0
  command -v ps >/dev/null 2>&1 || return 0

  local pass stale line pid command
  for pass in 1 2; do
    stale=()
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      stale+=("$line")
    done < <(
      ps -axo pid=,ppid=,etime=,command= 2>/dev/null | awk -v min_age="$AAMP_STALE_PROCESS_SECONDS" -v self="$$" '
        function etime_seconds(value, days, parts, count, time_parts) {
          days = 0
          if (index(value, "-") > 0) {
            count = split(value, parts, "-")
            days = parts[1] + 0
            value = parts[count]
          }
          count = split(value, time_parts, ":")
          if (count == 3) return days * 86400 + time_parts[1] * 3600 + time_parts[2] * 60 + time_parts[3]
          if (count == 2) return days * 86400 + time_parts[1] * 60 + time_parts[2]
          return days * 86400 + value
        }
        {
          pid = $1
          ppid = $2
          etime = $3
          $1 = ""; $2 = ""; $3 = ""
          sub(/^[[:space:]]+/, "")
          command = $0

          if (pid == self) next
          if (ppid != 1) next

          age = etime_seconds(etime)
          if (age < min_age) next

          if (command ~ /aamp-one-click-npm-cache/ && command ~ /(aamp-acp-bridge|aamp-feishu-bridge|aamp-feishu-task-bridge|aamp-cli-bridge|codex-acp|acpx)/) {
            print pid "\t" command
            next
          }

          if (command ~ /node_modules\/\.bin\/(aamp-acp-bridge|aamp-feishu-bridge|aamp-feishu-task-bridge|aamp-cli-bridge|codex-acp)/) {
            print pid "\t" command
            next
          }

          if (command ~ /acpx.*__queue-owner/) {
            print pid "\t" command
            next
          }
        }
      '
    )

    [ "${#stale[@]}" -gt 0 ] || return 0

    agent_log "cleaning stale one-click orphan process(es) older than ${AAMP_STALE_PROCESS_SECONDS}s"
    for line in "${stale[@]}"; do
      pid="${line%%$'\t'*}"
      command="${line#*$'\t'}"
      agent_log "stopping stale process pid=$pid command=$command"
      kill "$pid" 2>/dev/null || true
    done

    [ "$pass" -eq 1 ] && sleep 1
  done
}

os_name() {
  uname -s 2>/dev/null || printf 'unknown'
}

is_macos() {
  [ "$(os_name)" = "Darwin" ]
}

path_prepend() {
  local path_entry="$1"
  [ -n "$path_entry" ] || return 0
  case ":$PATH:" in
    *":$path_entry:"*) ;;
    *) export PATH="$path_entry:$PATH" ;;
  esac
}

run_brew() {
  # Feed one "yes" for Homebrew prompts such as dependency installation confirmation.
  printf 'y\n' | HOMEBREW_NO_ENV_HINTS=1 brew "$@"
}

refresh_node_toolchain_bins() {
  NPM_BIN="$(command -v npm || true)"
  NPX_BIN="$(command -v npx || true)"
}

print_node_toolchain_help() {
  cat >&2 <<'HELP'

Automatic Node.js/npm installation did not complete.
Install it manually with one of these commands, then reopen the terminal or fix PATH:
  Homebrew: brew install node
  Volta:    volta install node npm
  fnm:      fnm install --lts
  nvm:      nvm install --lts

HELP
}

try_install_node_toolchain() {
  local node_path
  node_path="$(command -v node || true)"

  if command -v volta >/dev/null 2>&1 && { [ -z "$node_path" ] || [[ "$node_path" == *"/.volta/"* ]]; }; then
    agent_log "installing Node.js/npm with Volta"
    volta install node npm
    return $?
  fi

  if command -v fnm >/dev/null 2>&1 && { [ -z "$node_path" ] || [[ "$node_path" == *"/.fnm/"* ]]; }; then
    agent_log "installing Node.js/npm with fnm"
    fnm install --lts
    eval "$(fnm env --shell bash)"
    return 0
  fi

  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$nvm_dir/nvm.sh" ] && { [ -z "$node_path" ] || [[ "$node_path" == *"/.nvm/"* ]]; }; then
    agent_log "installing Node.js/npm with nvm"
    # shellcheck disable=SC1090
    source "$nvm_dir/nvm.sh"
    nvm install --lts
    nvm use --lts
    return 0
  fi

  if command -v brew >/dev/null 2>&1; then
    local formula="node"
    if brew list --versions node@22 >/dev/null 2>&1; then
      formula="node@22"
    elif brew list --versions node >/dev/null 2>&1; then
      formula="node"
    fi

    if brew list --versions "$formula" >/dev/null 2>&1; then
      agent_log "reinstalling $formula with Homebrew to restore npm/npx"
      run_brew reinstall "$formula"
    else
      agent_log "installing Node.js/npm with Homebrew"
      run_brew install "$formula"
    fi
    return $?
  fi

  agent_log "no supported Node.js installer found; tried Volta, fnm, nvm, and Homebrew"
  return 1
}

ensure_node_toolchain() {
  refresh_node_toolchain_bins
  if [ -n "$NPM_BIN" ] && [ -n "$NPX_BIN" ]; then
    configure_npm_registry
    return 0
  fi

  agent_log "npm/npx not found; installing Node.js/npm automatically"
  if ! try_install_node_toolchain; then
    print_node_toolchain_help
    agent_fail "failed to install Node.js/npm automatically"
  fi

  hash -r 2>/dev/null || true
  refresh_node_toolchain_bins
  [ -n "$NPM_BIN" ] && [ -n "$NPX_BIN" ] || {
    print_node_toolchain_help
    agent_fail "npm/npx is still unavailable after installation"
  }
  configure_npm_registry
}

configure_npm_registry() {
  sanitize_inherited_npm_exec_env
  mkdir -p "$NPM_CACHE_DIR"
  mkdir -p "$NPM_GLOBAL_PREFIX/bin"
  path_prepend "$NPM_GLOBAL_PREFIX/bin"
  export npm_config_cache="$NPM_CACHE_DIR"
  export NPM_CONFIG_CACHE="$NPM_CACHE_DIR"
  export npm_config_registry="$NPM_REGISTRY"
  export NPM_CONFIG_REGISTRY="$NPM_REGISTRY"
  export npm_config_prefix="$NPM_GLOBAL_PREFIX"
  export NPM_CONFIG_PREFIX="$NPM_GLOBAL_PREFIX"
  "$NPM_BIN" config set registry "$NPM_REGISTRY" >/dev/null 2>&1 || true
  agent_log "using npm registry: $NPM_REGISTRY"
  agent_log "using npm cache: $NPM_CACHE_DIR"
  agent_log "using npm global prefix: $NPM_GLOBAL_PREFIX"
}

npm_install_global() {
  local npm_log
  npm_log="$(mktemp "${TMPDIR:-/tmp}/aamp-npm-install.XXXXXX")"
  sanitize_inherited_npm_exec_env
  if "$NPM_BIN" install -g \
    --registry "$NPM_REGISTRY" \
    --cache "$NPM_CACHE_DIR" \
    --prefix "$NPM_GLOBAL_PREFIX" \
    "$@" >"$npm_log" 2>&1; then
    cat "$npm_log"
    hash -r 2>/dev/null || true
    return 0
  fi

  if ! npm_log_indicates_cache_error "$npm_log"; then
    cat "$npm_log" >&2
    return 1
  fi

  reset_npm_cache_for_retry
  npm_log="$(mktemp "${TMPDIR:-/tmp}/aamp-npm-install-retry.XXXXXX")"
  sanitize_inherited_npm_exec_env
  "$NPM_BIN" install -g \
    --registry "$NPM_REGISTRY" \
    --cache "$NPM_CACHE_DIR" \
    --prefix "$NPM_GLOBAL_PREFIX" \
    "$@" >"$npm_log" 2>&1 || {
      cat "$npm_log" >&2
      return 1
    }
  cat "$npm_log"
  hash -r 2>/dev/null || true
}

npx_package() {
  local npm_log
  local status
  local package_spec=""
  local package_args=()
  if [ "${1:-}" = "--package" ]; then
    [ -n "${2:-}" ] || agent_fail "npx_package requires a package value after --package"
    package_spec="$2"
    package_args=(--package "$package_spec")
    shift 2
  fi
  npm_log="$(mktemp "${TMPDIR:-/tmp}/aamp-npx.XXXXXX")"
  sanitize_inherited_npm_exec_env
  set +e
  "$NPM_BIN" exec --yes --registry "$NPM_REGISTRY" --cache "$NPM_CACHE_DIR" "${package_args[@]}" -- "$@" 2>&1 | tee "$npm_log"
  status=${PIPESTATUS[0]}
  set -e
  if [ "$status" -eq 0 ]; then
    return 0
  fi

  if [ -n "$package_spec" ] && npm_log_indicates_exec_bin_error "$npm_log"; then
    run_global_package_bin "$package_spec" "$@"
    return $?
  fi

  if ! npm_log_indicates_cache_error "$npm_log"; then
    return "$status"
  fi

  reset_npm_cache_for_retry
  npm_log="$(mktemp "${TMPDIR:-/tmp}/aamp-npx-retry.XXXXXX")"
  sanitize_inherited_npm_exec_env
  set +e
  "$NPM_BIN" exec --yes --registry "$NPM_REGISTRY" --cache "$NPM_CACHE_DIR" "${package_args[@]}" -- "$@" 2>&1 | tee "$npm_log"
  status=${PIPESTATUS[0]}
  set -e
  if [ "$status" -ne 0 ] && [ -n "$package_spec" ] && npm_log_indicates_exec_bin_error "$npm_log"; then
    run_global_package_bin "$package_spec" "$@"
    return $?
  fi
  return "$status"
}

npm_log_indicates_exec_bin_error() {
  local npm_log="$1"
  grep -Eiq '(^|[[:space:]])(sh|bash|zsh): .*command not found|not found: .*|could not determine executable to run' "$npm_log"
}

run_global_package_bin() {
  local package_spec="$1"
  local bin_name="$2"
  shift 2
  local bin_path="$NPM_GLOBAL_PREFIX/bin/$bin_name"

  agent_log "npm exec could not resolve $bin_name; installing $package_spec into one-click npm prefix"
  npm_install_global "$package_spec" || return $?
  hash -r 2>/dev/null || true
  [ -x "$bin_path" ] || {
    agent_log "expected executable not found after install: $bin_path"
    return 127
  }
  "$bin_path" "$@"
}

npm_log_indicates_cache_error() {
  local npm_log="$1"
  grep -Eiq 'Invalid response body|_cacache|ENOENT.*(_cacache|content-v2)|tarball data.*corrupted|TAR_BAD_ARCHIVE|zlib: unexpected end of file' "$npm_log"
}

reset_npm_cache_for_retry() {
  NPM_CACHE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aamp-one-click-npm-cache.XXXXXX")"
  export npm_config_cache="$NPM_CACHE_DIR"
  export NPM_CONFIG_CACHE="$NPM_CACHE_DIR"
  agent_log "npm cache appears corrupted; retrying with fresh npm cache: $NPM_CACHE_DIR"
}

npm_install_register_helper() {
  local workdir="$1"
  local npm_log
  npm_log="$(mktemp "${TMPDIR:-/tmp}/aamp-register-helper-install.XXXXXX")"

  sanitize_inherited_npm_exec_env
  if "$NPM_BIN" install \
    --prefix "$workdir" \
    --registry "$NPM_REGISTRY" \
    --cache "$NPM_CACHE_DIR" \
    "$LARK_REGISTER_APP_SDK" >"$npm_log" 2>&1; then
    return 0
  fi

  if ! npm_log_indicates_cache_error "$npm_log"; then
    cat "$npm_log" >&2
    return 1
  fi

  reset_npm_cache_for_retry
  npm_log="$(mktemp "${TMPDIR:-/tmp}/aamp-register-helper-install-retry.XXXXXX")"
  sanitize_inherited_npm_exec_env
  "$NPM_BIN" install \
    --prefix "$workdir" \
    --registry "$NPM_REGISTRY" \
    --cache "$NPM_CACHE_DIR" \
    "$LARK_REGISTER_APP_SDK" >"$npm_log" 2>&1 || {
      cat "$npm_log" >&2
      return 1
    }
}

validate_agent_name() {
  case "$1" in
    codex|cursor|codem) ;;
    *) agent_fail "--agent must be codex, cursor, or codem" ;;
  esac
}

read_tty_line() {
  local prompt="$1"
  local value
  if [ ! -r /dev/tty ]; then
    agent_fail "interactive input requires a terminal"
  fi
  printf '%s' "$prompt" >/dev/tty
  IFS= read -r value </dev/tty
  printf '%s' "$value"
}

render_agent_menu() {
  local selected="$1"
  local agents=(codex cursor codem)
  local index

  printf '\033[?25l' >&3
  printf '\033[2K\r请选择要启动的 Agent:\n' >&3
  for index in "${!agents[@]}"; do
    printf '\033[2K\r' >&3
    if [ "$index" -eq "$selected" ]; then
      printf '  > %s\n' "${agents[$index]}" >&3
    else
      printf '    %s\n' "${agents[$index]}" >&3
    fi
  done
  printf '\033[2K\r使用 ↑/↓ 选择，回车确认。也可按 1/2/3 或 j/k。\n' >&3
}

select_agent_interactively() {
  local agents=(codex cursor codem)
  local selected=0
  local key rest
  local tty_state

  if ! exec 3<>/dev/tty; then
    agent_fail "missing --agent and no interactive terminal is available; pass --agent codex|cursor|codem"
  fi

  tty_state="$(stty -g <&3)"
  stty -echo -icanon min 1 time 0 <&3
  render_agent_menu "$selected"
  while true; do
    IFS= read -rsn1 -u 3 key || {
      stty "$tty_state" <&3
      printf '\033[?25h\n' >&3
      exec 3>&-
      agent_fail "failed to read interactive agent selection"
    }

    case "$key" in
      ""|$'\n'|$'\r')
        AGENT="${agents[$selected]}"
        stty "$tty_state" <&3
        printf '\033[?25h\n' >&3
        exec 3>&-
        return 0
        ;;
      $'\033')
        IFS= read -rsn2 -u 3 rest || rest=""
        case "$rest" in
          "[A")
            selected=$(( (selected + ${#agents[@]} - 1) % ${#agents[@]} ))
            printf '\033[5A' >&3
            render_agent_menu "$selected"
            ;;
          "[B")
            selected=$(( (selected + 1) % ${#agents[@]} ))
            printf '\033[5A' >&3
            render_agent_menu "$selected"
            ;;
          "[C"|"[D")
            ;;
        esac
        ;;
      k)
        selected=$(( (selected + ${#agents[@]} - 1) % ${#agents[@]} ))
        printf '\033[5A' >&3
        render_agent_menu "$selected"
        ;;
      j)
        selected=$(( (selected + 1) % ${#agents[@]} ))
        printf '\033[5A' >&3
        render_agent_menu "$selected"
        ;;
      1|2|3)
        selected=$(( key - 1 ))
        AGENT="${agents[$selected]}"
        stty "$tty_state" <&3
        printf '\033[5A' >&3
        render_agent_menu "$selected"
        printf '\033[?25h\n' >&3
        exec 3>&-
        return 0
        ;;
    esac
  done
}

render_bot_menu() {
  local selected="$1"
  local index
  local columns max_label_width label prefix

  printf '\033[?25l' >&3
  printf '\033[2K\r请选择飞书 Bot 应用:\n' >&3
  columns="$(tput cols 2>/dev/null || printf '80')"
  case "$columns" in
    ''|*[!0-9]*) columns=80 ;;
  esac
  max_label_width=$((columns - 6))
  [ "$max_label_width" -gt 20 ] || max_label_width=20
  for index in "${!bot_labels[@]}"; do
    printf '\033[2K\r' >&3
    label="${bot_labels[$index]}"
    if [ "${#label}" -gt "$max_label_width" ]; then
      label="${label:0:$((max_label_width - 3))}..."
    fi
    if [ "$index" -eq "$selected" ]; then
      prefix='  > '
    else
      prefix='    '
    fi
    printf '%s%s\n' "$prefix" "$label" >&3
  done
  printf '\033[2K\r使用 ↑/↓ 选择，回车确认。也可按数字键或 j/k。\n' >&3
}

select_bot_menu() {
  local selected=0
  local key rest
  local tty_state
  local line_count

  if ! exec 3<>/dev/tty; then
    agent_fail "interactive bot selection requires a terminal"
  fi

  line_count=$((${#bot_labels[@]} + 2))
  tty_state="$(stty -g <&3)"
  stty -echo -icanon min 1 time 0 <&3
  render_bot_menu "$selected"
  while true; do
    IFS= read -rsn1 -u 3 key || {
      stty "$tty_state" <&3
      printf '\033[?25h\n' >&3
      exec 3>&-
      agent_fail "failed to read interactive bot selection"
    }

    case "$key" in
      ""|$'\n'|$'\r')
        stty "$tty_state" <&3
        printf '\033[?25h\n' >&3
        exec 3>&-
        return "$selected"
        ;;
      $'\033')
        IFS= read -rsn2 -u 3 rest || rest=""
        case "$rest" in
          "[A")
            selected=$(( (selected + ${#bot_labels[@]} - 1) % ${#bot_labels[@]} ))
            printf '\033[%dA' "$line_count" >&3
            render_bot_menu "$selected"
            ;;
          "[B")
            selected=$(( (selected + 1) % ${#bot_labels[@]} ))
            printf '\033[%dA' "$line_count" >&3
            render_bot_menu "$selected"
            ;;
          "[C"|"[D")
            ;;
        esac
        ;;
      k)
        selected=$(( (selected + ${#bot_labels[@]} - 1) % ${#bot_labels[@]} ))
        printf '\033[%dA' "$line_count" >&3
        render_bot_menu "$selected"
        ;;
      j)
        selected=$(( (selected + 1) % ${#bot_labels[@]} ))
        printf '\033[%dA' "$line_count" >&3
        render_bot_menu "$selected"
        ;;
      [1-9])
        if [ "$key" -le "${#bot_labels[@]}" ]; then
          selected=$(( key - 1 ))
          stty "$tty_state" <&3
          printf '\033[%dA' "$line_count" >&3
          render_bot_menu "$selected"
          printf '\033[?25h\n' >&3
          exec 3>&-
          return "$selected"
        fi
        ;;
    esac
  done
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --agent)
        AGENT="${2:-}"
        shift 2
        ;;
      --env)
        ENV_NAME="${2:-}"
        shift 2
        ;;
      --boe-env-name)
        BOE_ENV_NAME="${2:-}"
        shift 2
        ;;
      --aamp-host)
        AAMP_HOST="${2:-}"
        shift 2
        ;;
      --debug)
        DEBUG_MODE="true"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        agent_fail "unknown argument: $1"
        ;;
    esac
  done

  if [ -z "$AGENT" ]; then
    select_agent_interactively
  fi
  validate_agent_name "$AGENT"

  case "$ENV_NAME" in
    online|pre|boe) ;;
    *) agent_fail "--env must be online, pre, or boe" ;;
  esac
}

install_embedded_lark_env() {
  local target="$1"
  cat >"$target" <<'LARK_ENV_TASK_SH'
#!/usr/bin/env bash
set -euo pipefail

RULE_NAME="lark-cli-openapi-env-switch"
RULE_GROUP="lark-cli"

log() {
  printf '[lark-env-task] %s\n' "$*" >&2
}

fail() {
  printf '[lark-env-task] ERROR: %s\n' "$*" >&2
  return 1
}

usage() {
  cat >&2 <<'USAGE'
Usage:
  source ~/lark-env-task.sh online
  source ~/lark-env-task.sh pre
  source ~/lark-env-task.sh boe --boe-env-name boe_task_event
  source ~/lark-env-task.sh off
USAGE
}

pick_whistle_cmd() {
  if command -v w2 >/dev/null 2>&1; then
    printf '%s\n' "w2"
    return 0
  fi
  if command -v whistle >/dev/null 2>&1; then
    printf '%s\n' "whistle"
    return 0
  fi
  return 1
}

ensure_whistle() {
  local wcmd="$1"
  local status
  status="$("$wcmd" status 2>&1 || true)"
  case "$status" in
    *"No running Whistle instances"*)
      log "Whistle is not running, starting it now..."
      "$wcmd" start >/dev/null 2>&1 || fail "failed to start Whistle"
      ;;
  esac
}

write_rule_js() {
  local target="$1"
  cat >"$target" <<'JS'
module.exports = function (callback) {
  callback({
    name: process.env.LARK_CLI_WHISTLE_RULE_NAME || 'lark-cli-openapi-env-switch',
    groupName: process.env.LARK_CLI_WHISTLE_RULE_GROUP || 'lark-cli',
    rules: process.env.LARK_CLI_WHISTLE_RULES || ''
  });
};
JS
}

build_rules() {
  local mode="$1"
  local boe_env_name="$2"

  case "$mode" in
    pre)
      cat <<'RULES'
/^https:\/\/open\.feishu\.cn\/(.*)$/ https://open.feishu-pre.cn/$1
https://open.feishu.cn/ reqHeaders://Env=Pre_release
/^https:\/\/accounts\.feishu\.cn\/(.*)$/ https://accounts.feishu-pre.cn/$1
RULES
      ;;
    boe)
      cat <<'RULES'
/^https:\/\/open\.feishu\.cn\/(.*)$/ https://open.feishu-boe.cn/$1
/^https:\/\/accounts\.feishu\.cn\/(.*)$/ https://accounts.feishu-boe.cn/$1
RULES
      if [ -n "$boe_env_name" ]; then
        printf '%s\n' "https://open.feishu.cn/ reqHeaders://x-tt-env=$boe_env_name"
      fi
      ;;
    off|online)
      cat <<'RULES'
# lark-cli env switch disabled
RULES
      ;;
    *)
      fail "unsupported mode: $mode"
      ;;
  esac
}

apply_proxy_env() {
  local mode="$1"

  case "$mode" in
    pre)
      export HTTPS_PROXY="http://127.0.0.1:8899"
      export https_proxy="$HTTPS_PROXY"
      export HTTP_PROXY="$HTTPS_PROXY"
      export http_proxy="$HTTPS_PROXY"
      export ALL_PROXY="$HTTPS_PROXY"
      export all_proxy="$HTTPS_PROXY"
      mkdir -p "$AAMP_LARK_CLI_CONFIG_DIR"
      export LARKSUITE_CLI_CONFIG_DIR="$AAMP_LARK_CLI_CONFIG_DIR"
      unset LARK_CLI_NO_PROXY
      log "pre enabled, proxy=$HTTPS_PROXY, LARKSUITE_CLI_CONFIG_DIR=$LARKSUITE_CLI_CONFIG_DIR"
      ;;
    boe)
      export HTTPS_PROXY="http://127.0.0.1:8899"
      export https_proxy="$HTTPS_PROXY"
      export HTTP_PROXY="$HTTPS_PROXY"
      export http_proxy="$HTTPS_PROXY"
      export ALL_PROXY="$HTTPS_PROXY"
      export all_proxy="$HTTPS_PROXY"
      unset LARK_CLI_NO_PROXY
      mkdir -p "$AAMP_LARK_CLI_BOE_CONFIG_DIR"
      export LARKSUITE_CLI_CONFIG_DIR="$AAMP_LARK_CLI_BOE_CONFIG_DIR"
      log "boe enabled, proxy=$HTTPS_PROXY, LARKSUITE_CLI_CONFIG_DIR=$LARKSUITE_CLI_CONFIG_DIR"
      ;;
    online|off)
      unset HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy
      mkdir -p "$AAMP_LARK_CLI_CONFIG_DIR"
      export LARKSUITE_CLI_CONFIG_DIR="$AAMP_LARK_CLI_CONFIG_DIR"
      unset LARK_CLI_NO_PROXY
      log "online enabled, proxy env cleared, LARKSUITE_CLI_CONFIG_DIR=$LARKSUITE_CLI_CONFIG_DIR"
      ;;
  esac
}

main() {
  local mode="${1:-}"
  local boe_env_name="boe_task_event"

  if [ -z "$mode" ] || [ "$mode" = "-h" ] || [ "$mode" = "--help" ]; then
    usage
    return 0
  fi
  shift || true

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --boe-env-name)
        boe_env_name="${2:-}"
        shift 2
        ;;
      *)
        fail "unknown argument: $1"
        return 1
        ;;
    esac
  done

  case "$mode" in
    online|off)
      apply_proxy_env "online"
      return 0
      ;;
    pre|boe)
      ;;
    *)
      fail "mode must be online, pre, boe, or off"
      return 1
      ;;
  esac

  local wcmd
  wcmd="$(pick_whistle_cmd)" || {
    log "missing w2/whistle; install with: npm install -g whistle"
    return 1
  }
  ensure_whistle "$wcmd" || return 1

  local rules
  rules="$(build_rules "$mode" "$boe_env_name")" || return 1

  local tmp_js
  tmp_js="$(mktemp "${TMPDIR:-/tmp}/lark-env-task-rule.XXXXXX")" || return 1
  write_rule_js "$tmp_js"

  LARK_CLI_WHISTLE_RULE_NAME="$RULE_NAME" \
  LARK_CLI_WHISTLE_RULE_GROUP="$RULE_GROUP" \
  LARK_CLI_WHISTLE_RULES="$rules" \
  "$wcmd" add "$tmp_js" --force >/dev/null 2>&1 || {
    rm -f "$tmp_js"
    fail "failed to apply Whistle rules"
    return 1
  }
  rm -f "$tmp_js"

  apply_proxy_env "$mode"
}

main "$@"
LARK_ENV_TASK_SH
}

ensure_lark_env_script() {
  local target="$HOME/lark-env-task.sh"
  agent_log "writing embedded env script: $target"
  install_embedded_lark_env "$target"
  chmod +x "$target" 2>/dev/null || true
}

source_lark_env() {
  ensure_lark_env_script

  case "$ENV_NAME" in
    online)
      # shellcheck disable=SC1090
      source "$HOME/lark-env-task.sh" online
      ;;
    pre)
      # shellcheck disable=SC1090
      source "$HOME/lark-env-task.sh" pre || {
        agent_log "Whistle is not ready; installing whistle and retrying pre env setup"
        npm_install_global whistle
        source "$HOME/lark-env-task.sh" pre
      }
      ;;
    boe)
      # shellcheck disable=SC1090
      source "$HOME/lark-env-task.sh" boe --boe-env-name "$BOE_ENV_NAME" || {
        agent_log "Whistle is not ready; installing whistle and retrying boe env setup"
        npm_install_global whistle
        source "$HOME/lark-env-task.sh" boe --boe-env-name "$BOE_ENV_NAME"
      }
      ;;
  esac
}

build_feishu_env_args() {
  FEISHU_ENV_ARGS=()
  case "$ENV_NAME" in
    online)
      ;;
    pre)
      FEISHU_ENV_ARGS=(--pre)
      ;;
    boe)
      FEISHU_ENV_ARGS=(--boe --env "$BOE_ENV_NAME")
      ;;
  esac
}

load_bot_configs() {
  [ -f "$BOT_CONFIG_FILE" ] || return 0
  BOT_CONFIG_FILE="$BOT_CONFIG_FILE" CURRENT_RUN_FILE="$CURRENT_RUN_FILE" ACTIVE_RUNS_FILE="$ACTIVE_RUNS_FILE" BOT_RESERVATIONS_FILE="$BOT_RESERVATIONS_FILE" ONE_CLICK_RUN_ID="$ONE_CLICK_RUN_ID" node -e '
const fs = require("fs");
const file = process.env.BOT_CONFIG_FILE;
const runFile = process.env.CURRENT_RUN_FILE;
const activeRunsFile = process.env.ACTIVE_RUNS_FILE;
const reservationsFile = process.env.BOT_RESERVATIONS_FILE;
const currentRunId = String(process.env.ONE_CLICK_RUN_ID || "");
let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  process.exit(0);
}
let currentRun;
try {
  currentRun = JSON.parse(fs.readFileSync(runFile, "utf8"));
} catch {}
let activeRunStore;
try {
  activeRunStore = JSON.parse(fs.readFileSync(activeRunsFile, "utf8"));
} catch {}
let reservationStore;
try {
  reservationStore = JSON.parse(fs.readFileSync(reservationsFile, "utf8"));
} catch {}
function isRunProcessAlive(runId) {
  const match = /-(\d+)$/.exec(String(runId || ""));
  if (!match) return false;
  const pid = Number(match[1]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
const candidateRuns = [
  ...(Array.isArray(activeRunStore?.runs) ? activeRunStore.runs : []),
  ...(currentRun?.run_id ? [currentRun] : []),
];
const activeAppIds = new Set();
for (const run of candidateRuns) {
  if (!isRunProcessAlive(run?.run_id)) continue;
  for (const pair of Array.isArray(run?.pairs) ? run.pairs : []) {
    const appId = String(pair?.app_id || "").trim();
    if (appId) activeAppIds.add(appId);
  }
}
for (const reservation of Array.isArray(reservationStore?.reservations) ? reservationStore.reservations : []) {
  const runId = String(reservation?.run_id || "");
  if (runId === currentRunId || !isRunProcessAlive(runId)) continue;
  const appId = String(reservation?.app_id || "").trim();
  if (appId) activeAppIds.add(appId);
}
const bots = Array.isArray(parsed?.profiles) ? parsed.profiles : [];
const seen = new Set();
for (const bot of bots) {
  const appId = String(bot?.app_id || "").trim();
  const profile = String(bot?.profile || "").trim();
  const name = String(bot?.display_name || appId).trim();
  const appSecret = String(bot?.app_secret || "").trim();
  if (!appId || !profile || seen.has(appId) || activeAppIds.has(appId)) continue;
  seen.add(appId);
  console.log([appId, name, profile, appSecret].join("\t"));
}
'
}

reserve_selected_bot() {
  local app_id="$1"
  local profile="$2"
  local bot_name="$3"
  [ -n "$app_id" ] || agent_fail "cannot reserve empty Feishu bot app id"
  mkdir -p "$(dirname "$BOT_RESERVATIONS_FILE")"
  set +e
  BOT_RESERVATIONS_FILE="$BOT_RESERVATIONS_FILE" CURRENT_RUN_FILE="$CURRENT_RUN_FILE" ACTIVE_RUNS_FILE="$ACTIVE_RUNS_FILE" ONE_CLICK_RUN_ID="$ONE_CLICK_RUN_ID" BOT_APP_ID="$app_id" BOT_PROFILE="$profile" BOT_NAME="$bot_name" node -e '
const fs = require("fs");
const path = require("path");
const reservationsFile = process.env.BOT_RESERVATIONS_FILE;
const runFile = process.env.CURRENT_RUN_FILE;
const activeRunsFile = process.env.ACTIVE_RUNS_FILE;
const runId = String(process.env.ONE_CLICK_RUN_ID || "");
const appId = String(process.env.BOT_APP_ID || "").trim();
const profile = String(process.env.BOT_PROFILE || "").trim();
const name = String(process.env.BOT_NAME || appId).trim();
if (!runId || !appId) process.exit(2);
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function isRunProcessAlive(value) {
  const match = /-(\d+)$/.exec(String(value || ""));
  if (!match) return false;
  const pid = Number(match[1]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
const currentRun = readJson(runFile, null);
const activeRunStore = readJson(activeRunsFile, { version: 1, runs: [] });
const reservationStore = readJson(reservationsFile, { version: 1, reservations: [] });
for (const run of [
  ...(Array.isArray(activeRunStore?.runs) ? activeRunStore.runs : []),
  ...(currentRun?.run_id ? [currentRun] : []),
]) {
  if (!isRunProcessAlive(run?.run_id)) continue;
  for (const pair of Array.isArray(run?.pairs) ? run.pairs : []) {
    if (String(pair?.app_id || "").trim() === appId) {
      console.error(`Feishu bot ${appId} is already running in another one-click script.`);
      process.exit(3);
    }
  }
}
const reservations = [];
for (const reservation of Array.isArray(reservationStore?.reservations) ? reservationStore.reservations : []) {
  const reservationRunId = String(reservation?.run_id || "");
  if (reservationRunId === runId || isRunProcessAlive(reservationRunId)) {
    reservations.push(reservation);
  }
}
if (reservations.some((reservation) => String(reservation?.app_id || "").trim() === appId && String(reservation?.run_id || "") !== runId)) {
  console.error(`Feishu bot ${appId} is already selected by another one-click script.`);
  process.exit(4);
}
const next = [
  ...reservations.filter((reservation) => String(reservation?.run_id || "") !== runId),
  {
    run_id: runId,
    app_id: appId,
    profile,
    display_name: name,
    reserved_at: new Date().toISOString(),
  },
];
fs.mkdirSync(path.dirname(reservationsFile), { recursive: true });
fs.writeFileSync(reservationsFile, JSON.stringify({ version: 1, reservations: next }, null, 2) + "\n");
'
  local status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    agent_fail "Feishu bot $app_id is already selected or running; choose another bot or start a new app."
  fi
  BOT_RESERVED="true"
}

release_selected_bot_reservation() {
  [ "$BOT_RESERVED" = "true" ] || return 0
  [ -f "$BOT_RESERVATIONS_FILE" ] || return 0
  BOT_RESERVATIONS_FILE="$BOT_RESERVATIONS_FILE" ONE_CLICK_RUN_ID="$ONE_CLICK_RUN_ID" node -e '
const fs = require("fs");
const file = process.env.BOT_RESERVATIONS_FILE;
const runId = String(process.env.ONE_CLICK_RUN_ID || "");
let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  process.exit(0);
}
const reservations = Array.isArray(parsed?.reservations) ? parsed.reservations : [];
const next = reservations.filter((reservation) => String(reservation?.run_id || "") !== runId);
if (next.length !== reservations.length) {
  fs.writeFileSync(file, JSON.stringify({ version: 1, reservations: next }, null, 2) + "\n");
}
'
}

has_saved_bot_configs() {
  [ -f "$BOT_CONFIG_FILE" ] || return 1
  BOT_CONFIG_FILE="$BOT_CONFIG_FILE" node -e '
const fs = require("fs");
const file = process.env.BOT_CONFIG_FILE;
let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  process.exit(1);
}
const bots = Array.isArray(parsed?.profiles) ? parsed.profiles : [];
process.exit(bots.some((bot) => String(bot?.app_id || "").trim() && String(bot?.profile || "").trim()) ? 0 : 1);
'
}

task_profile_name_for_app_id() {
  local app_id="$1"
  printf 'aamp-feishu-task-%s' "$app_id"
}

save_bot_config() {
  local bot_name="$1"
  local app_id="$2"
  local profile="$3"
  local app_secret="${4:-}"
  mkdir -p "$(dirname "$BOT_CONFIG_FILE")"
  BOT_CONFIG_FILE="$BOT_CONFIG_FILE" BOT_NAME="$bot_name" BOT_APP_ID="$app_id" BOT_PROFILE="$profile" BOT_APP_SECRET="$app_secret" FEISHU_USER_AUTH_DOMAINS="$FEISHU_USER_AUTH_DOMAINS" node -e '
const fs = require("fs");
const file = process.env.BOT_CONFIG_FILE;
const appSecret = String(process.env.BOT_APP_SECRET || "").trim();
const next = {
  display_name: process.env.BOT_NAME || process.env.BOT_APP_ID,
  app_id: process.env.BOT_APP_ID,
  ...(appSecret ? { app_secret: appSecret } : {}),
  profile: process.env.BOT_PROFILE,
  auth_mode: "lark-cli",
  capabilities: ["im", "task"],
  domains: String(process.env.FEISHU_USER_AUTH_DOMAINS || "").split(",").map((item) => item.trim()).filter(Boolean),
  updated_at: new Date().toISOString(),
};
let parsed = { version: 1, profiles: [] };
try {
  parsed = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {}
const bots = Array.isArray(parsed?.profiles) ? parsed.profiles : [];
const byAppId = new Map();
for (const bot of bots) {
  const appId = String(bot?.app_id || "").trim();
  if (!appId) continue;
  byAppId.set(appId, bot);
}
const existing = byAppId.get(next.app_id) || {};
byAppId.set(next.app_id, {
  ...existing,
  ...next,
  app_secret: next.app_secret || existing.app_secret,
});
fs.writeFileSync(file, JSON.stringify({ version: 1, profiles: [...byAppId.values()] }, null, 2) + "\n");
'
}

remove_bot_config() {
  local app_id="$1"
  [ -n "$app_id" ] || return 0
  [ -f "$BOT_CONFIG_FILE" ] || return 0
  BOT_CONFIG_FILE="$BOT_CONFIG_FILE" BOT_APP_ID="$app_id" node -e '
const fs = require("fs");
const file = process.env.BOT_CONFIG_FILE;
const appIdToRemove = process.env.BOT_APP_ID;
let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  process.exit(0);
}
const bots = Array.isArray(parsed?.profiles) ? parsed.profiles : [];
const filtered = bots.filter((bot) => String(bot?.app_id || "").trim() !== appIdToRemove);
if (filtered.length !== bots.length) {
  fs.writeFileSync(file, JSON.stringify({ version: 1, profiles: filtered }, null, 2) + "\n");
}
'
}

clean_bot_instance_configs_preserve_mailbox() {
  local app_id="$1"
  local profile="$2"
  [ -n "$app_id" ] || return 0
  BOT_APP_ID="$app_id" BOT_PROFILE="$profile" HOME_DIR="$HOME" node -e '
const fs = require("fs");
const path = require("path");

const appId = String(process.env.BOT_APP_ID || "").trim();
const profile = String(process.env.BOT_PROFILE || "").trim();
const home = process.env.HOME_DIR || process.env.HOME;
const instancesDir = path.join(home, ".aamp", "feishu-bridge", "task-runtime", "instances");
if (!appId || !fs.existsSync(instancesDir)) process.exit(0);

function normalizeId(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "instance";
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function matchesApp(instanceName, config) {
  if (String(config?.feishu?.appId || "").trim() === appId) return true;
  const normalizedAppId = normalizeId(appId);
  return String(instanceName || "").includes(normalizedAppId);
}

let cleaned = 0;
for (const entry of fs.readdirSync(instancesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const instanceName = entry.name;
  const instanceDir = path.join(instancesDir, instanceName);
  for (const kind of ["im", "task"]) {
    const configFile = path.join(instanceDir, kind, "config.json");
    const config = readJson(configFile);
    if (!config || !matchesApp(instanceName, config)) continue;
    if (!config.mailbox) continue;

    const cliProfile = profile || String(config?.feishu?.cliProfile || "").trim();
    if (kind === "task") {
      config.feishu = {
        appId,
        authMode: "lark-cli",
        ...(cliProfile ? { cliProfile } : {}),
        userIdType: config?.feishu?.userIdType || "open_id",
        eventNames: Array.isArray(config?.feishu?.eventNames) && config.feishu.eventNames.length
          ? config.feishu.eventNames
          : ["task.task.update_user_access_v2"],
      };
    } else {
      config.feishu = {
        appId,
        authMode: "lark-cli",
        ...(cliProfile ? { cliProfile } : {}),
      };
    }
    writeJson(configFile, config);
    cleaned += 1;
  }
}
if (cleaned) {
  console.log(`[aamp-one-click] cleaned ${cleaned} Feishu instance config file(s) for ${appId}, mailbox preserved`);
}
'
}

ensure_lark_cli() {
  if command -v lark-cli >/dev/null 2>&1; then
    ensure_lark_cli_min_version
    return 0
  fi
  agent_fail "lark-cli is required for Feishu task profile mode. Install lark-cli first, then rerun this script."
}

lark_cli_version() {
  lark-cli --version 2>/dev/null | sed -E 's/.*version[[:space:]]+([0-9]+([.][0-9]+){0,2}).*/\1/' | head -n 1
}

version_lt() {
  VERSION_LEFT="$1" VERSION_RIGHT="$2" node -e '
const left = String(process.env.VERSION_LEFT || "0").split(".").map((part) => Number.parseInt(part, 10) || 0);
const right = String(process.env.VERSION_RIGHT || "0").split(".").map((part) => Number.parseInt(part, 10) || 0);
const length = Math.max(left.length, right.length);
for (let index = 0; index < length; index += 1) {
  const l = left[index] || 0;
  const r = right[index] || 0;
  if (l < r) process.exit(0);
  if (l > r) process.exit(1);
}
process.exit(1);
'
}

ensure_lark_cli_min_version() {
  local current_version updated_version

  current_version="$(lark_cli_version)"
  if [ -z "$current_version" ]; then
    agent_fail "failed to detect lark-cli version; please update lark-cli to >= $LARK_CLI_MIN_VERSION and rerun this script."
  fi

  if ! version_lt "$current_version" "$LARK_CLI_MIN_VERSION"; then
    return 0
  fi

  agent_log "lark-cli $current_version is older than required $LARK_CLI_MIN_VERSION; updating lark-cli to latest"
  lark-cli update || agent_fail "failed to update lark-cli. Please update lark-cli to >= $LARK_CLI_MIN_VERSION manually and rerun this script."
  hash -r 2>/dev/null || true

  updated_version="$(lark_cli_version)"
  if [ -z "$updated_version" ] || version_lt "$updated_version" "$LARK_CLI_MIN_VERSION"; then
    agent_fail "lark-cli version is still ${updated_version:-unknown}; required >= $LARK_CLI_MIN_VERSION."
  fi
  agent_log "lark-cli version is ready: $updated_version"
}

lark_cli_user_auth_satisfied() {
  local profile="$1"
  local status_json auth_check

  status_json="$(lark-cli --profile "$profile" auth status --json 2>/dev/null)" || return 1

  set +e
  auth_check="$(AUTH_STATUS_JSON="$status_json" FEISHU_USER_AUTH_REQUIRED_SCOPES="$FEISHU_USER_AUTH_REQUIRED_SCOPES" FEISHU_USER_AUTH_EXCLUDES="$FEISHU_USER_AUTH_EXCLUDES" node -e '
function parseJsonOutput(value, label) {
  const raw = String(value || "");
  const start = raw.indexOf("{");
  if (start < 0) throw new Error(`${label} did not contain JSON`);
  return JSON.parse(raw.slice(start));
}

const status = parseJsonOutput(process.env.AUTH_STATUS_JSON, "auth status");
const user = status?.identities?.user;
if (!user?.available || user?.tokenStatus !== "valid") {
  console.log("lark-cli user auth is not ready or token is not valid");
  process.exit(1);
}

const excludedScopes = new Set(String(process.env.FEISHU_USER_AUTH_EXCLUDES || "").split(",").map((item) => item.trim()).filter(Boolean));
const requiredScopes = String(process.env.FEISHU_USER_AUTH_REQUIRED_SCOPES || "")
  .split(/[\s,]+/)
  .map((item) => item.trim())
  .filter(Boolean)
  .filter((scope) => !excludedScopes.has(scope));
const grantedScopes = new Set(String(user.scope || "").split(/\s+/).filter(Boolean));
const missing = [...new Set(requiredScopes)].filter((scope) => !grantedScopes.has(scope));
if (missing.length > 0) {
  const sample = missing.slice(0, 12).join(", ");
  console.log(`missing lark-cli user auth scopes (${missing.length}): ${sample}${missing.length > 12 ? ", ..." : ""}`);
  process.exit(1);
}
console.log("ok");
')"
  local node_status=$?
  set -e

  if [ "$node_status" -eq 0 ] && [ "$auth_check" = "ok" ]; then
    return 0
  fi
  [ -n "$auth_check" ] && agent_log "$auth_check"
  return 1
}

normalize_lark_cli_auth_excludes() {
  EXCLUDES="$1" node -e '
const excludes = String(process.env.EXCLUDES || "").split(",").map((item) => item.trim()).filter(Boolean);
console.log([...new Set(excludes)].join(","));
'
}

run_lark_cli_auth_login_with_browser_open() {
  local opened_url=""
  local line=""
  local auth_url=""

  set +e
  "$@" 2>&1 | while IFS= read -r line; do
    printf '%s\n' "$line"
    if [ "${AAMP_AUTO_OPEN_AUTH_URL:-true}" != "false" ] \
      && [ -z "$opened_url" ] \
      && command -v open >/dev/null 2>&1 \
      && [[ "$line" =~ (https://[^[:space:]]+) ]]; then
      auth_url="${BASH_REMATCH[1]}"
      opened_url="$auth_url"
      agent_log "opening Feishu auth URL in browser"
      open "$auth_url" >/dev/null 2>&1 || agent_log "failed to open auth URL automatically; please open it manually"
    fi
  done
  local auth_status=${PIPESTATUS[0]}
  set -e
  return "$auth_status"
}

run_lark_cli_auth_login() {
  local profile="$1"
  local auth_excludes="$2"

  auth_excludes="$(normalize_lark_cli_auth_excludes "$auth_excludes")"
  if [ -z "$auth_excludes" ]; then
    run_lark_cli_auth_login_with_browser_open lark-cli --profile "$profile" auth login --domain "$FEISHU_USER_AUTH_DOMAINS" --scope "$FEISHU_USER_AUTH_REQUIRED_SCOPES"
  else
    run_lark_cli_auth_login_with_browser_open lark-cli --profile "$profile" auth login --domain "$FEISHU_USER_AUTH_DOMAINS" --scope "$FEISHU_USER_AUTH_REQUIRED_SCOPES" --exclude "$auth_excludes"
  fi
}

ensure_lark_cli_profile() {
  local app_id="$1"
  local app_secret="$2"
  local profile="$3"
  local auth_excludes
  ensure_lark_cli

  if lark-cli profile list 2>/dev/null | grep -F "\"$profile\"" >/dev/null 2>&1; then
    agent_log "lark-cli profile already exists: $profile"
  else
    [ -n "$app_secret" ] || agent_fail "missing app secret for creating lark-cli profile $profile"
    agent_log "creating lark-cli profile: $profile"
    printf '%s\n' "$app_secret" | lark-cli profile add \
      --name "$profile" \
      --app-id "$app_id" \
      --app-secret-stdin
  fi

  agent_log "ensuring lark-cli user auth domains for profile: $profile"
  auth_excludes="$FEISHU_USER_AUTH_EXCLUDES"
  if lark_cli_user_auth_satisfied "$profile"; then
    agent_log "lark-cli user auth already has required scopes for profile: $profile"
  else
    run_lark_cli_auth_login "$profile" "$auth_excludes"
  fi
}

forget_current_bot_after_feishu_start_failure() {
  agent_log "Feishu bridge failed before ready; removing local bot config for $APP_ID"
  remove_bot_config "$APP_ID"
  clean_bot_instance_configs_preserve_mailbox "$APP_ID" "$LARK_CLI_PROFILE"
  agent_log "Removed local bot config and cleaned stale instance Feishu config while preserving mailbox. Re-run this script and choose 新建应用/选择其他应用 to recreate it."
}

should_forget_bot_after_feishu_failure() {
  [ -n "$FEISHU_LOG" ] && [ -f "$FEISHU_LOG" ] || return 1

  if grep -F 'does not contain a readable app secret' "$FEISHU_LOG" >/dev/null 2>&1; then
    return 0
  fi
  if grep -E 'code=99991672|应用尚未开通所需的应用身份权限|action_scope_required' "$FEISHU_LOG" >/dev/null 2>&1; then
    return 0
  fi

  return 1
}

forget_current_bot_after_feishu_failure_if_needed() {
  if should_forget_bot_after_feishu_failure; then
    forget_current_bot_after_feishu_start_failure
  else
    agent_log "Feishu bridge failed before ready; keeping local bot config for $APP_ID"
  fi
}

select_existing_bot_or_create() {
  local app_ids=()
  local names=()
  local profiles=()
  local app_secrets=()
  local bot_labels=()
  local app_id name profile app_secret
  local index create_index selected

  acquire_bot_selection_lock
  while IFS=$'\t' read -r app_id name profile app_secret; do
    [ -n "$app_id" ] || continue
    app_ids+=("$app_id")
    names+=("${name:-$app_id}")
    profiles+=("$profile")
    app_secrets+=("$app_secret")
    bot_labels+=("${name:-$app_id} ($app_id)")
  done < <(load_bot_configs)

  if [ "${#app_ids[@]}" -eq 0 ]; then
    if has_saved_bot_configs; then
      agent_log "saved Feishu bot(s) are already running; choose new app to start another instance."
      bot_labels+=("新建应用/选择其他应用")
      set +e
      select_bot_menu
      set -e
      release_bot_selection_lock
      register_feishu_app
      return 0
    fi
    release_bot_selection_lock
    register_feishu_app
    return 0
  fi

  create_index=$((${#app_ids[@]} + 1))
  bot_labels+=("新建应用/选择其他应用")

  set +e
  select_bot_menu
  selected=$?
  set -e

  if [ "$selected" -eq $((create_index - 1)) ]; then
    release_bot_selection_lock
    register_feishu_app
    return 0
  fi

  index="$selected"
  APP_ID="${app_ids[$index]}"
  BOT_NAME="${names[$index]}"
  LARK_CLI_PROFILE="${profiles[$index]}"
  APP_SECRET="${app_secrets[$index]:-}"
  reserve_selected_bot "$APP_ID" "$LARK_CLI_PROFILE" "$BOT_NAME"
  release_bot_selection_lock
  agent_log "using Feishu bot: $BOT_NAME ($APP_ID, profile=$LARK_CLI_PROFILE)"
  ensure_lark_cli_profile "$APP_ID" "$APP_SECRET" "$LARK_CLI_PROFILE"
}

register_feishu_app() {
  local workdir
  local register_script
  local register_log
  local register_result_file
  local result_json
  local default_name
  local bot_name

  workdir="$(mktemp -d "${TMPDIR:-/tmp}/aamp-register-feishu-app.XXXXXX")"
  register_script="$workdir/register-app.mjs"
  register_log="$workdir/register-app.log"
  register_result_file="$workdir/register-app-result.json"
  default_name="${AGENT} 飞书 CLI"

  agent_log "preparing Feishu app registration helper"
  npm_install_register_helper "$workdir"

  cat >"$register_script" <<'NODE'
import * as lark from '@larksuiteoapi/node-sdk';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sdkPackage = require('@larksuiteoapi/node-sdk/package.json');

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const tenantScopes = splitList(process.env.FEISHU_APP_SCOPES_TENANT);
const userScopes = splitList(process.env.FEISHU_APP_SCOPES_USER);
const tenantEvents = splitList(process.env.FEISHU_APP_EVENTS_TENANT);
const userEvents = splitList(process.env.FEISHU_APP_EVENTS_USER);
const appName = process.env.FEISHU_APP_PRESET_NAME || '飞书 CLI';

console.log(`[aamp-one-click] registerApp sdk=${sdkPackage.version}`);
console.log(`[aamp-one-click] registerApp appPreset.name=${appName}`);
console.log(`[aamp-one-click] registerApp addons.scopes.tenant=${tenantScopes.join(',') || '(none)'}`);
console.log(`[aamp-one-click] registerApp addons.scopes.user=${userScopes.join(',') || '(none)'}`);
console.log(`[aamp-one-click] registerApp addons.events.items.tenant=${tenantEvents.join(',') || '(none)'}`);
console.log(`[aamp-one-click] registerApp addons.events.items.user=${userEvents.join(',') || '(none)'}`);

const addons = {
  scopes: {
    tenant: tenantScopes,
    user: userScopes,
  },
  events: {
    items: {
      tenant: tenantEvents,
      user: userEvents,
    },
  },
};
console.log(`[aamp-one-click] registerApp addons.json=${JSON.stringify(addons)}`);

const result = await lark.registerApp({
  source: 'aamp-feishu-task-agent',
  appPreset: {
    name: appName,
    desc: 'AAMP Feishu task bridge bot',
  },
  addons,
  onQRCodeReady(info) {
    const url = new URL(info.url);
    console.log('[aamp-one-click] 请在浏览器打开以下链接，创建飞书应用或选择已有应用：');
    console.log(info.url);
    console.log(`[aamp-one-click] registerApp url.has_addons=${url.searchParams.has('addons') ? 'yes' : 'no'}`);
    console.log(`[aamp-one-click] registerApp url.has_name=${url.searchParams.has('name') ? 'yes' : 'no'}`);
    console.log(`[aamp-one-click] 链接将在 ${info.expireIn} 秒后过期`);
    if (process.platform === 'darwin') {
      execFile('open', [info.url], () => {});
    }
  },
  onStatusChange(info) {
    if (info.status === 'polling') return;
    console.log(`[aamp-one-click] registerApp status: ${info.status}`);
  },
});

async function fetchRegisteredAppName(appId, appSecret) {
  try {
    const client = new lark.Client({
      appId,
      appSecret,
    });
    const response = await client.application.application.get({
      path: { app_id: appId },
      params: { lang: 'zh_cn', user_id_type: 'open_id' },
    });
    const app = response?.data?.app;
    return app?.app_name || app?.i18n?.find?.((item) => item?.i18n_key === 'zh_cn')?.name || '';
  } catch (error) {
    console.log(`[aamp-one-click] failed to fetch registered app name; using preset name: ${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
}

const registeredAppName = await fetchRegisteredAppName(result.client_id, result.client_secret);
const resultPayload = {
  app_id: result.client_id,
  app_secret: result.client_secret,
  app_name: registeredAppName || appName,
};
await import('node:fs/promises').then(({ writeFile }) => writeFile(process.env.AAMP_REGISTER_APP_RESULT_FILE, JSON.stringify(resultPayload)));
console.log(`[aamp-one-click] Feishu app registration completed: ${result.client_id}`);
console.log(`[aamp-one-click] Feishu app name: ${resultPayload.app_name}`);
NODE

  agent_log "starting Feishu app registration"
  AAMP_REGISTER_APP_RESULT_FILE="$register_result_file" \
    FEISHU_APP_SCOPES_TENANT="$FEISHU_APP_SCOPES_TENANT" \
    FEISHU_APP_SCOPES_USER="$FEISHU_APP_SCOPES_USER" \
    FEISHU_APP_EVENTS_TENANT="$FEISHU_APP_EVENTS_TENANT" \
    FEISHU_APP_EVENTS_USER="$FEISHU_APP_EVENTS_USER" \
    FEISHU_APP_PRESET_NAME="$default_name" \
    node "$register_script" 2>&1 | tee "$register_log"

  result_json="$(cat "$register_result_file" 2>/dev/null || true)"
  [ -n "$result_json" ] || agent_fail "failed to get app credentials from Feishu app registration"

  APP_ID="$(RESULT_JSON="$result_json" node -e 'const data = JSON.parse(process.env.RESULT_JSON); process.stdout.write(data.app_id || "")')"
  APP_SECRET="$(RESULT_JSON="$result_json" node -e 'const data = JSON.parse(process.env.RESULT_JSON); process.stdout.write(data.app_secret || "")')"
  bot_name="$(RESULT_JSON="$result_json" node -e 'const data = JSON.parse(process.env.RESULT_JSON); process.stdout.write(data.app_name || "")')"
  [ -n "$APP_ID" ] && [ -n "$APP_SECRET" ] || agent_fail "Feishu app registration returned incomplete credentials"

  bot_name="${bot_name:-$default_name}"
  BOT_NAME="$bot_name"
  LARK_CLI_PROFILE="$(task_profile_name_for_app_id "$APP_ID")"
  ensure_lark_cli_profile "$APP_ID" "$APP_SECRET" "$LARK_CLI_PROFILE"
  acquire_bot_selection_lock
  save_bot_config "$bot_name" "$APP_ID" "$LARK_CLI_PROFILE" "$APP_SECRET"
  reserve_selected_bot "$APP_ID" "$LARK_CLI_PROFILE" "$bot_name"
  release_bot_selection_lock
  agent_log "saved Feishu task profile config: $bot_name ($APP_ID, profile=$LARK_CLI_PROFILE)"
}

resolve_feishu_bot_credentials() {
  select_existing_bot_or_create
}

ensure_acpx() {
  if ! command -v acpx >/dev/null 2>&1; then
    agent_log "acpx not found; installing acpx"
    npm_install_global acpx --force
  fi
  acpx --version >/dev/null
}

install_agent_cli() {
  case "$AGENT" in
    codex)
      npm_install_global @openai/codex
      ;;
    claude)
      npm_install_global @anthropic-ai/claude-code
      ;;
    gemini)
      npm_install_global @google/gemini-cli
      ;;
    cursor)
      install_cursor_agent_cli
      ;;
    codem)
      install_codem_cli
      ;;
    *)
      agent_log "no built-in installer for agent: $AGENT"
      return 1
      ;;
  esac
}

ensure_node_major_at_least() {
  local required="$1"
  local major
  major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0')"
  if [ "$major" -lt "$required" ]; then
    agent_fail "Codem requires Node.js >= $required, current version is $(node --version 2>/dev/null || printf 'unknown')"
  fi
}

print_codem_login_notice() {
  cat >&2 <<NOTICE

============================================================
[aamp-one-click] CodeM needs Feishu device binding before the service can run.
[aamp-one-click] Server: $CODEM_SERVER_URL
[aamp-one-click] If a QR code appears, scan it in Feishu or send the shown /bind command to the CodeM bot.
============================================================

NOTICE
}

print_codem_update_notice() {
  cat >&2 <<NOTICE

============================================================
[aamp-one-click] CodeM CLI appears to be out of date or using an old login endpoint.
[aamp-one-click] Running CodeM update automatically, then retrying service start.
[aamp-one-click] If this still fails, run these commands manually:
[aamp-one-click]   codem update -y
[aamp-one-click]   hash -r
[aamp-one-click]   codem service start
============================================================

NOTICE
}

codem_service_output_indicates_update_available() {
  printf '%s' "$1" | grep -E '发现 CodeM CLI 新版本|CodeM CLI 新版本|codem update' >/dev/null 2>&1
}

codem_service_output_indicates_login_required() {
  printf '%s' "$1" | grep -E 'CodeM 尚未登录|尚未登录|oauth/login/create.*404' >/dev/null 2>&1
}

codem_output_indicates_provider_unauthorized() {
  printf '%s' "$1" | grep -Ei 'provider error: unauthorized|unauthorized.*check API key|check API key' >/dev/null 2>&1
}

install_codem_cli() {
  command -v curl >/dev/null 2>&1 || {
    agent_log "curl not found; cannot install Codem CLI automatically"
    return 1
  }

  ensure_node_major_at_least 20
  ensure_codem_local_bin_on_path
  agent_log "installing Codem CLI"
  printf '%s\n' "$CODEM_INSTALLER_CONFIRM" | bash <(curl -fsSL "$CODEM_INSTALLER_URL")
  ensure_codem_local_bin_on_path
  hash -r 2>/dev/null || true
}

codem_config_migration_reason() {
  CODEM_CONFIG_FILE="$HOME/.codem/config.json" CODEM_SERVER_URL="$CODEM_SERVER_URL" node -e '
const fs = require("fs");
const file = process.env.CODEM_CONFIG_FILE;
const expectedServer = process.env.CODEM_SERVER_URL;
let config;
try {
  config = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  process.exit(0);
}

const reasons = [];
if (config.serverUrl && config.serverUrl !== expectedServer) {
  reasons.push(`serverUrl=${config.serverUrl}`);
}
if (config.user && (!config.auth || config.auth.oauth == null)) {
  reasons.push("missing_feishu_oauth");
}
if (reasons.length > 0) {
  process.stdout.write(reasons.join(","));
}
'
}

ensure_codem_breaking_change_compat() {
  local reason
  reason="$(codem_config_migration_reason)"
  [ -n "$reason" ] || return 0

  agent_log "detected pre-migration CodeM config ($reason); refreshing CodeM installer and forcing Feishu OAuth login"
  install_codem_cli || agent_fail "failed to refresh CodeM CLI with installer: $CODEM_INSTALLER_URL"
  run_codem_login_force_once || agent_fail "codem login --force failed after CodeM service migration. Log: $CODEM_LOGIN_LOG"
}

ensure_codem_local_bin_on_path() {
  path_prepend "$CODEM_LOCAL_BIN"
}

ensure_cursor_local_bin_on_path() {
  path_prepend "$CURSOR_LOCAL_BIN"
}

find_cursor_agent_cli() {
  ensure_cursor_local_bin_on_path
  if command -v agent >/dev/null 2>&1; then
    command -v agent
    return 0
  fi
  if command -v cursor-agent >/dev/null 2>&1; then
    command -v cursor-agent
    return 0
  fi
  if [ -x "$CURSOR_LOCAL_BIN/agent" ]; then
    printf '%s\n' "$CURSOR_LOCAL_BIN/agent"
    return 0
  fi
  if [ -x "$CURSOR_LOCAL_BIN/cursor-agent" ]; then
    printf '%s\n' "$CURSOR_LOCAL_BIN/cursor-agent"
    return 0
  fi
  return 1
}

find_cursor_acp_cli() {
  ensure_cursor_local_bin_on_path
  if command -v cursor >/dev/null 2>&1; then
    command -v cursor
    return 0
  fi
  if [ -x "$CURSOR_LOCAL_BIN/cursor" ]; then
    printf '%s\n' "$CURSOR_LOCAL_BIN/cursor"
    return 0
  fi
  return 1
}

ensure_cursor_acp_command() {
  local cursor_agent
  local cursor_wrapper

  if find_cursor_acp_cli >/dev/null 2>&1; then
    return 0
  fi

  cursor_agent="$(find_cursor_agent_cli)" || return 1
  mkdir -p "$NPM_GLOBAL_PREFIX/bin"
  cursor_wrapper="$NPM_GLOBAL_PREFIX/bin/cursor"
  agent_log "creating cursor command wrapper for ACP bridge: $cursor_wrapper -> $cursor_agent"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'cursor_agent=%q\n' "$cursor_agent"
    printf 'exec "$cursor_agent" "$@"\n'
  } > "$cursor_wrapper"
  chmod +x "$cursor_wrapper" 2>/dev/null || true
  hash -r 2>/dev/null || true
  find_cursor_acp_cli >/dev/null 2>&1
}

install_cursor_agent_cli() {
  command -v curl >/dev/null 2>&1 || {
    agent_log "curl not found; cannot install Cursor CLI automatically"
    return 1
  }

  agent_log "installing Cursor CLI"
  ensure_cursor_local_bin_on_path
  curl https://cursor.com/install -fsS | bash
  hash -r 2>/dev/null || true
}

ensure_agent_cli() {
  if [ "$AGENT" = "codem" ]; then
    ensure_codem_local_bin_on_path
  fi

  if [ "$AGENT" = "cursor" ]; then
    if ! find_cursor_agent_cli >/dev/null 2>&1; then
      agent_log "Cursor agent CLI not found"
      agent_log "installing cursor CLI"
      install_agent_cli || agent_fail "failed to install cursor CLI; install it manually with: curl https://cursor.com/install -fsS | bash"
    fi

    find_cursor_agent_cli >/dev/null 2>&1 || agent_fail "cursor CLI is still unavailable; check PATH for $CURSOR_LOCAL_BIN/agent"
    ensure_cursor_acp_command || agent_fail "cursor ACP command is still unavailable; check PATH for $NPM_GLOBAL_PREFIX/bin/cursor"
    return 0
  fi

  if command -v "$AGENT" >/dev/null 2>&1; then
    return 0
  fi

  agent_log "agent CLI not found: $AGENT"
  agent_log "installing $AGENT CLI"
  install_agent_cli || agent_fail "failed to install $AGENT CLI"

  command -v "$AGENT" >/dev/null 2>&1 || agent_fail "$AGENT CLI is still unavailable; check PATH"
}

clear_quarantine_path() {
  is_macos || return 0
  local target="$1"
  [ -n "$target" ] || return 0
  [ -e "$target" ] || [ -L "$target" ] || return 0

  if xattr -dr com.apple.quarantine "$target" 2>/dev/null; then
    return 0
  fi

  agent_log "need elevated permission to clear macOS quarantine for $target"
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo xattr -dr com.apple.quarantine "$target" 2>/dev/null && return 0
  fi

  if command -v sudo >/dev/null 2>&1 && [ -t 0 ]; then
    agent_log "requesting sudo to clear macOS quarantine for $target"
    sudo xattr -dr com.apple.quarantine "$target" && return 0
  fi

  agent_log "warning: failed to clear macOS quarantine for $target"
  agent_log "if macOS blocks this CLI, run: sudo xattr -dr com.apple.quarantine \"$target\""
  return 1
}

clear_cli_quarantine() {
  local label="$1"
  local bin="$2"
  is_macos || return 0
  command -v xattr >/dev/null 2>&1 || return 0
  [ -n "$bin" ] || return 0

  agent_log "clearing macOS quarantine attributes for $label CLI"
  clear_quarantine_path "$bin" || true

  local real
  real="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$bin" 2>/dev/null || true)"
  if [ -n "$real" ] && [ "$real" != "$bin" ]; then
    clear_quarantine_path "$real" || true
  fi

  case "$bin" in
    /Applications/*.app/*)
      local app_bundle
      app_bundle="${bin%%.app/*}.app"
      clear_quarantine_path "$app_bundle" || true
      ;;
  esac

  case "$real" in
    /Applications/*.app/*)
      local app_bundle
      app_bundle="${real%%.app/*}.app"
      clear_quarantine_path "$app_bundle" || true
      ;;
  esac
}

clear_codex_quarantine() {
  is_macos || return 0

  local codex_bin
  codex_bin="$(command -v codex || true)"
  [ -n "$codex_bin" ] || return 0

  clear_cli_quarantine "codex" "$codex_bin"

  local npm_root
  npm_root="$("$NPM_BIN" root -g 2>/dev/null || true)"
  if [ -n "$npm_root" ]; then
    clear_quarantine_path "$npm_root/@openai/codex" || true
  fi

  local npm_prefix
  npm_prefix="$("$NPM_BIN" prefix -g 2>/dev/null || true)"
  if [ -n "$npm_prefix" ]; then
    clear_quarantine_path "$npm_prefix/bin/codex" || true
  fi
}

clear_cursor_quarantine() {
  local cursor_bin
  cursor_bin="$(find_cursor_agent_cli 2>/dev/null || true)"
  [ -n "$cursor_bin" ] || return 0

  clear_cli_quarantine "cursor" "$cursor_bin"
  clear_quarantine_path "$CURSOR_LOCAL_BIN/agent" || true
  clear_quarantine_path "$CURSOR_LOCAL_BIN/cursor-agent" || true
}

print_gatekeeper_help() {
  local label="$1"
  local bin="$2"
  local real="$3"

  cat >&2 <<HELP

macOS blocked $label CLI while starting it.
This is usually caused by Gatekeeper quarantine on the app bundle or CLI binary.

Run these commands, then retry this script:
  sudo xattr -dr com.apple.quarantine "$bin"
HELP

  if [ -n "$real" ] && [ "$real" != "$bin" ]; then
    printf '  sudo xattr -dr com.apple.quarantine "%s"\n' "$real" >&2
  fi

  case "$bin" in
    /Applications/*.app/*)
      printf '  sudo xattr -dr com.apple.quarantine "%s"\n' "${bin%%.app/*}.app" >&2
      ;;
  esac

  case "$real" in
    /Applications/*.app/*)
      printf '  sudo xattr -dr com.apple.quarantine "%s"\n' "${real%%.app/*}.app" >&2
      ;;
  esac

  printf '\n' >&2
}

print_codex_gatekeeper_help() {
  print_gatekeeper_help "codex" "$1" "$2"
}

run_codex_login_status() {
  set +e
  codex login status >/dev/null 2>&1
  local status=$?
  set -e
  if [ "$status" -eq 137 ] && is_macos; then
    local codex_bin
    local codex_real
    codex_bin="$(command -v codex || true)"
    codex_real="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$codex_bin" 2>/dev/null || true)"
    print_codex_gatekeeper_help "$codex_bin" "$codex_real"
    agent_fail "codex CLI was killed by macOS security policy"
  fi
  return "$status"
}

run_codex_login() {
  set +e
  codex login
  local status=$?
  set -e
  if [ "$status" -eq 137 ] && is_macos; then
    local codex_bin
    local codex_real
    codex_bin="$(command -v codex || true)"
    codex_real="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$codex_bin" 2>/dev/null || true)"
    print_codex_gatekeeper_help "$codex_bin" "$codex_real"
    agent_fail "codex CLI was killed by macOS security policy"
  fi
  return "$status"
}

print_cursor_gatekeeper_help() {
  local cursor_bin
  local cursor_real
  cursor_bin="$(find_cursor_agent_cli 2>/dev/null || true)"
  cursor_real="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$cursor_bin" 2>/dev/null || true)"
  print_gatekeeper_help "cursor" "$cursor_bin" "$cursor_real"
}

run_cursor_command() {
  local cursor_bin
  cursor_bin="$(find_cursor_agent_cli)" || return 127
  "$cursor_bin" "$@"
}

run_cursor_login_status() {
  local output
  set +e
  output="$(run_cursor_command status 2>&1)"
  local status=$?
  set -e
  if [ "$status" -eq 137 ] && is_macos; then
    print_cursor_gatekeeper_help
    agent_fail "cursor CLI was killed by macOS security policy"
  fi
  if [ "$status" -ne 0 ]; then
    return "$status"
  fi

  case "$output" in
    *"Not logged in"*|*"not logged in"*|*"Logged out"*|*"logged out"*)
      return 1
      ;;
  esac

  return 0
}

run_cursor_login() {
  set +e
  run_cursor_command login
  local status=$?
  set -e
  if [ "$status" -eq 137 ] && is_macos; then
    print_cursor_gatekeeper_help
    agent_fail "cursor CLI was killed by macOS security policy"
  fi
  return "$status"
}

codem_login_output_indicates_bound() {
  [ -n "$CODEM_LOGIN_LOG" ] || return 1
  grep -E '绑定成功|已经绑定过设备|already bound|already.*bind|bound.*device' "$CODEM_LOGIN_LOG" >/dev/null 2>&1
}

run_codem_service_start() {
  local output
  set +e
  output="$(codem service start 2>&1)"
  local status=$?
  set -e
  CODEM_SERVICE_START_OUTPUT="$output"
  if [ "$status" -eq 0 ]; then
    agent_log "codem service is running"
    return 0
  fi

  agent_log "codem service start failed: $output"
  if codem_service_output_indicates_update_available "$output"; then
    print_codem_update_notice
  fi
  return "$status"
}

run_codem_update_once() {
  if [ "$CODEM_AUTO_UPDATE_DONE" = "true" ]; then
    agent_log "codem update was already attempted in this run; not retrying update"
    return 1
  fi

  CODEM_AUTO_UPDATE_DONE="true"
  agent_log "running codem update"
  set +e
  codem update -y
  local status=$?
  set -e
  hash -r 2>/dev/null || true
  ensure_codem_local_bin_on_path
  if [ "$status" -ne 0 ]; then
    agent_log "codem update failed with status $status"
    return "$status"
  fi
  agent_log "codem update completed"
  return 0
}

run_codem_service_start_with_auto_update() {
  if run_codem_service_start; then
    return 0
  fi

  if codem_service_output_indicates_update_available "$CODEM_SERVICE_START_OUTPUT"; then
    if run_codem_update_once; then
      run_codem_service_start && return 0
    fi
  fi

  return 1
}

run_codem_login() {
  CODEM_LOGIN_LOG="$(mktemp "${TMPDIR:-/tmp}/aamp-codem-login.XXXXXX")"
  print_codem_login_notice
  set +e
  codem login --server "$CODEM_SERVER_URL" 2>&1 | tee "$CODEM_LOGIN_LOG"
  local status=${PIPESTATUS[0]}
  set -e
  return "$status"
}

run_codem_login_force_once() {
  if [ "$CODEM_FORCE_LOGIN_DONE" = "true" ]; then
    agent_log "codem login --force was already attempted in this run; not retrying force login"
    return 1
  fi

  CODEM_FORCE_LOGIN_DONE="true"
  CODEM_LOGIN_LOG="$(mktemp "${TMPDIR:-/tmp}/aamp-codem-login-force.XXXXXX")"
  agent_log "codem still reports login is required after normal login; starting codem login --force"
  print_codem_login_notice
  set +e
  codem login --force --server "$CODEM_SERVER_URL" 2>&1 | tee "$CODEM_LOGIN_LOG"
  local status=${PIPESTATUS[0]}
  set -e
  return "$status"
}

print_codem_provider_auth_notice() {
  cat >&2 <<NOTICE

============================================================
[aamp-one-click] CodeM provider authorization check failed.
[aamp-one-click] CodeM service is running, but the selected model/provider returned unauthorized.
[aamp-one-click] This is usually caused by an old CodeM installation, stale login, or an unavailable selected model.
[aamp-one-click] The script will refresh CodeM and force login once, then retry the provider check.
[aamp-one-click] If it still fails, run these commands manually:
[aamp-one-click]   curl -fsSL $CODEM_INSTALLER_URL | bash
[aamp-one-click]   codem login --force --server "$CODEM_SERVER_URL"
[aamp-one-click]   codem select-model
[aamp-one-click]   codem service start
============================================================

NOTICE
}

run_codem_provider_preflight() {
  [ "$CODEM_PROVIDER_PREFLIGHT" = "false" ] && {
    agent_log "codem provider preflight disabled by CODEM_PROVIDER_PREFLIGHT=false"
    return 0
  }

  local session
  local output_file
  local output
  local status
  local pid
  local waited
  local prompt
  session="aamp-codem-preflight-$(date +%s)-$$"
  output_file="$(mktemp "${TMPDIR:-/tmp}/aamp-codem-provider-preflight.XXXXXX")"
  agent_log "checking CodeM provider authorization with isolated session: $session"
  prompt="Use the bash tool to run: echo AAMP_CODEM_PREFLIGHT_TOOL_OK. After the tool result is available, reply exactly: AAMP_CODEM_PREFLIGHT_FINAL_OK"

  set +e
  codem -p "$prompt" --sse --yolo --session "$session" >"$output_file" 2>&1 &
  pid=$!
  waited=0
  status=0
  while kill -0 "$pid" >/dev/null 2>&1; do
    if [ "$waited" -ge "$CODEM_PROVIDER_PREFLIGHT_TIMEOUT_SECONDS" ]; then
      kill "$pid" >/dev/null 2>&1 || true
      wait "$pid" >/dev/null 2>&1
      status=124
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  if [ "$status" -ne 124 ]; then
    wait "$pid"
    status=$?
  fi
  set -e

  output="$(cat "$output_file" 2>/dev/null || true)"
  rm -f "$output_file" 2>/dev/null || true

  if [ "$status" -eq 0 ] && printf '%s' "$output" | grep -F 'AAMP_CODEM_PREFLIGHT_FINAL_OK' >/dev/null 2>&1; then
    agent_log "codem provider authorization check passed"
    return 0
  fi

  if codem_output_indicates_provider_unauthorized "$output"; then
    agent_log "codem provider authorization check failed: unauthorized"
    return 2
  fi

  if [ "$status" -eq 124 ]; then
    agent_log "codem provider authorization check timed out after ${CODEM_PROVIDER_PREFLIGHT_TIMEOUT_SECONDS}s; continuing"
    return 0
  fi

  if [ "$status" -eq 0 ]; then
    agent_log "codem provider authorization check did not produce final marker; continuing. Output: $output"
    return 0
  fi

  agent_log "codem provider authorization check returned status $status; continuing. Output: $output"
  return 0
}

recover_codem_provider_auth_once() {
  if [ "$CODEM_PROVIDER_RECOVERY_DONE" = "true" ]; then
    agent_log "codem provider recovery was already attempted in this run; not retrying"
    return 1
  fi

  CODEM_PROVIDER_RECOVERY_DONE="true"
  print_codem_provider_auth_notice
  install_codem_cli || agent_log "warning: failed to refresh CodeM CLI with installer: $CODEM_INSTALLER_URL"
  run_codem_login_force_once || agent_log "warning: codem login --force failed. Log: $CODEM_LOGIN_LOG"
  run_codem_service_start_with_auto_update || agent_log "warning: codem service start still failed after provider recovery"
}

ensure_codem_provider_ready() {
  local status
  set +e
  run_codem_provider_preflight
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    return 0
  fi
  if [ "$status" -ne 2 ]; then
    return "$status"
  fi

  recover_codem_provider_auth_once || true

  set +e
  run_codem_provider_preflight
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    return 0
  fi
  if [ "$status" -eq 2 ]; then
    agent_fail "codem provider authorization is still failing; run 'codem select-model' or refresh/login CodeM manually, then restart this script"
  fi
  return "$status"
}

ensure_agent_login() {
  case "$AGENT" in
    codex)
      clear_codex_quarantine
      if ! run_codex_login_status; then
        agent_log "codex CLI is not logged in; starting codex login"
        run_codex_login
        run_codex_login_status || agent_fail "codex CLI is still not logged in"
      fi
      ;;
    cursor)
      clear_cursor_quarantine
      if run_cursor_login_status; then
        agent_log "cursor CLI is already logged in"
      else
        agent_log "cursor CLI is not logged in or login status is unavailable; starting cursor login"
        run_cursor_login
        run_cursor_login_status || agent_fail "cursor CLI is still not logged in"
      fi
      ;;
    codem)
      ensure_codem_local_bin_on_path
      codem --version >/dev/null
      ensure_codem_breaking_change_compat
      if run_codem_service_start_with_auto_update; then
        agent_log "codem service is ready; continuing"
        ensure_codem_provider_ready
        return 0
      fi
      if codem_service_output_indicates_update_available "$CODEM_SERVICE_START_OUTPUT"; then
        agent_fail "codem service start failed after attempting CodeM update; run 'codem update -y' and 'codem service start' manually to inspect the error"
      fi

      agent_log "codem service is not ready; checking Codem device binding"
      if codem_service_output_indicates_login_required "$CODEM_SERVICE_START_OUTPUT"; then
        agent_log "codem service reports login is required; starting explicit codem login"
      fi
      if ! run_codem_login && ! codem_login_output_indicates_bound; then
        agent_fail "codem login failed. Log: $CODEM_LOGIN_LOG"
      fi
      if run_codem_service_start_with_auto_update; then
        agent_log "codem device is bound and service is running; continuing"
        ensure_codem_provider_ready
        return 0
      fi
      if codem_service_output_indicates_login_required "$CODEM_SERVICE_START_OUTPUT"; then
        run_codem_login_force_once || agent_fail "codem login --force failed. Log: $CODEM_LOGIN_LOG"
      fi
      run_codem_service_start_with_auto_update || {
        if codem_service_output_indicates_update_available "$CODEM_SERVICE_START_OUTPUT"; then
          agent_fail "codem service start failed after attempting CodeM update; run 'codem update -y' and 'codem service start' manually to inspect the error"
        fi
        agent_fail "codem service start failed after binding check; run 'codem service start' manually to inspect the error"
      }
      agent_log "codem device is bound and service is running; continuing"
      ensure_codem_provider_ready
      ;;
    claude|gemini)
      "$AGENT" --version >/dev/null
      ;;
    *)
      "$AGENT" --version >/dev/null 2>&1 || true
      ;;
  esac
}

run_acp_bridge() {
  npx_package --package "$ACP_BRIDGE_PKG" aamp-acp-bridge "$@"
}

run_cli_bridge() {
  npx_package --package "$CLI_BRIDGE_PKG" aamp-cli-bridge "$@"
}

run_feishu_bridge() {
  npx_package --package "$FEISHU_BRIDGE_PKG" aamp-feishu-bridge "$@"
}

uses_cli_bridge() {
  [ "$AGENT" = "codem" ]
}

resolve_codex_cli_for_acp() {
  if is_macos && [ -x "$CODEX_APP_CLI" ]; then
    printf '%s\n' "$CODEX_APP_CLI"
    return 0
  fi

  command -v codex
}

build_acp_agent_command() {
  ACP_AGENT_COMMAND="$AGENT"
  if [ "$AGENT" != "codex" ]; then
    return 0
  fi

  local codex_bin
  codex_bin="$(resolve_codex_cli_for_acp)" || agent_fail "codex CLI is unavailable after installation"
  ACP_AGENT_COMMAND="env CODEX_PATH=$codex_bin npx -y $CODEX_ACP_PKG"
  agent_log "using fixed Codex ACP command: CODEX_PATH=$codex_bin $CODEX_ACP_PKG"
}

validate_codex_acp_command() {
  [ "$AGENT" = "codex" ] || return 0

  local output
  set +e
  output="$(acpx --approve-all --cwd "$PWD" --timeout 30 --agent "$ACP_AGENT_COMMAND" sessions ensure --name aamp-one-click-probe 2>&1)"
  local status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    agent_log "Codex ACP command validation failed:"
    printf '%s\n' "$output" >&2
    agent_fail "codex ACP command is unavailable; check Codex.app or reinstall codex CLI"
  fi
}

start_acp_bridge_and_capture_pairing_url() {
  ACP_LOG="$(mktemp "${TMPDIR:-/tmp}/aamp-acp-bridge.XXXXXX")"
  agent_log "initializing ACP bridge; log: $ACP_LOG"

  local init_payload
  local init_output
  init_payload="$(AAMP_HOST="$AAMP_HOST" AGENT="$AGENT" ACP_AGENT_COMMAND="$ACP_AGENT_COMMAND" node -e 'process.stdout.write(JSON.stringify({ aampHost: process.env.AAMP_HOST, agents: [{ name: process.env.AGENT, acpCommand: process.env.ACP_AGENT_COMMAND, createPairing: true }] }))')"

  set +e
  init_output="$(printf '%s' "$init_payload" | run_acp_bridge init --json 2>&1)"
  local init_status=$?
  set -e
  printf '%s\n' "$init_output" | tee "$ACP_LOG" >/dev/null
  if [ "$init_status" -ne 0 ]; then
    agent_fail "ACP bridge init failed. Log: $ACP_LOG"
  fi

  PAIRING_URL="$(printf '%s' "$init_output" | node -e 'let input = ""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => { const start = input.indexOf("{"); const end = input.lastIndexOf("}"); if (start < 0 || end < start) return; const data = JSON.parse(input.slice(start, end + 1)); process.stdout.write(data.agents?.[0]?.pairing?.connectUrl || ""); });')"
  [ -n "$PAIRING_URL" ] || agent_fail "ACP bridge init did not return a pairing URL. Log: $ACP_LOG"
  agent_log "captured Pairing URL"

  agent_log "starting ACP bridge; log: $ACP_LOG"
  local command=(
    start
    --agent "$AGENT"
  )
  if [ "$DEBUG_MODE" = "true" ]; then
    command+=(--debug)
  fi

  start_logged_bridge "$ACP_LOG" ACP_TAIL_PID append run_acp_bridge "${command[@]}"
  ACP_PID="$STARTED_BRIDGE_PID"

  for _ in $(seq 1 90); do
    if ! kill -0 "$ACP_PID" 2>/dev/null; then
      agent_fail "ACP bridge exited before becoming ready. Log: $ACP_LOG"
    fi
    if grep -E 'Bridge running with|agent\(s\):' "$ACP_LOG" >/dev/null 2>&1; then
      agent_log "ACP bridge is ready"
      return 0
    fi
    sleep 1
  done

  agent_fail "timed out waiting for ACP bridge readiness. Log: $ACP_LOG"
}

start_cli_bridge_and_capture_pairing_url() {
  CLI_LOG="$(mktemp "${TMPDIR:-/tmp}/aamp-cli-bridge.XXXXXX")"
  agent_log "starting CLI bridge; log: $CLI_LOG"
  if [ "$DEBUG_MODE" = "true" ]; then
    export AAMP_CLI_BRIDGE_DEBUG_TASK=1
    export AAMP_CLI_BRIDGE_DEBUG_PROMPT=1
    export AAMP_CLI_BRIDGE_DEBUG_RESULT=1
    export AAMP_CLI_BRIDGE_DEBUG_CLI=1
    agent_log "CLI bridge debug logging enabled: raw prompt/result will be written to $CLI_LOG"
  fi

  local command=(
    init
    --agent "$AGENT"
    --aamp-host "$AAMP_HOST"
    --connection-setup pairing-code
  )
  if [ "$DEBUG_MODE" = "true" ]; then
    command+=(--debug)
  fi

  start_logged_bridge "$CLI_LOG" CLI_TAIL_PID write run_cli_bridge "${command[@]}"
  CLI_PID="$STARTED_BRIDGE_PID"

  for _ in $(seq 1 90); do
    if ! kill -0 "$CLI_PID" 2>/dev/null; then
      agent_fail "CLI bridge exited before emitting Pairing URL. Log: $CLI_LOG"
    fi
    PAIRING_URL="$(grep -Eo 'aamp://connect[^[:space:]]+' "$CLI_LOG" | tail -1 || true)"
    if [ -n "$PAIRING_URL" ]; then
      agent_log "captured Pairing URL"
      return 0
    fi
    sleep 1
  done

  agent_fail "timed out waiting for Pairing URL. Log: $CLI_LOG"
}

start_feishu_task_bridge() {
  FEISHU_LOG="$(mktemp "${TMPDIR:-/tmp}/aamp-feishu-bridge.XXXXXX")"
  agent_log "starting Feishu bridge with task enabled; log: $FEISHU_LOG"
  agent_log "Feishu bridge profile: app=$APP_ID lark-cli-profile=$LARK_CLI_PROFILE use-feishu-cli=yes"
  local command=(
    start
    --enable-task
    --aamp-host "$AAMP_HOST" \
    --agent "$AGENT" \
    --app-id "$APP_ID" \
    --use-feishu-cli \
    --feishu-cli-profile "$LARK_CLI_PROFILE" \
    --pairing-url "$PAIRING_URL"
  )

  if [ -n "$APP_SECRET" ]; then
    command+=(--app-secret "$APP_SECRET")
  fi
  if [ "${#FEISHU_ENV_ARGS[@]}" -gt 0 ]; then
    command+=("${FEISHU_ENV_ARGS[@]}")
  fi
  if [ "$DEBUG_MODE" = "true" ]; then
    command+=(--debug)
  fi

  start_logged_bridge "$FEISHU_LOG" FEISHU_TAIL_PID write run_feishu_bridge "${command[@]}"
  FEISHU_PID="$STARTED_BRIDGE_PID"

  for _ in $(seq 1 90); do
    if ! kill -0 "$FEISHU_PID" 2>/dev/null; then
      agent_log "Feishu bridge exited before becoming ready. Log: $FEISHU_LOG"
      agent_log "last 80 lines from Feishu bridge log:"
      tail -80 "$FEISHU_LOG" >&2 || true
      forget_current_bot_after_feishu_failure_if_needed
      agent_fail "Feishu bridge exited before ready"
    fi

    if grep -E 'Feishu bridge IM \+ Task is running for|bridge.task_runtime.running|\[feishu\] listener started|\[feishu ws\] connected' "$FEISHU_LOG" >/dev/null 2>&1; then
      agent_log "Feishu bridge is ready. Keep this terminal open. Press Ctrl+C to stop."
      return 0
    fi

    sleep 1
  done

  agent_log "timed out waiting for Feishu bridge readiness. Log: $FEISHU_LOG"
  agent_log "last 80 lines from Feishu bridge log:"
  tail -80 "$FEISHU_LOG" >&2 || true
  forget_current_bot_after_feishu_failure_if_needed
  agent_fail "timed out waiting for Feishu bridge readiness"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  release_selected_bot_reservation
  release_bot_selection_lock
  if [ -n "$FEISHU_TAIL_PID" ]; then
    kill "$FEISHU_TAIL_PID" 2>/dev/null || true
  fi
  if [ -n "$CLI_TAIL_PID" ]; then
    kill "$CLI_TAIL_PID" 2>/dev/null || true
  fi
  if [ -n "$ACP_TAIL_PID" ]; then
    kill "$ACP_TAIL_PID" 2>/dev/null || true
  fi
  if [ -n "$FEISHU_PID" ]; then
    kill_process_tree "$FEISHU_PID"
  fi
  if [ -n "$CLI_PID" ]; then
    kill_process_tree "$CLI_PID"
  fi
  if [ -n "$ACP_PID" ]; then
    kill_process_tree "$ACP_PID"
  fi
  exit "$status"
}

main() {
  trap cleanup EXIT INT TERM

  parse_args "$@"
  # Do not clean globally by default: users may run one-click scripts in
  # multiple terminals. Cleanup on exit is limited to pids started by this run.
  cleanup_stale_one_click_processes
  ensure_node_toolchain
  build_feishu_env_args
  source_lark_env
  resolve_feishu_bot_credentials
  if ! uses_cli_bridge; then
    ensure_acpx
  fi
  ensure_agent_cli
  ensure_agent_login
  if uses_cli_bridge; then
    start_cli_bridge_and_capture_pairing_url
  else
    build_acp_agent_command
    validate_codex_acp_command
    start_acp_bridge_and_capture_pairing_url
  fi
  start_feishu_task_bridge

  wait
}

main "$@"
