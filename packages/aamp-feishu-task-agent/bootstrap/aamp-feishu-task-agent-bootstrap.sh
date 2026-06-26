#!/usr/bin/env bash
set -euo pipefail

AGENT=""
APP_ID=""
APP_SECRET=""
ENV_NAME="online"
BOE_ENV_NAME="boe_task_event"
AAMP_HOST="https://meshmail.ai"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"
NPM_CACHE_DIR="${NPM_CONFIG_CACHE:-${npm_config_cache:-${TMPDIR:-/tmp}/aamp-one-click-npm-cache}}"
NPM_GLOBAL_PREFIX="${NPM_GLOBAL_PREFIX:-$HOME/.aamp/npm-global}"
CODEM_RD_NETWORK_URL="https://netsegment.bytedance.net/apply/rd-network"
ACP_BRIDGE_PKG="${ACP_BRIDGE_PKG:-@zengxingyuan/aamp-acp-bridge@0.1.28-dev.12}"
CLI_BRIDGE_PKG="${CLI_BRIDGE_PKG:-@zengxingyuan/aamp-cli-bridge@0.1.7-dev.4}"
FEISHU_BRIDGE_PKG="${FEISHU_BRIDGE_PKG:-@zengxingyuan/aamp-feishu-task-bridge@0.1.1-dev.11}"

ACP_PID=""
CLI_PID=""
FEISHU_PID=""
ACP_LOG=""
CLI_LOG=""
FEISHU_LOG=""
CODEM_LOGIN_LOG=""
PAIRING_URL=""
FEISHU_ENV_ARGS=()
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
  aamp-feishu-task-agent --agent codex --app-id cli_xxx --app-secret xxx [options]

Options:
  --env online|pre|boe       Runtime environment. Default: online
  --boe-env-name NAME        BOE x-tt-env value. Default: boe_task_event
  --aamp-host URL            AAMP service URL. Default: https://meshmail.ai
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
  case ":$PATH:" in
    *":$NPM_GLOBAL_PREFIX/bin:"*) ;;
    *) export PATH="$NPM_GLOBAL_PREFIX/bin:$PATH" ;;
  esac
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
  sanitize_inherited_npm_exec_env
  "$NPM_BIN" install -g \
    --registry "$NPM_REGISTRY" \
    --cache "$NPM_CACHE_DIR" \
    --prefix "$NPM_GLOBAL_PREFIX" \
    "$@"
  hash -r 2>/dev/null || true
}

npx_package() {
  sanitize_inherited_npm_exec_env
  "$NPX_BIN" -y --registry "$NPM_REGISTRY" --cache "$NPM_CACHE_DIR" "$@"
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --agent)
        AGENT="${2:-}"
        shift 2
        ;;
      --app-id)
        APP_ID="${2:-}"
        shift 2
        ;;
      --app-secret)
        APP_SECRET="${2:-}"
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
      -h|--help)
        usage
        exit 0
        ;;
      *)
        agent_fail "unknown argument: $1"
        ;;
    esac
  done

  [ -n "$AGENT" ] || agent_fail "missing --agent"
  [ -n "$APP_ID" ] || agent_fail "missing --app-id"
  [ -n "$APP_SECRET" ] || agent_fail "missing --app-secret"

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
      unset LARKSUITE_CLI_CONFIG_DIR
      unset LARK_CLI_NO_PROXY
      log "pre enabled, proxy=$HTTPS_PROXY"
      ;;
    boe)
      export HTTPS_PROXY="http://127.0.0.1:8899"
      export https_proxy="$HTTPS_PROXY"
      export HTTP_PROXY="$HTTPS_PROXY"
      export http_proxy="$HTTPS_PROXY"
      export ALL_PROXY="$HTTPS_PROXY"
      export all_proxy="$HTTPS_PROXY"
      unset LARK_CLI_NO_PROXY
      mkdir -p "$HOME/.lark-cli-boe"
      export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-boe"
      log "boe enabled, proxy=$HTTPS_PROXY, LARKSUITE_CLI_CONFIG_DIR=$LARKSUITE_CLI_CONFIG_DIR"
      ;;
    online|off)
      unset HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy
      unset LARKSUITE_CLI_CONFIG_DIR
      unset LARK_CLI_NO_PROXY
      log "online enabled, proxy env cleared"
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
  chmod +x "$target"
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

install_global_npm_package() {
  local package_name="$1"
  npm_install_global "$package_name"
}

ensure_lark_cli() {
  if ! command -v lark-cli >/dev/null 2>&1; then
    agent_log "lark-cli not found; installing @larksuite/cli"
    install_global_npm_package "@larksuite/cli"
  fi

  source_lark_env

  if ! lark-cli auth status --verify >/dev/null 2>&1; then
    agent_log "lark-cli is not initialized or token verification failed; initializing with supplied app credentials"
    printf '%s' "$APP_SECRET" | lark-cli config init \
      --app-id "$APP_ID" \
      --app-secret-stdin \
      --brand feishu

    lark-cli auth status --verify >/dev/null 2>&1 || {
      agent_fail "lark-cli remains unavailable after init; check app_id/app_secret, app permissions, and app publish status"
    }
  fi
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

print_codem_rd_network_notice() {
  cat >&2 <<NOTICE

============================================================
[aamp-one-click] CodeM requires ByteDance RD network access.
[aamp-one-click] 非研发同学如果卡在 CodeM 绑定/扫码页面，请先申请「研发网络权限」：
[aamp-one-click] $CODEM_RD_NETWORK_URL
[aamp-one-click] 权限生效后重新运行本脚本。
============================================================

NOTICE
}

install_codem_cli() {
  command -v curl >/dev/null 2>&1 || {
    agent_log "curl not found; cannot install Codem CLI automatically"
    return 1
  }

  ensure_node_major_at_least 20
  ensure_codem_local_bin_on_path
  print_codem_rd_network_notice
  agent_log "installing Codem CLI"
  agent_log "installing Codem Feishu integration by default"
  printf 'y\n' | bash <(curl -fsSL https://sf-unpkg-src.bytedance.net/@byted-meego/codem-installer@latest/install.sh)
  ensure_codem_local_bin_on_path
  hash -r 2>/dev/null || true
}

ensure_codem_local_bin_on_path() {
  case ":$PATH:" in
    *":$CODEM_LOCAL_BIN:"*) ;;
    *) export PATH="$CODEM_LOCAL_BIN:$PATH" ;;
  esac
}

ensure_cursor_local_bin_on_path() {
  case ":$PATH:" in
    *":$CURSOR_LOCAL_BIN:"*) ;;
    *) export PATH="$CURSOR_LOCAL_BIN:$PATH" ;;
  esac
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
  chmod +x "$cursor_wrapper"
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
  [ "$(uname -s 2>/dev/null || true)" = "Darwin" ] || return 0
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
  [ "$(uname -s 2>/dev/null || true)" = "Darwin" ] || return 0

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
  if [ "$status" -eq 137 ]; then
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
  if [ "$status" -eq 137 ]; then
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
  if [ "$status" -eq 137 ]; then
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
  if [ "$status" -eq 137 ]; then
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
  if [ "$status" -eq 0 ]; then
    agent_log "codem service is running"
    return 0
  fi

  agent_log "codem service start failed: $output"
  return "$status"
}

run_codem_login() {
  CODEM_LOGIN_LOG="$(mktemp "${TMPDIR:-/tmp}/aamp-codem-login.XXXXXX")"
  print_codem_rd_network_notice
  set +e
  codem login 2>&1 | tee "$CODEM_LOGIN_LOG"
  local status=${PIPESTATUS[0]}
  set -e
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
      if run_codem_service_start; then
        agent_log "codem service is ready; continuing"
        return 0
      fi

      agent_log "codem service is not ready; checking Codem device binding"
      if ! run_codem_login && ! codem_login_output_indicates_bound; then
        agent_fail "codem login failed. Log: $CODEM_LOGIN_LOG"
      fi
      run_codem_service_start || agent_fail "codem service start failed after binding check; run 'codem service start' manually to inspect the error"
      agent_log "codem device is bound and service is running; continuing"
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
  npx_package --package "$FEISHU_BRIDGE_PKG" aamp-feishu-task-bridge "$@"
}

uses_cli_bridge() {
  [ "$AGENT" = "codem" ]
}

start_acp_bridge_and_capture_pairing_url() {
  ACP_LOG="$(mktemp "${TMPDIR:-/tmp}/aamp-acp-bridge.XXXXXX")"
  agent_log "starting ACP bridge; log: $ACP_LOG"

  run_acp_bridge init \
    --agent "$AGENT" \
    --aamp-host "$AAMP_HOST" \
    --connection-setup pairing-code \
    --debug 2>&1 | tee "$ACP_LOG" &

  ACP_PID=$!

  for _ in $(seq 1 90); do
    if ! kill -0 "$ACP_PID" 2>/dev/null; then
      agent_fail "ACP bridge exited before emitting Pairing URL. Log: $ACP_LOG"
    fi
    PAIRING_URL="$(grep -Eo 'aamp://connect[^[:space:]]+' "$ACP_LOG" | tail -1 || true)"
    if [ -n "$PAIRING_URL" ]; then
      agent_log "captured Pairing URL"
      return 0
    fi
    sleep 1
  done

  agent_fail "timed out waiting for Pairing URL. Log: $ACP_LOG"
}

start_cli_bridge_and_capture_pairing_url() {
  CLI_LOG="$(mktemp "${TMPDIR:-/tmp}/aamp-cli-bridge.XXXXXX")"
  agent_log "starting CLI bridge; log: $CLI_LOG"

  run_cli_bridge init \
    --agent "$AGENT" \
    --aamp-host "$AAMP_HOST" \
    --connection-setup pairing-code 2>&1 | tee "$CLI_LOG" &

  CLI_PID=$!

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
  FEISHU_LOG="$(mktemp "${TMPDIR:-/tmp}/aamp-feishu-task-bridge.XXXXXX")"
  agent_log "starting Feishu task bridge; log: $FEISHU_LOG"
  local command=(
    init
    --aamp-host "$AAMP_HOST" \
    --app-id "$APP_ID" \
    --app-secret "$APP_SECRET" \
    --pairing-url "$PAIRING_URL"
  )

  if [ "${#FEISHU_ENV_ARGS[@]}" -gt 0 ]; then
    command+=("${FEISHU_ENV_ARGS[@]}")
  fi
  command+=(--debug)

  run_feishu_bridge "${command[@]}" 2>&1 | tee "$FEISHU_LOG" &

  FEISHU_PID=$!

  for _ in $(seq 1 90); do
    if ! kill -0 "$FEISHU_PID" 2>/dev/null; then
      agent_log "Feishu task bridge exited before becoming ready. Log: $FEISHU_LOG"
      tail -80 "$FEISHU_LOG" >&2 || true
      agent_fail "Feishu task bridge exited before ready"
    fi

    if grep -E 'Feishu task bridge is running for|\[feishu\] listener started|\[feishu ws\] connected' "$FEISHU_LOG" >/dev/null 2>&1; then
      agent_log "Feishu task bridge is ready. Keep this terminal open. Press Ctrl+C to stop."
      return 0
    fi

    sleep 1
  done

  agent_log "timed out waiting for Feishu task bridge readiness. Log: $FEISHU_LOG"
  agent_log "last 80 lines from Feishu task bridge log:"
  tail -80 "$FEISHU_LOG" >&2 || true
  agent_fail "timed out waiting for Feishu task bridge readiness"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [ -n "$FEISHU_PID" ]; then
    kill "$FEISHU_PID" 2>/dev/null || true
  fi
  if [ -n "$CLI_PID" ]; then
    kill "$CLI_PID" 2>/dev/null || true
  fi
  if [ -n "$ACP_PID" ]; then
    kill "$ACP_PID" 2>/dev/null || true
  fi
  exit "$status"
}

main() {
  trap cleanup EXIT INT TERM

  parse_args "$@"
  ensure_node_toolchain
  build_feishu_env_args
  ensure_lark_cli
  if ! uses_cli_bridge; then
    ensure_acpx
  fi
  ensure_agent_cli
  ensure_agent_login
  if uses_cli_bridge; then
    start_cli_bridge_and_capture_pairing_url
  else
    start_acp_bridge_and_capture_pairing_url
  fi
  start_feishu_task_bridge

  wait
}

main "$@"
