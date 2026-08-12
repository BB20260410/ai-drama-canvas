# 去重后的增量 backlog

## 唯一建议进入候选池的增量

### `KERNEL-PACK-TRACE-SURFACE`

状态：`RECOMMENDED_NOT_IMPLEMENTED`  
优先级建议：`P1`  
性质：现有 Context Pack / preflight 的只读可解释投影，不是新的写作状态。

### 用户问题

当前 owner 能看到 Writing OS readiness、blocker、候选 diff 与 probe，但仍难在同一处回答：

> “本章交给模型的作业包究竟包含了什么、为什么包含或省略、预算被谁占用、它对应哪个 cutoff 和 fingerprint、现在是否已 stale？”

### 最小展示合同

只读面板应展示：

1. 章节身份、chapter brief 与 `cutoffChapterId`；
2. required cast 及 profile/appearance 是否齐备；
3. hard canon、critical memory、recent chapters 等预算分区；
4. included sections 与每项来源/预算占用；
5. omitted sections 与确定性省略原因；
6. Context Pack fingerprint、preflight fingerprint 与当前 stale/ready 状态；
7. blocker、nextTools 和可修复路径；
8. author-only 或未来章内容不得泄漏，文件系统绝对路径不得进入模型可见包。

### 实现边界

- 必须复用现有 `NovelDesktopWritingDashboard`、Context Pack owner 和 preflight receipt；
- UI 只投影已有事实，不创建新的 author intent/current focus 文件、数据库表或结算状态；
- 不改变 pack 排序、预算、cutoff、fingerprint 或 save 合同；
- 不把文学质量判断伪装成机械一致性；
- 不要求任何第三方运行时或许可证受限依赖。

### 未来可能涉及的权威文件

仅当 owner 后续明确批准实现时再进入：

- `src/core/novel-desktop-writing-os.ts`
- `src/renderer/src/components/NovelStudioView.vue`
- `tests/novel-studio-view.test.ts`
- `tests/novel-desktop-writing-os.test.ts`

本轮未修改这些文件。

### 机械验收条件

- 给定同一 project/revision/cutoff/budget，trace 投影确定性相同；
- included/omitted 与实际 pack receipt 一致，不能由 UI 二次推算；
- pack 或 preflight stale 时明确失败关闭，不能显示“可写”；
- 省略原因可枚举并可测试；
- 不泄露 future chapter、author-only、模型密钥和本机绝对路径；
- 不新增状态文件、数据库表、runtime dependency 或第二套 canon；
- 现有 Writing OS、许可门和 MCP currentness 测试继续通过。

## 明确不登记为新 backlog

- STATUS 总控、cast readiness、候选八项 diff、probe、human accept/reject、租约与 next actions：已有。
- 新建独立 author intent/current focus 存储：会制造双写与状态漂移。
- 安装四个外部小说软件作为产品前置条件：没有证据支持，且扩大供应链/许可/写入面。
- “支持百万字”性能门：属于独立容量与恢复性验证，不能由本轮外部产品研究代替。

## 延后假设

### `EXTERNAL-EXECUTOR-ATTESTATION`

只有 owner 将来确实需要外部 App 作为正文执行器时，才评估“只读作业包导出 + 不可信候选回传 + fingerprint attestation”。在没有真实外部执行需求与隔离设计前，不进入产品实现。

