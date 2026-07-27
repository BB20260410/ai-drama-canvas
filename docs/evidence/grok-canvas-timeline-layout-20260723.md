# 无限画布时间线布局切片（2026-07-23）

## 交付

- Core：`src/core/studio-canvas-timeline-layout.ts` — 剧情时间线默认坐标 + 系统边
- Edge contract：`unit→unit` 允许（单元时间序）
- UI：`ManagedStudioCanvasView.vue`
  - 默认 fallback 用时间线坐标
  - 系统边：unit 链、panel 时间链、asset→panel 出场、pipeline
  - 顶栏宫格时间条（可点定位）
  - 「按时间线排布 / 强制时间线」按钮
- 测试：`tests/studio-canvas-timeline-layout.test.ts` + edge/pipeline/layout/ui 相关 31 PASS

## 非声明

- 未改 Dudu；未安装；未 Git
- 不替代 Review/Authority 一致性硬环；仅改善「排齐、连线、进度可见」
