# 续镜 / 变化句合同 v1

有 `continuationSource` 时 Brief 填 `DELTA_ONLY`，与 `ai-drama-continuity` 对齐：

- 源图已表达的脸/服/场景 **不复述**
- 只写：动作变化、机位变化、光色变化、终点状态
- 身份锁以**本单元 controlRefs** 为最高权威；actual-tail 只锁已观察字段
- 禁止把整张旧宫格 raw 当下一镜身份图

无续镜：`DELTA_ONLY = null`，按 BEATS 完整执行。
