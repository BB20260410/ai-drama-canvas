# 产品接线残余关账（2026-07-23）

## 交付

| 项 | 内容 |
|----|------|
| 真 ffmpeg 合成 | `executeStudioShotCompose` 静帧→mp4 本机实测 |
| MCP | `evaluate_studio_fusion_helper`（12 operation）+ `execute_studio_shot_compose_local` |
| 拆格草稿 | `videoPromptScaffold` 按时码写出 |
| Codex 工具表 | managedStudio 列表含新工具 |
| 身份 | mcpToolCount **191**；build identity 已重冻 |

## 验证

- typecheck PASS
- `tests/studio-fusion-product-wiring.test.ts` PASS（含真实 ffmpeg）
- `tests/studio-storyboard-draft.test.ts` 12 PASS
- fusion remaining + product wiring tests PASS

## 仍非 live

- LIVE_CODEX=0：未跑真实 Codex 生图 canary（无授权额度策略延续）
- 合成结果默认不自动 commit CAS；调用方须再走登记/Review

## 阶段

`FUSION_PRODUCT_WIRING_CLOSED`
