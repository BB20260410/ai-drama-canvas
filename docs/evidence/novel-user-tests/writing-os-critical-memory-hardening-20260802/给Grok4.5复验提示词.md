# 给 Grok 4.5 的独立复验提示词

你是独立验收员，不是实现者。请在 `/Users/hxx/Documents/无限画布` 对 Writing OS 关键记忆与百万字修订加固做证据优先复验。不得只复述 Codex 报告；必须读取实际源码、运行时回执、证据 JSON 和测试输出后裁决。

## 安全边界

1. `/Users/hxx/Desktop/小说/欠债的都得还` 只读；不得写入、格式化、移动或删除。
2. 不得自动接受模型生成的 Story Bible / Writing State；human owner gate 必须保留。
3. 不得 Git stage/commit/push，不得清理或 reset dirty worktree。
4. 不得覆盖 `/Applications`、发布、部署、上传或付费。
5. 若需生成新证据，只能写到新的隔离 evidence 目录，禁止覆盖已有文件。

## 先核对 current 身份

运行：

```bash
cd '/Users/hxx/Documents/无限画布'
npm run mcp:current:check
```

源码未变化时应看到：

- candidateId: `mcp-candidate-ea69ca8aedd5f4ac-77719b7cf314b922-1c0623b3`
- sourceDigest: `ea69ca8aedd5f4ac49e30ee06eb4d735f8eac2f779e5c72f1130b97a65515b40`
- buildId: `9fa8c5b993759a4119436507d6862e75`
- mcpToolCount: `216`
- invalidCandidates: `0`

若源码后来有合法变化，不要机械要求旧 digest；应先重建不可变候选，再证明 candidate/source/build 同源。若你的 Grok 会话 tools/list 不是 216 或 `buildCurrentness.allowed !== true`，先重启/重连会话，再继续会话内裁决。

## 必查五项

### A. 陌生 AI 工具合同

- MCP canonical 名必须是 `prepare_novel_chapter_write`。
- JSON V1 必须同时接受 canonical 名与 legacy `prepare_chapter_write`。
- capabilities 必须给出 transport mapping，doctor/nextTools 不得返回不存在的工具名。

### B. formal 关键记忆与外形 Authority

- timeline/foreshadowing 预算不足时 formal prepare 必须以 `critical_memory_budget_insufficient` 失败关闭，并给可执行重试参数。
- rehearsal 可有界裁剪，但必须显式报告 omitted。
- required cast 缺少 `character_profile` 或 `character_appearance` 时 formal 必须阻断。
- appearance 应是独立 revision Authority，进入 cutoff pack 和 probe；自动反义推理不得冒充机器正典。

### C. 外部资料桥

- snapshot receipt 不得持久化绝对 sourceRoot。
- raw/text CAS 与 receipt SHA/byteLength 必须可复验。
- receipt-to-receipt diff 对 rename 歧义必须保守，不得猜测。
- 资料只能通过 owner accepted `source_binding` 成为受管来源；外部目录删除后，既有 pack 仍能从受管 CAS 复现。
- 篡改受管 text object 后 doctor/prepare 必须失败关闭。

### D. 状态谱系与恢复

- 公开 `writing-state.json` 保持 V1；rebuild 期间公开 state 不得逐章回退或半更新。
- invalidate 必须创建 `rebuild_started`，明确连接旧 public lineage 与 shadow lineage。
- 每次 accepted chapter / Story Bible、shadow commit、promotion 都应有不可变 event/checkpoint。
- operation 必须遵守 intent 提交点与严格 target/command 白名单。
- after-intent、after-state、after-control、after-decision 中断均应可确定恢复。
- 第三 SHA、额外 operation node、event/checkpoint/control 篡改必须零覆盖失败关闭。
- doctor/prepare 遇 pending operation 或谱系损坏必须分别返回 recovery/integrity blocker。

### E. 规模与真实运行

读取并独立校验：

- `docs/evidence/novel-user-tests/writing-os-critical-memory-hardening-20260802/sequential-500-retcon-200.json`
- `docs/evidence/novel-user-tests/writing-os-critical-memory-hardening-20260802/current-mcp-writing-os-smoke-final.json`
- `docs/evidence/novel-mode-v1/writing-os-desktop-p0/critical-memory-hardening-20260802-r4/electron-smoke.json`
- `docs/evidence/novel-mode-v1/real-project/black-page-critical-memory-hardening-final-20260802.json`

必须确认：500 顺序写章、200→500 共 301 章 shadow rebuild、两次新进程恢复、802 events / 803 checkpoints / 802 全链复验、fault injection 全部 fail-closed、future secret 不泄漏、Electron 无 page/console error 和外部请求。

## 建议复跑

```bash
cd '/Users/hxx/Documents/无限画布'
npm run typecheck
npx vitest run tests/novel-*.test.ts tests/mcp.test.ts tests/runtime-mcp-effect.test.ts tests/managed-project.test.ts tests/managed-project-service.test.ts --maxWorkers=1
git diff --check
```

预期全量基线：30 files / 282 tests PASS。不要重新跑 500 章夹具，除非你愿意等待约 75 分钟并使用全新的 evidence 文件名；优先审计其不可变 JSON 与源码中的断言闭包。

## 源未改口径

本轮有效 before/after/final 是 566 entries、525 files、6,060,122 bytes、aggregate `97e8fde0ee0ea8ce8529c3db7db4d2d412cbaf0b8f7ff1e837d185f01b89bada`。更早的 547 / `67da96a0…` 是历史快照，不得误当本轮 before。

## 输出格式

请输出：

1. `LOCAL_CURRENT`、`GROK_SESSION_MCP`、`FULL_REGRESSION`、`SOURCE_UNCHANGED`、`STATE_LINEAGE`、`SCALE_500_RETCON`、`ELECTRON_UI` 七门逐项 PASS/FAIL。
2. 每个 FAIL 给出最小复现、实际文件/工具、预期/实际和是否会造成静默错误。
3. 将“机械一致性”“文学质量”“性能”分开裁决。
4. 最终只能选：
   - `VERIFIED`
   - `VERIFIED_WITH_PERFORMANCE_RISK`
   - `REJECTED`

当前已知性能事实：500 章原始循环 p95 `12.73s`，retcon rebuild p95 `3.17s`，峰值 RSS 约 `587 MiB`。如果没有发现正确性缺陷，建议裁决 `VERIFIED_WITH_PERFORMANCE_RISK`，而不是把文学质量或真实外模表现虚报为已保证。

