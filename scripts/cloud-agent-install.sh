#!/usr/bin/env bash
# Cloud Agent 仓库引导：幂等、必须结束。
# 不启动 Electron / 开发服务器 / 测试；不要求 TOKENROUTER_API_KEY。
set -euo pipefail

cd "$(dirname "$0")/.."

npm ci

if [[ -f scripts/install-tokenrouter-cli.sh ]]; then
  bash scripts/install-tokenrouter-cli.sh
fi
