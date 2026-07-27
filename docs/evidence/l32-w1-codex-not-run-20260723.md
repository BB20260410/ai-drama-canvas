# L32 W1 · Codex 全链 NOT_RUN（软件门已修）

## 结论

- **live Codex unit-grid 写回：NOT_RUN**（本窗口未完成 provider=codex 的真实生图 commit）。
- **软件门已交付**：prompt stdin 投递 + quarantine-only 候选门禁（纯函数 + 执行脚本 + 测试）。
- call `22d2` **未重试**，保持 `not-invoked`。

## 断点

1. 历史 `scripts/l31-w1-codex-image-exec.mjs`：`stdio stdin=ignore` 导致 Codex 报 `No prompt provided via stdin`；脚本把 prompt 塞进 argv。
2. 候选扫描会把 `mvp-work/prop-*-authority.png` 当成 `candidateOk`（伪阳性）。
3. 本窗口修复后未再跑 live 额度敏感的 Codex image 出图（避免与 harness 长测争抢；验收以软件门 + NOT_RUN 证据满足 criterion 1 备选路径）。

## 已修软件

| 工件 | 作用 |
|------|------|
| `src/core/studio-imagegen-candidate-gate.ts` | 精确 quarantine 路径 / 拒 prop 图 / stdin prompt 合同 |
| `tests/studio-imagegen-candidate-gate.test.ts` | 驱动真实门禁函数 |
| `scripts/l31-w1-codex-image-exec.mjs` | stdin prompt + quarantine-only 验收 |

## 验证

见 `{SCRATCH}/l32-tests-core.log` 与 `vitest` candidate-gate PASS。
