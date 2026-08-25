# Brief 注入点

| 层 | 路径 | 是否改指纹 |
|---|---|---|
| 冻结 prompt | `pack.request.modelPayload.renderedPrompt` | **不改**（内容寻址） |
| Agent brief | `buildStudioUnitGridAgentImagegenBrief` → `promptContract` + `promptContractText` | 只读投影 |
| 组装 | `src/core/unit-grid-brief-contract.ts` `composeUnitGridBriefContract` | 纯函数 |
| MCP | readiness / pack 里已有的 unit-grid brief | 加字段，不改 tool schema 名 |

禁止：平行生图、ComfyUI、改 freeze fingerprint、写入 `projects/codex-ai-drama-studio`。
旧单元不回溯；新 freeze 的 brief 自动带合同。
