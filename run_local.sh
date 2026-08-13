cd /Users/bytedance/WsCodex/LuckyTerry/aamp

for p in packages/aamp-acp-bridge packages/aamp-cli-bridge packages/aamp-feishu-bridge; do
  (cd "$p" && npm install && npm run build && npm run prepare-bin)
done

ACP_BRIDGE_PKG="file:$PWD/packages/aamp-acp-bridge" \
CLI_BRIDGE_PKG="file:$PWD/packages/aamp-cli-bridge" \
FEISHU_BRIDGE_PKG="file:$PWD/packages/aamp-feishu-bridge" \
bash packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh --debug
