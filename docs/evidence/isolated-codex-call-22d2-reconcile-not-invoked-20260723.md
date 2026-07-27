# 隔离 Codex call 22d2 · not-invoked 对账

> 时间：2026-07-23 02:37 +0800
> 工程：`projects/grok-mvp-qingdeng-mrwc97mu-d0aea463`（project-c78607fac2a4）
> 操作者：Grok 新会话续跑（前会话中断后恢复）

## 背景

上一会话（resume `019f8ac9-c47c-7da2-a0fb-3133c65d1f49`）执行中途回到 shell，平台唯一剩余任务为：
`RECONCILE_ISOLATED_CODEX_CALL_22D2_UNKNOWN_ONLY`。

## 现场事实（只读核验）

| 项 | 值 |
|----|-----|
| callId | `studio-imagegen-call-22d2e50d4918b3559fc22f74b7d2501b6509af6c` |
| generationRunId | `codex-ug-run-mrwecb5s` |
| provider | codex |
| prepare | callAllowed=true 一次 |
| quarantine | 目录空：无 `candidate.png` / 无 `execution-receipt.json` |
| Codex exec | exitCode=1；日志 `No prompt provided via stdin` |
| 伪候选 | wrapper 误扫 `mvp-work/prop-qingdeng-lantern-authority.png`，**禁止** commit |
| 日志 tool call | log2 仅 skill 文档，无真实 image_gen 成功回执 |

## 对账动作

- 命令：`reconcile_studio_imagegen_call`
- result：`not-invoked`
- evidenceReference：`codex-connect-20260723/not-invoked-22d2e50d4918b355.json`
- evidenceFingerprint：`9b0fa9885c08bf90f9df0f4d6b0b65e9a1b41c370696d0397ecfd7e5610002bf`
- eventId：`studio-generation-call-event-2ca3d6205934a7d30a9c6f362dceae98eb544682`
- 请求幂等键：`reconcile-studio-imagegen-call-22d2e50d-not-invoked-v1`
- MCP status：`succeeded`（非 replay）

## 对账后投影

- call.status = **not-invoked**
- callAllowed = false
- generationBlocked = **false**
- nextAction = **new-run-required**
- 禁止对同一 call 再模型调用；新生产必须新 run

## Dudu 保护

- `projects/dudu-s1e1-a84aa353` generation ledger SHA 仍为  
  `0998c00f8bc84583f207ae3e434a7171d1597ed177cc21c595082f665bfc54af`（未变）

## 明确未做

- 未 retry / 未新 dispatch / 未 Grok live canary
- 未 fail/cancel 以外的生产写（若 fail run 成功则仅关账本）
- 未 App 安装 / Git commit / 真实 Seedance 视频
