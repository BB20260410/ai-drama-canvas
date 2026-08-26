#!/usr/bin/env bash
# 把仓库内 TokenRouter 入口装到 ~/.grok/bin。
# 运行时只打 https://api.tokenrouter.com/v1 ；不写密钥，不打官方千问 / 火山 / OpenAI。
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/scripts/tokenrouter"
dest="${HOME}/.grok/bin"

if [[ ! -f "$src/tr_chat" || ! -f "$src/novel_chat.py" ]]; then
  echo "缺少 $src/tr_chat 或 novel_chat.py" >&2
  exit 2
fi

mkdir -p "$dest"
chmod 700 "${HOME}/.grok" "$dest"
install -m 755 "$src/tr_chat" "$dest/tr_chat"
install -m 755 "$src/novel_chat.py" "$dest/novel_chat.py"

if [[ -n "${TOKENROUTER_API_KEY:-}" ]]; then
  umask 077
  # 不 echo Key。只在 Cloud 已注入环境变量时生成本机 env.local。
  python3 - <<'PY'
import os
from pathlib import Path
key = os.environ["TOKENROUTER_API_KEY"]
path = Path.home() / ".grok" / "env.local"
path.write_text(f"TOKENROUTER_API_KEY={key}\n", encoding="utf-8")
path.chmod(0o600)
PY
fi

echo "installed $dest/tr_chat"
echo "installed $dest/novel_chat.py"
if [[ -f "${HOME}/.grok/env.local" ]]; then
  echo "env.local present (chmod 600)"
else
  echo "env.local absent; export TOKENROUTER_API_KEY or fill Cloud Secret"
fi
