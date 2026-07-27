# Big Prompt Hub · 角色一致性五件套（摘录 2026-07）

来源：https://www.bigprompthub.com/ai-short-drama-character-consistency-workflow/  
用途：多镜头短剧角色锁、漂移 QA、分集放行  
与本项目：高度对齐 P5–P7 的“身份证据链”；软件保证 SHA/版本/门禁，视觉一致性仍需 Review。

---

## 五件制品

1. Casting bible  
2. Approved reference pack  
3. Shot handoff sheet  
4. Drift log  
5. Episode acceptance record  

## Prompt 1 · Cast and Character Bible

```
Build a character bible for **[LEAD CHARACTER]** in **[SHORT DRAMA PREMISE]**. Return fixed identity fields: age range, face shape, hair, silhouette, wardrobe layers, signature prop, emotional baseline, relationship role, and non-negotiable visual details. Separate locked fields from scene-specific changes. Output one production-ready cast record for reference-image and shot teams.
```

## Prompt 2 · Reference Image and Identity Lock

```
Create a continuity-safe reference pack for **[LEAD CHARACTER]**. Use the approved identity fields and produce a front or 3/4 portrait, neutral expression, even lighting, uncluttered background, clear hairline, wardrobe layers, and signature prop. Do not add other faces or dramatic scene effects. This reference is the lock asset for later multi-shot video generation.
```

## Prompt 3 · Continuity-Safe Shot Handoff

```
Write one shot card for **[EPISODE BEAT]** using locked character **[LEAD CHARACTER]**. Specify framing, camera motion, lighting, pose, expression, dialogue action, setting, duration, and continuity constraints. Preserve the locked face, hair, silhouette, wardrobe layers, and signature prop. State exactly which scene variable may change and which identity fields may not.
```

## Prompt 4 · Drift QA and Regeneration

```
Audit this generated clip against **[APPROVED REFERENCE PACK]** and **[SHOT CARD]**. Score face, hair, silhouette, wardrobe, prop, pose, expression, lighting, and cut continuity as pass, minor repair, or regenerate. If identity drift is visible, return a short regeneration instruction that repeats the locked fields and removes only the drift cause.
```

## Prompt 5 · Episode Acceptance Notes

```
Create an episode acceptance report for **[EPISODE ID]**. List each shot, character-lock status, continuity decision, regeneration count, subtitle or edit repair, remaining risk, and final release decision. Reject release when an unapproved identity drift, rights issue, broken shot transition, or unreadable subtitle remains.
```

## 社区实践要点（Reddit / 工作流共识）

- 角色锁必须先于批量分镜变体。
- 同一参考资产贯穿整集；不要每镜重写人物描述。
- 顺序审片：新渲染 vs 参考 + 相邻已通过镜头。
- 只修失败镜头，不做整集无界重生。
- 漂移日志必须随成片保留，不能“修好就删证据”。

## 与本项目九字段

社区“face/hair/wardrobe/prop/pose/expression/lighting/cut”对应可写入：

- 服装、伤势、持物、位置、朝向、情绪、布局、光线、参考 SHA  

未知字段必须 `unresolved` / `not-applicable`，禁止静默补齐。
