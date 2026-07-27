# 关键 smoke / validate 别名索引（Qwen E1）

> 禁止 rename 产线脚本路径；仅在 `package.json` 增加薄别名。  
> 更新：2026-07-24

| npm 别名 | 实际命令 | 用途 |
|----------|----------|------|
| `smoke:mcp` | `tsx scripts/mcp-smoke.ts` | MCP 基础冒烟 |
| `smoke:mcp-headless` | `tsx scripts/mcp-headless-workflow-smoke.ts` | 无头工作流 |
| `smoke:s1e2-mcp-only-status` | `s1e2-mcp-only-runner status` | 隔离工程租约/闸状态 |
| `smoke:s1e2-mcp-only-earliest` | `s1e2-mcp-only-runner earliest` | 集 earliest 投影 |
| `smoke:ssl0-core` | `s1e2-ssl0-core-query.ts` | SSL-0 Core 投影 |
| `smoke:ssl3-align` | `s1e2-ssl3-script-media-align.ts` | SSL-3 图文对照 |
| `smoke:ssl4-wizard` | `s1e2-ssl4-storyboard-wizard.ts` | SSL-4 向导（会写 demo unit） |
| `smoke:goal-projection` | vitest 投影相关单测包 | 游标/SSL/向导快速回归 |
| `mcp:only-runner` | 既有 | 正式 formal 环 |
| `validate:p9-reliability` 等 | 既有 | 关账 validate 勿改名 |

**纪律**：别名失败不得假 PASS；`ssl4-wizard` 会物化 demo unit，勿在正式工程跑。
