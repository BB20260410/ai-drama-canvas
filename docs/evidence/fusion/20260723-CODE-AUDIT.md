# 代码全面审核纪要（2026-07-23）

## 范围

- 全仓 `npm run typecheck`（vue-tsc + tsc）  
- 融合相关 + 拆格 + unit-grid 等定向 vitest  
- 重点：近期融合接线（compose / staging / elements / MCP helpers）

## 机械结果

| 检查 | 结果 |
|------|------|
| typecheck | PASS |
| fusion + storyboard-draft 等定向测 | 74 → 修复后 compose/fusion 19 PASS（完整定向集此前 74 PASS） |
| 全量 `tests/studio-*.test.ts` | 易挂，不作为本轮硬门；改用精选套件 |

## 已修缺陷（本轮）

1. **`planStudioShotCompose` 误阻塞**  
   - 问题：非 `.mp4` 扩展名被放进 `blockers`，导致 `readyForFfmpeg=false`（「建议」被当成硬错误）。  
   - 修复：拆分 `warnings` / `blockers`；仅硬条件（如静帧缺时长）阻塞。

2. **字幕语义撒谎**  
   - 问题：写了 SRT 文件却未烧录，计划却暗示会烧录。  
   - 修复：steps/warnings 明确「可选旁路，不保证烧进画面」。

3. **执行路径安全**  
   - 问题：`outputDir`/`visualPath` 解析不够严。  
   - 修复：绝对路径校验 + 输出须落在 `outputDir` 下。

4. **fusion helper `shot-compose-plan` 的 ok**  
   - 问题：始终 `ok: true`，即使 plan 未就绪。  
   - 修复：`ok = plan.readyForFfmpeg`。

5. **grid-split 助手浮点**  
   - 问题：`asNumber` 允许非整数 rows/cols 直到底层再抛。  
   - 修复：`asPositiveInt`。

## 未宣称「零缺陷」的原因

- 全仓数千文件；未跑完全部历史重测试（部分 suite 会长时间卡住）。  
- 合同层大量能力尚未全 UI 接线；未接线 ≠ 运行时崩溃，但产品路径可能「有 API 无按钮」。  
- live Codex / 真成片 CAS 登记仍 NOT_RUN。  
- 全局 Media Adapter 注册表为进程内可变单例，并行测试需 `clear*`（已在相关测里使用）。

## 结论

近期融合路径：**类型干净 + 定向测通过 + 已修 5 类真实逻辑/安全问题**。  
**不能**诚实声称「项目每一行代码都无 bug」。当前状态：**融合相关主路径可认为已净化；全仓持续靠既有 final-validation 与后续接线保障。**
