# L32 W2 · 合同加固与恢复路径

## 交付

| 项 | 状态 |
|----|------|
| quarantine-only candidate gate | PASS（`studio-imagegen-candidate-gate`） |
| stdin prompt delivery contract | PASS |
| not-invoked → new-run projection | PASS（`studio-unit-grid-next-action`） |
| imagegen call bus once-only prepare | PASS（既有 command-bus 测试） |
| typecheck | PASS（vue reviewDecision 收窄） |

## 测试

- `tests/studio-imagegen-candidate-gate.test.ts`
- `tests/studio-unit-grid-next-action.test.ts`
- `tests/studio-imagegen-call-command-bus.test.ts`
- `npm run typecheck`
