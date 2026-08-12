# 轻量小说工作区第二轮综合测试

测试时间：2026-08-01  
结论：PASS。严格 100 字短篇与 100 万字 / 500 章长篇都完成了真实 Electron 写作闭环；本轮未发现可复现的一版功能阻断。

## 真实 Electron 结果

| 档位 | 来源 | 实际闭环 | 结果 |
|---|---:|---|---|
| 短篇 | 100 UTF-16 字符、1 章 | 导入受管副本、打开、搜索定位、选文记忆、编辑保存 | PASS |
| 长篇 | 1,000,000 UTF-16 字符、500 章 | 导入受管副本、打开、搜索定位、选文记忆、编辑保存 | PASS |

短篇实测：预检 3ms、导入 3,962ms、工作区就绪 3,303ms、全文搜索 224ms、编辑保存 2,472ms。保存后 manifest 为 r2，记忆 1 条且保留原文章节、修订、SHA 与选区。原始来源 SHA 未变；页面错误、控制台错误、外网请求均为 0。

长篇实测：预检 13ms、导入 32,058ms、工作区就绪 3,028ms、全文搜索 29,344ms、编辑保存 2,653ms。500 章均可列出，搜索跳转到第 377 章，记忆 1 条且可追溯。原始来源 SHA 未变；页面错误、控制台错误、外网请求均为 0。

决定性证据：

- `lite-100-ui-smoke-round2.json` / `lite-100-ui-smoke-round2.png`
- `lite-1m-ui-smoke-round2b.json` / `lite-1m-ui-smoke-round2b.png`

## 本地回归

- `npm run typecheck`：PASS。
- `AI_CANVAS_MCP_ALLOW_MULTI=1 npm run build`：PASS；Main、Preload、Renderer 均构建成功。
- 小说定向回归：8 个文件、126 项测试 PASS，覆盖 manuscript、import command、IPC、规模夹具、工作区 UI 合同、来源只读、受管工程和备份恢复。
- `git diff --check`：PASS。

## Grok 4.5 三代理复核

实际调用：`/Users/hxx/.local/bin/grok`，CLI `0.2.118`，模型 `grok-4.5`；关闭跨会话记忆、Web 搜索和嵌套子代理，在三个隔离源码副本中并行执行。

| 代理 | 命令范围 | 结果 | 缺陷 |
|---|---|---:|---|
| short100 | Studio UI 合同 + IPC，并核对百字 Electron 证据和 smoke 实现 | 2 文件 / 12 项 PASS | 无 |
| long1m | 百万字规模夹具 + 来源只读，并核对百万字 Electron 证据和 smoke 实现 | 2 文件 / 16 项 PASS | 无阻断；确认导入、搜索偏慢 |
| failures | manuscript + import command + backup/restore | 3 文件 / 59 项 PASS | 无；CAS、来源只读、历史快照、备份恢复均通过 |

第一轮探索型代理因 6 轮上限在报告前终止，不计入测试结论；随后改成指定命令与指定证据的有界复核，三个代理均正常退出并产出上述报告。

## 已知边界与风险

- 100 万字全文搜索约 29 秒、导入约 32 秒，属于可复现的性能不足，但没有崩溃、卡死或数据损坏。
- 1,000,000 字符 Markdown 转为受管章节后统计为 999,013 字符，差额来自章节 Markdown 结构转换；原始来源的 2,990,000 字节和 SHA 全程未变。
- Electron smoke 在启动桌面窗口前通过同一 Core command 导入受管副本，没有自动操作原生文件选择对话框。
- 备份恢复、CAS 和历史快照由真实 Core 测试验证；本轮没有点击桌面端原生备份/恢复目录对话框。
- 未替换安装版、未写入正式小说来源、未联网、未做 Git 暂存或提交。
