# 主画面逐片段 Transform 关键帧验证报告

验证日期：2026-07-14（Asia/Shanghai）  
工作区：`/Users/hxx/Documents/无限画布`  
结论：通过。主画面逐片段位置、缩放、旋转关键帧已贯通共享数据、核心校验、FFmpeg、Electron、MCP、OTIO、分段、合成帧和时间线续接；该项不再是能力缺口。

## 1. 优先级核验

开工时，`docs/当前开发交接.md` 所列 P1 “主画面逐片段 transform 关键帧”仍成立：当时核心明确拒绝主轨关键帧，能力合同仅声明画中画范围，主轨 FFmpeg 与桌面预览都没有兑现动态变换。因此本轮不是重复建设。

本轮完成后，这一判断已失效：

- `features` 已包含 `main-track-transform-keyframes`；
- `keyframeCurves.scope` 已变为 `all-visual-tracks`；
- `missingForFullNle` 已移除主画面关键帧，只保留复杂嵌套、第三方效果兼容和正式项目验证；
- 横竖屏真实 H.264、Electron、OTIO v1/v2、任意整数帧 split、合成帧和续接入口均已有直接运行证据。

重新按长期章程的错误状态、恢复与重复付费风险排序后，下一唯一最高优先级改为 P0 “通用 HTTP 远端生成轮询与隔离下载的不确定性治理”，详见第 9 节。

## 2. 落地合同

### 主画面定义与失败策略

- 最低 `order` 的视觉轨固定为主画面；轨道可见性变化不会改变主画面身份。
- 主画面轨道隐藏或静音时渲染失败关闭，不会把后续可见画中画提升为主画面。
- 主画面片段静音时保留其整数帧时长，并输出固定项目背景；不会缩短时间线。
- 非视觉轨携带 transform 关键帧继续失败关闭；静态位置的 NaN/Infinity 也被拒绝。

### 坐标与变换顺序

- X/Y 以项目画布中心为原点，单位为项目像素；X 向右、Y 向下为正。
- 主素材先等比适配画布，再依次应用动态 scale、片段静态 opacity、绕中心 rotation、X/Y position，最后合成到固定尺寸的项目背景。
- opacity 当前是片段静态属性，不是关键帧属性；报告不把它表述为“透明度关键帧”。
- 无变换的 identity 主画面继续走原有 scale+pad 兼容路径，避免无关输出变化。

### 共享状态与时间权威

- 主画面与画中画继续共用同一 `EditKeyframe[]`、曲线求值器、revision CAS、history、`update_clip` 和命令账本；没有建立主轨第二状态机。
- 所有编辑与渲染以项目整数帧为权威；23.976 使用 `24000/1001`。
- 任意 split/trim 复用已验证的 De Casteljau、`sourceWindow + sourceTransform` 和 hold/常量尾段合同。
- authored 曲线导出 OTIO v1，派生曲线导出 v2；导入以整数 `frame` 为权威，避免毫秒舍入误拒绝合法分数帧端点。

## 3. FFmpeg 实现与真实红灯

主轨动态分支使用固定透明旋转画布：画布按项目对角线和该片段最大 scale 计算，动态前景先居中填充再旋转，最后叠加到固定项目背景。这样避免 FFmpeg `rotate` 在首帧配置尺寸后裁掉后续放大的画面。

真实首跑还暴露并修复了两个共享渲染问题：

1. 旧覆盖层使用 `rotw(iw)/roth(ih)`，会把像素尺寸当作弧度；现已移除。
2. FFmpeg `rotate` 的表达式帧号从 0 开始，而动态 scale/overlay 的 `n` 从 1 开始；现分别用 `n` 与 `n-1` 映射同一项目 F0，位置表达式也使用 overlay 自身的整数帧语义。

`extractTimelineFrame` 不再另建简化主轨图，而是在最终共享合成图上按整数帧裁取。时间线续接也通过该入口取得首帧，同时只从固定主画面轨选择活动源视频路径。

## 4. 自动化覆盖

最终门禁包括：

- `npm run typecheck`；
- `npx vitest run tests/keyframe-curve.test.ts tests/editor.test.ts tests/codex.test.ts tests/mcp-scan-cancel.test.ts --maxWorkers=1`：4 文件、35 项；
- `npm test`：30 文件、173 项；
- `npm run build`；
- `npm run mcp:smoke`：133 工具、9 Resource Template、7 Prompt；
- 编译态 MCP scan/capability：1 项；
- `npm run editor:main-track-render-smoke`；
- `npm run ui:editor-main-track-smoke`；
- 旧贝塞尔与任意分段的真实 H.264/Electron 回归；
- `npm run full:smoke` 的完整本地流程与重启恢复。

主轨合同测试额外直接调用 `prepareTimelineVideoContinuation(..., enqueue:false)`：带主轨病态动画的 320×320 工程在 F12 生成真实合成帧，续接包为 `sourceType=timeline`，`sourceVideoPath` 精确指向固定主轨素材，provenance 含主轨片段且首帧已登记到目标节点。这是主轨动画续接包装的直接证据，不以其他 smoke 推断。

## 5. 真实媒体证据

专项证据：`docs/evidence/main-track-keyframe-render-smoke-20260714.json`。

- 竖画布：320×180 横源进入 320×480 项目；baseline 与 F13 split 两份 H.264/AAC 均为 48 帧、`24000/1001`、2.002 秒、64242 bytes。
- 横画布：180×320 竖源进入 480×320 项目；H.264/AAC、48 帧、2.002 秒、66879 bytes。
- baseline 与 split MP4 字节级同 SHA-256：`94fb26ec36944e7a314b30d0fa48525542e65a27239665c9904b6ec370cf593b`。
- split 前后逐帧比较 48 帧：最大质心误差 0、最大包围盒误差 0；F36–F47 静音尾段红色前景像素为 0。
- F24 合成 PNG 与成片对应帧：质心误差 0.0442218449 px、包围盒误差 0。
- 三次成片均取得 Publication 回执；结束时机器媒体活动权重 0、队列 0、项目锁 0。
- authored OTIO 合同为 v1，F13 split 后为 v2。

必须区分两种误差：上面的 0 是 baseline/split 无损等价。成片采样相对共享数学预期的绝对几何并非全部为 0；竖/横样本的最大质心误差为 1.4585319201 px，最大包围盒误差为 3.1628827427 px，分别低于专项硬门槛 3 px 与 10 px。这是编码、颜色阈值和旋转栅格采样误差，不得误写成“所有主轨 transform 绝对像素误差均为 0”。

隐藏主轨夹具同时包含一条未隐藏、未静音且有活动片段的可见画中画，渲染仍以“总时长为 0”失败关闭。该证据直接证明系统没有提升画中画。

## 6. Electron 真实交互与视觉验收

专项证据：`docs/evidence/editor-main-track-keyframe-ui-smoke-20260714.json`。

- “主画面变换” inspector、X/Y/scale/rotation/opacity 和“添加关键帧”均可见；
- F0 与 F18 的 CSS matrix 确实变化，opacity 0.72 生效，项目背景为 `rgb(24, 49, 79)`；
- scale=5 被核心拒绝，工程修订保持 r2；
- F9 新关键帧和 opacity 0.68 保存到 r3，重载、undo r4、redo r5 均恢复；
- F13 split 后撤销/重做到 r8，右片段 ID 稳定，导出 OTIO v2；
- `pageErrors=[]`，隔离工程根和 registry 均已删除。

永久截图 `docs/evidence/editor-main-track-keyframe-ui-20260714.png` 为 1560×980、294345 bytes，SHA-256 为 `aff7b138174e1bc83cfdb7be148eddc3e16ee9e4109a54edb1b9ab18fd3b5a10`；亮像素比例 8.09%，有色像素比例 5.24%。已实际打开目视，旋转主画面、蓝色项目背景、时间线、主画面 inspector 和派生曲线均可见，不是黑屏或占位图。

## 7. 回归与兼容性

- 旧画中画自定义贝塞尔 H.264 与 Electron 编辑 smoke 通过。
- 任意关键帧分段 H.264 与 Electron split/trim smoke 通过。
- identity 主画面保持旧 scale+pad 路径。
- 源码态、编译态 MCP 和完整工作流 smoke 通过；MCP 工具数仍为 133。
- 现有签名 DMG 未覆盖，仍为上一源码快照：136652595 bytes，SHA-256 `ee7c78f16104b3881650353052669fa60c8fd4deb196cc5f49a2f1c765a20972`。

机器可读总摘要见 `docs/evidence/final-validation-20260714-0540.json`；其中保存最终源码、证据和文档哈希。

## 8. 授权边界

本轮没有导入或修改正式项目，没有打开生成网站、上传、付费提交、覆盖外部素材、安装、覆盖签名包、发布、公证、git commit、push 或 PR。全部媒体与 UI 运行使用隔离夹具，夹具终态已清理。未读取旧线程完整 JSONL、includeOutputs、base64 或图片 JSON。

## 9. 下一唯一最高优先级

### P0：通用 HTTP 远端生成轮询与隔离下载的不确定性治理

当前 `src/core/generation.ts` 会把 `waiting_remote` 阶段的网络/HTTP/JSON/下载异常与供应商明确终态失败统一闭合为本地 `failed`；通用 HTTP 结果还会直接写最终预留目标，并把已有任意非零文件当作已下载。网络中断或进程崩溃可能留下部分文件，重启后误判并关闭任务；若用户重新建任务，存在重复付费风险。这属于长期章程中的错误状态、恢复和重复付费 P0，优先级高于复杂嵌套、第三方效果和 ComfyUI 专用适配。

下一纵向切片必须至少做到：

1. 将远端观测明确分为 pending、succeeded、confirmed_failed、retryable_or_unknown；只有结构化终态失败才能关闭 GenerationJob 与 Publication。
2. 5xx、超时、断连、坏 JSON、完成但结果地址缺失和下载中断保持非终态，保留 `externalTaskId`、`clientJobId` 与 reserved intent，禁止重新 POST。
3. 下载先进入 `.aicanvas/generation-downloads/<job>/` 隔离临时文件，经过大小上限、魔数/解码和 SHA-256，再以不可覆盖方式发布到预留目标。
4. Doctor、统一快照和 MCP 暴露最后观测错误、当前不确定状态与恢复动作。
5. 以隔离 loopback 服务验证 500 后恢复、断连、坏 JSON、partial+重启、明确 failed、取消、单次提交、最终回执和资源清理。

第二顺位才是 `comfyui-local` 专用适配。复杂嵌套、第三方效果兼容和正式项目验证继续保留为已知限制；真实 Provider、正式项目和 Apple 公证仍等待用户授权。
