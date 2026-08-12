# 给 Grok 4.5 的 Writing OS P1 独立复验提示词

你是独立验收员，不是实现者。请在 `/Users/hxx/Documents/无限画布` 对 Writing OS P1 性能加固做证据优先复验。不要复述 Codex 报告；必须核对实际源码、不可变 current MCP 回执、测试和性能 JSON 后再裁决。

## 安全边界

1. `/Users/hxx/Desktop/小说/欠债的都得还` 只读；不得写入、格式化、移动或删除。
2. 不得自动接受模型生成的 Story Bible / Writing State，human owner gate 必须保留。
3. 不得 Git stage/commit/push，不得 reset/clean dirty worktree。
4. 不得覆盖 `/Applications`、发布、部署、上传或付费。
5. 不要默认重跑约 22 分钟的 500 章夹具；先审计已落盘 JSON、脚本断言和定向回归。若决定重跑，只能使用新的 evidence 目录，禁止覆盖现有证据。

## 目标问题

上一轮结论是 `VERIFIED_WITH_PERFORMANCE_RISK`，原因是同一 500 章夹具正常写章 p95 `12.73s`、rebuild p95 `3.17s`，且延迟随 operation history 增长。

本轮声称：

- 两套 operation 热恢复已由“每次扫描全部历史”改为 durability-backed pending journal；旧 locator 与 full audit 保留。
- state 和 manuscript intent bundle 使用同目录批量持久化；每个文件仍 fsync，`intent.json` 最后成为提交点。
- 同夹具正常 p95 降到 `2.19655s`，rebuild p95 降到 `0.99518s`，正常末窗口不再线性恶化。
- 所有恢复、第三 SHA、谱系、cutoff、source-readonly 和 current MCP 门保持绿色。

你的任务是证伪或确认这些声明，而不是只看平均耗时。

## A. 先核对 current 身份

```bash
cd '/Users/hxx/Documents/无限画布'
npm run mcp:current:check
```

源码未变化时应看到：

- candidateId: `mcp-candidate-c59b0d6c99ed6103-40f7235ecb87e453-15e567f4`
- sourceDigest: `c59b0d6c99ed610330c4a47faf38d5636f946b8cd03bef2b696eb53277ccec9a`
- buildId: `39bc0e1bf2db81bb11d8a9891910379e`
- toolCount: `216`
- invalidCandidates: `0`
- buildCurrentness.allowed: `true`

若源码后来有合法变化，不要机械要求旧 digest；应重建候选后证明 candidate/source/build 同源。若 Grok 当前会话 tools/list 不是 216 或 `buildCurrentness.allowed !== true`，先重启/重连会话，再做会话内裁决。

## B. 必查实现合同

重点审计：

- `src/core/novel-writing-state.ts`
- `src/core/novel-manuscript.ts`
- `src/core/confined-project-storage.ts`
- `src/core/darwin-dirfd-storage.ts`
- `scripts/novel-writing-os-500-sequential-acceptance.ts`

必须确认：

1. layout 缺失时先做一次 legacy 全量 recovery/audit，确认干净后才发布 `pending-markers-v1`。
2. 日常 head/recovery 只扫描 pending marker；显式 full verification 仍枚举并验证全部旧 operation archive。
3. pending marker 在 intent 提交后、业务 target 写入前存在；completed receipt 后 marker 通过 inode/SHA/size CAS 迁移到 completed。
4. 已有 operation locator、intent/after/completed 工件不搬迁、不重写，混合 legacy history 可读。
5. `persist-batch` 每个临时文件写完后 fsync；非提交工件先 rename 并 fsync 目录；`intent.json` 最后 rename 并再次 fsync 目录。
6. 不允许通过关闭 fsync、跳过 CAS、忽略第三 SHA、进程内未持久缓存或弱化 full-lineage verification 换速度。
7. 故障注入仍覆盖 intent 提交点附近的中断窗口，并能确定性恢复或失败关闭。

## C. 必查证据

读取：

- `docs/evidence/novel-performance/20260802-p1-full-batch-500/evidence.json`
- `docs/evidence/novel-performance/20260802-p1-full-batch-500/comparison.json`
- `docs/evidence/novel-performance/20260802-p1-full-batch-500/current-mcp-writing-os-smoke.json`
- `docs/evidence/novel-user-tests/writing-os-critical-memory-hardening-20260802/sequential-500-retcon-200.json`
- `docs/evidence/novel-mode-v1/real-project/black-page-p1-performance-final-20260802.json`
- `docs/evidence/novel-mode-v1/real-project/black-page-critical-memory-hardening-final-20260802.json`

至少独立计算并确认：

- 正常 p95：`12732.71 → 2196.55 ms`，下降约 `82.75%`。
- rebuild p95：`3167.74 → 995.18 ms`，下降约 `68.58%`。
- 正常首窗口 1–50 mean/p95：`2132.03/2353.58 ms`；末窗口 451–500：`2147.72/2199.81 ms`。
- 峰值 RSS：`615858176 → 556990464 bytes`。
- 802 events / 803 checkpoints / 802 full-lineage verified；801 candidates / 801 decisions。
- 两次新进程恢复、6 类 fault injection、4 个 cutoff oracle 全部通过。
- 两份正式源 manifest 的 summary、aggregate 和完整 `entries` 数组完全一致。

## D. 建议机械复跑

```bash
cd '/Users/hxx/Documents/无限画布'
npm run typecheck
npx vitest run tests/novel-*.test.ts tests/mcp.test.ts tests/runtime-mcp-effect.test.ts tests/managed-project.test.ts tests/managed-project-service.test.ts tests/confined-project-storage.test.ts --maxWorkers=1
npm run mcp:current:check
git diff --check
```

当前基线应为 31 files / 294 tests PASS。若测试集合发生合法变化，以实际 collection、失败项和源码差异裁决，不要只比较数字。

可额外定向核查：

```bash
npx vitest run tests/confined-project-storage.test.ts tests/novel-manuscript.test.ts tests/novel-writing-state.test.ts --maxWorkers=1
```

## E. 裁决标准

分别输出：

1. `LOCAL_CURRENT`
2. `GROK_SESSION_MCP`
3. `PENDING_JOURNAL_COMPATIBILITY`
4. `BATCH_DURABILITY`
5. `FULL_REGRESSION`
6. `SOURCE_UNCHANGED`
7. `STATE_LINEAGE_AND_RECOVERY`
8. `SCALE_500_RETCON`
9. `LATENCY_TAIL`

每项给 PASS/FAIL 和最小决定性证据。任何 FAIL 都应说明实际文件/命令、预期/实际、最小复现和是否可能造成静默错误。

最终只能选：

- `VERIFIED`：正确性门全绿，current 同源，性能降幅与末窗口平坦可复现或被证据闭包充分支持。
- `VERIFIED_WITH_PERFORMANCE_RISK`：正确性全绿，但发现可复现的线性尾延迟、不可接受内存/磁盘增长或当前会话运行时不可靠。
- `REJECTED`：存在正确性、durability、兼容、正式源写入、current 身份或证据真实性问题。

不要把真实外模文学表现冒充机械验收。峰值 RSS 约 `531 MiB` 和 append-only 磁盘增长应作为 P2 容量风险单列；只有发现它们在本次百万字符目标上已造成阻断，才据此降级。若上述门全部成立，建议最终裁决 `VERIFIED`。

