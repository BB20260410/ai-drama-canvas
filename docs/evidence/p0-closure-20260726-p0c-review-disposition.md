# P0c 双路审查处置记录 · 2026-07-26

## 审查 A：正确性/竞态（code-reviewer 子代理）

- 结论：1 项 MEDIUM，其余（epoch 重验竞态、singleflight 合并、异常吞没、metrics 自洽、onclose 重入、isError 判定健壮性、退出码惯例）均核实无缺陷。
- MEDIUM：guard 改 registerSignalHandlers:false 后，从写 pid 锁到信号监听注册之间隔着 `await startMcpRuntimeGateWatchers()`（chokidar 递归扫描真实耗时），窗口内信号走 Node 默认终止，锁文件与半启动资源不清理——相对改前是真实回归。
- 处置：✅ 已修复——shutdown 链 + stdin/信号监听上移至 guard 成功后、watchers 启动前；transport.onclose 留在 transport 构造后。验证：mcp-stdio-shutdown 3/3 + mcp-p0-runtime-gate-integration 2/2 + tsconfig.mcp typecheck PASS。

## 审查 B：合同完备性（general-purpose 子代理）

- 结论：三条 P0c 要求均落地且有测试，与 findings 18:11 复审逐句对应；无严重缺口；IPC/后台写路径共用同一 controller 实现自动获得 epoch 修复；旧无 epoch 入口生产零调用。
- 建议 1（transport.onclose 无 exit/watchdog）：**书面裁决不改**——onclose 是被动释放路径，退出由发起方（stdin EOF/信号/正常关闭者）决定；资源全释放后事件循环转空自然退出。已写入代码注释。
- 建议 2（补 SIGINT/stdin close 测试）：✅ 已补 SIGINT→130 用例（信号族共链的代表性证明）；stdin close 与 EOF 高度同构不重复加。
- 建议 3（registerResource/registerPrompt 未入 currentness gate）：超出 P0c 字面范围，记入 findings 待后续切片裁决。
- 建议 4（IPC `{ok:false}` 哨兵返回未计 failed 指标）：同上，记入 findings 待后续切片。

## 验证状态（P0c 收口）

- 定向回归：10 文件/39 测试 PASS（修 MEDIUM 后受影响子集 2 文件/5 测试重跑 PASS）
- 类型检查：typecheck / typecheck:app / tsconfig.mcp 三套 PASS
- 隔离构建探针 verify:t23 passed（81 文件；live dist-mcp 360 文件指纹 07bafca2… 未动）
- test:fast 探路轮进行中（源码在其开跑后有改动，该轮只作挂死/时长探路，不作冻结证据；收口后需重跑正式冻结轮）
