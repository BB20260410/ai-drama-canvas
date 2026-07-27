/**
 * 为已绑定 subject 规划九字段连续性 observation 文案。
 * 禁止静默空串；referenceSha256 必须等于权威 mediaSha256。
 */
import {
  STUDIO_CONTINUITY_FIELDS,
  type StudioContinuityField,
  type StudioContinuityFieldStateInput,
} from "./studio-continuity.js";

export interface ContinuitySubjectContext {
  assetId: string;
  category: "character" | "scene" | "prop" | "style";
  role: string;
  mediaSha256: string;
  /** 单元/宫格可见动作摘要（来自 snapshot，非编造身份） */
  visualAction: string;
  panelIndex: number;
  startMilliseconds: number;
  endMilliseconds: number;
}

export interface ContinuityFieldPlan {
  field: StudioContinuityField;
  state: StudioContinuityFieldStateInput;
}

const SHA256 = /^[a-f0-9]{64}$/u;

function prov(kind: string, reference: string, note: string) {
  return [{ kind, reference, note }];
}

/**
 * 主体分支只看稳定 assetId（及可选 category），禁止扫 role 否定句子串
 * （例如 D01 role 含「不得…与能量体融合」不得误入 A01）。
 */
export type ContinuitySubjectKind = "a01-energy" | "d01-golden-mask" | "generic";

export function classifyContinuitySubject(
  assetId: string,
  category?: "character" | "scene" | "prop" | "style",
): ContinuitySubjectKind {
  const id = assetId.trim();
  if (id === "character-a01-energy") return "a01-energy";
  if (id === "prop-d01-golden-mask") return "d01-golden-mask";
  // 其它导入 ID 前缀（仍不看 role 文本）
  if (id === "character-a01" || id.startsWith("character-a01-")) return "a01-energy";
  if (id === "prop-d01" || id.startsWith("prop-d01-")) return "d01-golden-mask";
  void category;
  return "generic";
}

/**
 * 按硬锁身份与宫格动作生成九字段计划（显式 resolved / not-applicable）。
 */
export function planContinuityFieldsForSubject(
  ctx: ContinuitySubjectContext,
): ContinuityFieldPlan[] {
  if (!SHA256.test(ctx.mediaSha256)) {
    throw new Error(`mediaSha256 非法：${ctx.assetId}`);
  }
  const ref = `${ctx.assetId}@${ctx.panelIndex}`;
  const action = ctx.visualAction.trim() || "本格画面动作见单元信息";
  const plans: ContinuityFieldPlan[] = [];
  const kind = classifyContinuitySubject(ctx.assetId, ctx.category);

  const push = (field: StudioContinuityField, state: StudioContinuityFieldStateInput) => {
    plans.push({ field, state });
  };

  // referenceSha256 始终 resolved 为权威图 SHA
  push("referenceSha256", {
    status: "resolved",
    value: ctx.mediaSha256,
    provenance: prov("binding-authority", ctx.mediaSha256, `主权威图 SHA；subject=${ctx.assetId}`),
  });

  if (kind === "a01-energy") {
    push("costume", {
      status: "not-applicable",
      reason: "A01 为无面部无面具抽象高维能量现象，无服装层。",
      provenance: prov("hardlock-a01", ref, "禁止人脸/服装/面具附着"),
    });
    push("injury", {
      status: "not-applicable",
      reason: "抽象能量体无肉体伤势可记。",
      provenance: prov("hardlock-a01", ref, "无实体生理伤势"),
    });
    push("heldObject", {
      status: "not-applicable",
      reason: "A01 不持物；完整黄金面具为独立 D01 道具，禁止融合。",
      provenance: prov("hardlock-a01", ref, "金面独立"),
    });
    push("emotion", {
      status: "not-applicable",
      reason: "A01 无面部，无情绪表情通道。",
      provenance: prov("hardlock-a01", ref, "无脸无表情"),
    });
    push("position", {
      status: "resolved",
      value: `本格 ${ctx.startMilliseconds}-${ctx.endMilliseconds}ms：A01 按轴线处于河心/光壳区域；动作锚点：${action.slice(0, 200)}`,
      provenance: prov("panel-visual-action", ref, "来自单元宫格 visualAction"),
    });
    push("facing", {
      status: "resolved",
      value: "能量轮廓朝向保持与完整金面分离的相对方位，不构成佩戴朝向。",
      provenance: prov("panel-visual-action", ref, "分离悬浮关系"),
    });
    push("layout", {
      status: "resolved",
      value: "A01 与完整黄金面具同镜时保持分离：金面独立悬浮/置放于能量轮廓前方或旁侧，无附着融合。",
      provenance: prov("hardlock-a01-d01", ref, "空间分离硬规"),
    });
    push("lighting", {
      status: "resolved",
      value: "冷金/蓝白高维能量光与河雾环境光；无现代光源。",
      provenance: prov("panel-visual-action", ref, "单元光色"),
    });
  } else if (kind === "d01-golden-mask") {
    push("costume", {
      status: "not-applicable",
      reason: "D01 为独立道具，非人物着装。",
      provenance: prov("hardlock-d01", ref, "道具非服装"),
    });
    push("injury", {
      status: "not-applicable",
      reason: "金属面具无伤势字段；禁止裂面/半面。",
      provenance: prov("hardlock-d01", ref, "完整闭口刚性"),
    });
    push("heldObject", {
      status: "not-applicable",
      reason: "主体即完整黄金面具本身，不另持他物。",
      provenance: prov("hardlock-d01", ref, "道具本体"),
    });
    push("emotion", {
      status: "not-applicable",
      reason: "闭口刚性面具无表情/口型/眼睑；台词仅后期画外。",
      provenance: prov("hardlock-d01", ref, "无表情"),
    });
    push("position", {
      status: "resolved",
      value: `本格 ${ctx.startMilliseconds}-${ctx.endMilliseconds}ms：完整金面独立于画面焦点；动作锚点：${action.slice(0, 200)}`,
      provenance: prov("panel-visual-action", ref, "来自单元宫格 visualAction"),
    });
    push("facing", {
      status: "resolved",
      value: "金面正面朝向镜头或场景主轴；不随声震颤改变朝向语义。",
      provenance: prov("panel-visual-action", ref, "刚性朝向"),
    });
    push("layout", {
      status: "resolved",
      value: "完整一整张闭口刚性金面；与 A01/人体/犬身分离，禁止融合附着。",
      provenance: prov("hardlock-d01", ref, "独立完整金面"),
    });
    push("lighting", {
      status: "resolved",
      value: "金属既有金纹与眼窝环境反光低幅变化；无自发光表情。",
      provenance: prov("panel-visual-action", ref, "金属反光"),
    });
  } else {
    // 通用已绑定 subject：从角色/场景/道具类别给可审计默认，仍禁止空值
    if (ctx.category === "character") {
      push("costume", {
        status: "resolved",
        value: `保持规范资产权威服装；role=${ctx.role.slice(0, 120)}`,
        provenance: prov("binding-role", ref, "来自 BindingSet role"),
      });
      push("injury", {
        status: "resolved",
        value: "本格无新增可见伤势。",
        provenance: prov("panel-default", ref, "无伤势叙述"),
      });
      push("heldObject", {
        status: "resolved",
        value: "本格持物以 Binding 与 visualAction 为准；未提及则空手。",
        provenance: prov("panel-visual-action", ref, action.slice(0, 100)),
      });
      push("emotion", {
        status: "resolved",
        value: "情绪服从本格动作，不改变硬锁脸型。",
        provenance: prov("panel-visual-action", ref, "情绪从动作"),
      });
    } else if (ctx.category === "style") {
      for (const field of ["costume", "injury", "heldObject", "emotion", "position", "facing"] as const) {
        push(field, {
          status: "not-applicable",
          reason: `style 资产只约束画面视觉语法，不具备 ${field} 主体状态。`,
          provenance: prov("style-category-na", ref, field),
        });
      }
      push("layout", {
        status: "resolved",
        value: `保持风格母版的构图、材质与画面语法；不得借画风改写角色、场景或道具身份。动作锚点：${action.slice(0, 160)}`,
        provenance: prov("style-lock", ref, "构图与材质"),
      });
      push("lighting", {
        status: "resolved",
        value: `保持风格母版的色彩、光影与质感连续；role=${ctx.role.slice(0, 120)}`,
        provenance: prov("style-lock", ref, "色彩与光影"),
      });
    } else {
      push("costume", {
        status: "not-applicable",
        reason: `${ctx.category} 主体无人物服装字段。`,
        provenance: prov("category-na", ref, ctx.category),
      });
      push("injury", {
        status: "not-applicable",
        reason: `${ctx.category} 主体无伤势字段。`,
        provenance: prov("category-na", ref, ctx.category),
      });
      push("heldObject", {
        status: "not-applicable",
        reason: `${ctx.category} 主体无持物字段。`,
        provenance: prov("category-na", ref, ctx.category),
      });
      push("emotion", {
        status: "not-applicable",
        reason: `${ctx.category} 主体无情绪字段。`,
        provenance: prov("category-na", ref, ctx.category),
      });
    }
    if (ctx.category !== "style") {
      push("position", {
        status: "resolved",
        value: `本格 ${ctx.startMilliseconds}-${ctx.endMilliseconds}ms 位置服从：${action.slice(0, 200)}`,
        provenance: prov("panel-visual-action", ref, "位置"),
      });
      push("facing", {
        status: "resolved",
        value: "朝向服从本格轴线与 visualAction，保持与硬锁一致。",
        provenance: prov("panel-visual-action", ref, "朝向"),
      });
      push("layout", {
        status: "resolved",
        value: "布局服从 Binding 与 visualAction，不引入未绑定主体。",
        provenance: prov("panel-visual-action", ref, "布局"),
      });
      push("lighting", {
        status: "resolved",
        value: "光线服从单元场景母题，无现代穿帮光源。",
        provenance: prov("panel-visual-action", ref, "光线"),
      });
    }
  }

  // 保证九字段齐全且顺序固定
  const byField = new Map(plans.map((p) => [p.field, p]));
  return STUDIO_CONTINUITY_FIELDS.map((field) => {
    const plan = byField.get(field);
    if (!plan) throw new Error(`缺少字段计划：${field} for ${ctx.assetId}`);
    return plan;
  });
}

export function assertNineFieldCoverage(plans: ContinuityFieldPlan[]): void {
  if (plans.length !== STUDIO_CONTINUITY_FIELDS.length) {
    throw new Error(`九字段数量错误：${plans.length}`);
  }
  for (let i = 0; i < STUDIO_CONTINUITY_FIELDS.length; i++) {
    if (plans[i]!.field !== STUDIO_CONTINUITY_FIELDS[i]) {
      throw new Error(`字段顺序错误 at ${i}: ${plans[i]!.field}`);
    }
  }
  const ref = plans.find((p) => p.field === "referenceSha256");
  if (!ref || ref.state.status !== "resolved" || !SHA256.test(ref.state.value)) {
    throw new Error("referenceSha256 必须为 resolved 的 64 位小写 SHA-256");
  }
}
