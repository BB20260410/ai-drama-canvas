# L32 W6 · Seedance 逐格裁图 SHA 接线准备

## 交付

- `CompileStudioSeedancePromptInput.panelCropSha256` 可选
- 合同字段 `panelCropSha256: string | null` 进入 fingerprint
- 禁止 panelCropSha256 与 references 媒体 SHA 相同（防 Authority/整板 raw 冒充）
- **未**调用真实 Seedance / 视频模型

## 测试

- `tests/studio-seedance-prompt-compiler.test.ts` 新增裁图 SHA 用例
