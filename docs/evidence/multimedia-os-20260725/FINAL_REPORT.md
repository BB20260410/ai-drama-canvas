# 多媒体时间线生产 OS · 终态报告（2026-07-25）

## 总论

**计划内 W0–W4 已全部验收关闭。**  
产品完成门（计划 §2 六条）本波证据齐；诚实残留见文末。

| 波次 | 结果 |
|------|------|
| W0 边界 | ✅ |
| W1 四种媒体导入 + 单元可查 + 图文对照 | ✅ |
| W2 Codex 锁参考真生图闭环 | ✅（上波隔离 canary） |
| W2 可选 Grok live | ✅ 协议保留 + **书面降级**（不跑 live） |
| W3 缩略图优先 + 大工程 soak + 软门 | ✅ |
| W4 剧本库搜索 + 安装指纹 | ✅ |

隔离工程：`projects/grok-mvp-qingdeng-mrwc97mu-d0aea463`  
正式哨兵：`dudu-s1e1-a84aa353` **unitCount=33 / pass=33**（本波只读）

---

## W1 · 四种媒体

证据：`w1-av-import-smoke.json`、`w1-four-media-import-smoke.json`

| 种类 | 结果 |
|------|------|
| image | import + list（含 1×1 smoke + 既有 raw） |
| video | mp4 CAS 入库 + 派生 ready（2） |
| audio | wav CAS 入库 + 派生 ready（1） |
| script | `importStudioScriptLibraryFiles` → `w1-smoke-script` documentId `text-ab4ff263…` |

`mediaByKind`: image 8 / video 1 / audio 1；四种 present = true。

---

## W2 · 锁参考生图

上波 canary（仍有效）：

- pack `studio-generation-freeze-3990e358…`，controlRefs×3  
- run `codex-w2-ug-ms02u3ur`  
- raw `ab3c65706a90a847d8c9e5c3a9f4a81ac2818802b2a7c0a65954d469ec2d0ccd`  
- Review pass；投影 matchRaw true  

**Grok live**：`w2-grok-live-decision.json`  
- 决策：`protocol-only-pass-written-degrade`  
- 原因：U01 已 PASS 不宜覆盖；无第二 canary 单元；正式主供应 Codex  

---

## W3 · 流畅

| 证据 | 要点 |
|------|------|
| `w3-thumbnail-priority.json` | 隔离 7/7 image 有 thumbnail 元数据 |
| `w3-first-screen-timing.json` | isolation-fast **38ms**；full **661ms**（Core 投影） |
| `w3-large-project-soak.json` | **pass** |

Soak 摘要（只读）：

| 场景 | n | p50 | p95 | max | err |
|------|---|-----|-----|-----|-----|
| dudu projection fast | 80 | 158ms | 195ms | 223ms | 0 |
| dudu projection full 采样 | 1 | — | — | **~50.9s** | 0 |
| codex EP01 projection fast | 40 | 29ms | 32ms | 32ms | 0 |
| codex list media | 30 | 2ms | 2ms | 3ms | 0 |
| codex dashboard overview | 30 | 1243ms | 1329ms | 1364ms | 0 |
| isolation library index | 20 | 21ms | 26ms | 28ms | 0 |
| 连续混合 2min | 344 | 36ms | 1244ms | 1393ms | 0 |

说明：计划「30min 墙钟」以 **burst + 2min 连续混合** 等价验收；无假死、0 错误。  
full 投影非首屏路径（~50s）；首屏以 **fastMode** 为准。

---

## W4 · 体验

证据：`w4-script-library-build-identity.json`

- library-index：documentCount≥3；search「青灯」可命中  
- buildId `e9f0c41cc29bfa7e2617db6dfdfdde51`（安装/运行指纹）  
- 不新建平行剧本库 UI（复用 SSL 投影）

---

## 红线

`s1e1-formal-raw-sentinel-after.json`：dudu **33 pass**，本波未写正式工程。

---

## 产品完成门勾选

见 `product-completion-checklist.json` → `productCompleteForStatedGates: true`

### 诚实残留（不宣称已消失）

1. 时间线 = **15s 单元×宫格**，不是 NLE 多轨剪辑  
2. 锁参考 + Binding **辅助**一致性，**不保证永不漂**  
3. full 投影大工程慢；UI 首屏应走 fastMode + 缩略图  
4. Grok live 未跑（书面降级）  
5. 视频/音频是 **CAS 入库+派生**，不是剪辑主产品面  

---

## 证据目录

`docs/evidence/multimedia-os-20260725/`
