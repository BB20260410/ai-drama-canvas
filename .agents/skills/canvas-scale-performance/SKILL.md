---
name: canvas-scale-performance
description: 实现或审查无限画布 / 生产驾驶舱大规模渲染性能时使用。覆盖视口剔除、分页、LOD、异步 token、媒体代理。触发：P8 Dashboard、VueFlow 性能、虚拟化、4330 宫格、懒加载缩略图。
---

# 无限画布规模性能规范

## 本项目硬上限（P8 合同）

- 当前页最多 **36** 个单元摘要
- 选中单元最多 **6** 宫格
- 当前宫格最多 **6** 控制资产
- **翻页替换** DOM，不累积历史页
- 缩略图：`loading=lazy` + `decoding=async`
- 视频只读 poster/proxy；音频只读 waveform；**不**自动加载原媒体
- 每个 async stream 的 token 绑定 `projectRoot + query`；切项目使旧响应失效

## 社区可借鉴（tldraw performance）

来源笔记：`docs/community-research/全网社区技能与规范分析_20260718.md` §画布性能

| 技巧 | 做法 |
|------|------|
| Viewport culling | 视口外不渲染；数据仍在 store |
| Batched updates | 批量改 store，一次通知 |
| Efficient zoom | 缩放中用稳定 zoom，停稳后再精算 |
| LOD | 缩小时简化几何/换低分辨率图 |
| Geometry cache | 几何/bounds 按 props 失效缓存 |
| 避免 per-shape 动画 | 动画用 CSS 或限制并发 |
| 媒体 resolve 按屏宽 | 原 4K 图在 200px 槽只取对应分辨率 |

## 对本项目的落地偏好

1. **分页 + Core cursor 优先于** 纯前端无限滚加载全量 1288 单元
2. **Dashboard 是投影**，不是第二事实源；禁止 Dashboard DB
3. conflict 队列 P8 可内存分页；P9 再数据库下推
4. 列表接口只返回身份/摘要/SHA 引用；媒体走 Range/流式
5. 启动：`no-filesystem-scan`；只读轻量清单

## 反模式

- 一次挂载 4330 宫格节点
- UI 推导 nextAction
- 把 raw 视频塞进画布节点 JSON
- 切页不取消旧请求导致状态错乱
- 为“丝滑”关闭 culling 或一次预取全库缩略图

## 验收探针

- 单页 DOM 节点数有上界
- 网络/文件媒体请求有上界
- 切项目后旧 fingerprint 不能覆盖新 store
- 规模 fixture（约 1288 单元 / 77 资产 / 4330 宫格元数据）下交互不卡死
