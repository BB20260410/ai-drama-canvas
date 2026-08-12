#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
workspace_root=$(dirname -- "$script_dir")
node_executable=${npm_node_execpath:-$(command -v node)}

# Node 会在应用代码执行前消费 NODE_OPTIONS，因此正式 shell 入口必须先清掉
# Node loader 变量。DYLD_*/LD_* 不能在子进程内部补救（动态链接器更早消费）；
# 它们保留给稳定 launcher 检出并失败关闭，调用方自身必须使用可信启动环境。
exec /usr/bin/env \
  -u NODE_OPTIONS \
  -u NODE_PATH \
  "$node_executable" "$workspace_root/.aicanvas-runtime/mcp-launcher/current.mjs" "$@"
