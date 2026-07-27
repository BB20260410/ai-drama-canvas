# Follow-up Goal · 后续执行 FINAL（2026-07-25）

## 结论

本波自动续跑完成三项高价值后续：

1. **P0 级缺陷修复**：`deriveGenerationTargetState` 账本 PASS 优先于当前 binding（full 投影不再假 blocked）  
2. **U25 审片尝试**：observation 已落库；因 `continuity-opaque(costume)` **不推进 head**（合同正确行为）  
3. **安装版 UI 硬门**：首单元卡 **1360ms ≤ 1500ms** 全断言 PASS  

红线哨兵绿；未写 dudu-s1e1 / codex PASS raw。

## 1. 目标状态归约修复（核心）

| 项 | 值 |
|----|-----|
| 文件 | `src/core/studio-generation-target-state.ts` |
| 根因 | binding 优先于终态 Review → full 投影把 gaiden 24 PASS 全抹成 binding_blocked |
| 修复 | **账本 run 优先**；仅无 run 时查 binding |
| 回归测 | `tests/studio-generation-target-state.test.ts` + timeline projection **14/14 PASS** |

### gaiden S1E2 修复前后

| | before full | after full |
|--|-------------|------------|
| pass | 0 | **24** |
| pendingReview | 0 | 1 (U25) → 尝试 review 后仍 pending（opaque） |
| blocked | 26 | **1**（WIZARD-DEMO 无 run + binding） |
| fast/full mismatch | 26/26 | **1**（wizard：fast 偏 ready vs full binding — 可接受） |

## 2. S1E2-U25 Review

- run `s1e2-u25-mcp-grok-mrxwt3u9`  
- 提交 observation `decision=pass`  
- `advances_head=0`，stale：`continuity-opaque` / char-dudu costume 内部定位  
- **不伪造 PASS**：head 不前进；需先补 costume 视觉状态再 correction  

证据：`u25-review-pass.json` + ledger review_events seq 30  

## 3. 安装版 UI 首屏硬门

工程：`grok-mvp-qingdeng-mrwc97mu-d0aea463` · mode=installed  

| 断言 | 状态 |
|------|------|
| a–h 全套 | **PASS** |
| launch→studio view | 1033ms |
| launch→首单元卡 | **1360ms**（预算 1500） |

报告：`t23-ui/t23-layer4-installed-*.json` + 截图  

## 4. 红线

`redline-sentinel.json` pass · dudu 33/33 · codex 541  

## 诚实残留

- U25 正式 PASS 仍被 continuity costume opaque 挡住  
- Wizard demo 单元 binding_blocked（无正式 run，预期）  
- NLE / 视频主链 / Grok live 第二主供应仍 **另开 Goal**  

## 禁句

formal / UI 绿 ≠ 产品 100% 契合 / 永不漂。
