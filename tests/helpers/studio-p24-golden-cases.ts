/**
 * P24 golden 固定样本矩阵（规范 §2.7）：3 格型 × 5 差异类 × 2 分类 = 30 case。
 * 每 case 独立夹具（确定性、本地、可重复）；runner 与 update 脚本共用本模块的 case 定义与执行器。
 */
import {
  advanceP24PromptRevision,
  advanceP24ScriptRevision,
  createStudioP24TraceFixture,
  dispatchAndRegisterP24Pair,
  freezeP24Pack,
  rebindP24PanelToNewHead,
  reviseP24UnitSpans,
  reviseP24UnitToNewRevisions,
  reversionP24AssetAuthority,
  type StudioP24FrozenPack,
  type StudioP24TraceFixture,
} from "./studio-p24-trace-fixture.js";
import {
  getStudioGenerationTrace,
  getStudioScriptRevisionImpact,
  type StudioGenerationTrace,
} from "../../src/core/studio-trace.js";

export type StudioP24GridKind = "two" | "four" | "six";
export type StudioP24Difference = "prompt" | "asset" | "continuity" | "source-spans" | "binding-set";
export type StudioP24Classification = "expected" | "unexpected";

export interface StudioP24GoldenCase {
  id: string;
  grid: StudioP24GridKind;
  difference: StudioP24Difference;
  classification: StudioP24Classification;
}

export const STUDIO_P24_GOLDEN_CASES: StudioP24GoldenCase[] = (["two", "four", "six"] as const).flatMap((grid) =>
  ([
    ["prompt", "expected"], ["prompt", "unexpected"],
    ["asset", "expected"], ["asset", "unexpected"],
    ["continuity", "expected"], ["continuity", "unexpected"],
    ["source-spans", "expected"], ["source-spans", "unexpected"],
    ["binding-set", "expected"], ["binding-set", "unexpected"],
  ] as Array<[StudioP24Difference, StudioP24Classification]>).map(([difference, classification]) => ({
    id: `${grid}-${difference}-${classification}`,
    grid,
    difference,
    classification,
  })));

export interface StudioP24GoldenActual {
  classification: StudioP24Classification | "current";
  expectedReasons: string[];
  unexpectedReasons: string[];
  atTheTime: {
    /** 跨运行确定性（内容寻址文本修订）：可精确比对。 */
    promptRevisionId: string;
    scriptRevisionId: string;
    spans: Array<{ startOffsetUtf16: number; endOffsetUtf16: number }>;
    /** 跨运行含时间戳派生（绑定集/连续性指纹）：只断言"触发后仍=触发前基线"的保存关系。 */
    promptPreserved: boolean;
    scriptPreserved: boolean;
    bindingSetPreserved: boolean;
    continuityPreserved: boolean;
  };
  impactPackHit: boolean;
  impactClassification: string | null;
}

/** 每 case 的触发器：真实用户流（修订文档→推进单元）/绑定重冻结/资产再版本，全部合法 API。 */
async function runP24CaseTrigger(fixture: StudioP24TraceFixture, goldenCase: StudioP24GoldenCase, pack: StudioP24FrozenPack): Promise<void> {
  const unit = fixture.units[goldenCase.grid];
  const unexpected = async () => {
    await reversionP24AssetAuthority(fixture, goldenCase.difference === "continuity" ? "scene-stone-room" : "character-ahang");
  };
  if (goldenCase.difference === "prompt") {
    const advanced = await advanceP24PromptRevision(fixture);
    await reviseP24UnitToNewRevisions(fixture, unit, { promptRevisionId: advanced.revision.id });
  } else if (goldenCase.difference === "continuity") {
    const advanced = await advanceP24ScriptRevision(fixture);
    await reviseP24UnitToNewRevisions(fixture, unit, { scriptRevisionId: advanced.revision.id });
  } else if (goldenCase.difference === "asset" || goldenCase.difference === "binding-set") {
    if (goldenCase.classification === "expected") {
      await rebindP24PanelToNewHead(fixture, unit, pack.panel.index);
    }
  } else if (goldenCase.difference === "source-spans") {
    await reviseP24UnitSpans(fixture, unit);
  }
  if (goldenCase.classification === "unexpected") await unexpected();
}

/** 执行单 case 并返回实际观测（runner 与 update 脚本共用）。 */
export async function executeStudioP24GoldenCase(goldenCase: StudioP24GoldenCase): Promise<StudioP24GoldenActual> {
  const fixture = await createStudioP24TraceFixture();
  try {
    const unit = fixture.units[goldenCase.grid];
    const pack = await freezeP24Pack(fixture, unit, 1);
    await dispatchAndRegisterP24Pair(fixture, pack, `p24-golden-${goldenCase.id}-run`);
    const baseline = await getStudioGenerationTrace(fixture.root, { packId: pack.packId });
    await runP24CaseTrigger(fixture, goldenCase, pack);
    const trace: StudioGenerationTrace = await getStudioGenerationTrace(fixture.root, { packId: pack.packId });
    const impact = await getStudioScriptRevisionImpact(fixture.root, { scriptRevisionId: unit.scriptRevision.id });
    const impactRows = impact.items.flatMap((item) => item.rows);
    const packRow = impactRows.find((row) => row.packId === pack.packId);
    return {
      classification: trace.changeClassification.classification,
      expectedReasons: trace.changeClassification.expectedReasons,
      unexpectedReasons: trace.changeClassification.unexpectedReasons,
      atTheTime: {
        // 关键合同：触发后 trace 仍返回基线（冻结时）身份，不读 head。
        promptRevisionId: trace.prompt!.revisionId,
        scriptRevisionId: trace.script.revisionId,
        spans: trace.panel!.sourceSpans.map((span) => ({ startOffsetUtf16: span.startOffsetUtf16, endOffsetUtf16: span.endOffsetUtf16 })),
        promptPreserved: trace.prompt!.revisionId === baseline.prompt!.revisionId,
        scriptPreserved: trace.script.revisionId === baseline.script.revisionId,
        bindingSetPreserved: trace.bindingSet!.id === baseline.bindingSet!.id,
        continuityPreserved: trace.continuity.fingerprint === baseline.continuity.fingerprint,
      },
      impactPackHit: Boolean(packRow),
      impactClassification: packRow?.changeClassification ?? null,
    };
  } finally {
    await fixture.p7.cleanup();
  }
}

/** golden 文件中每 case 的期望形态。 */
export interface StudioP24GoldenExpectation {
  classification: StudioP24Classification | "current";
  expectedContains: string[];
  unexpectedContains: string[];
  atTheTime: StudioP24GoldenActual["atTheTime"];
  impactPackHit: true;
  impactClassification: StudioP24Classification;
}

export interface StudioP24GoldenFile {
  schemaVersion: 1;
  updatedAt: string;
  sourceDigest: string;
  note: string;
  cases: Record<string, StudioP24GoldenExpectation>;
}

/** 对比 actual 与 expectation，返回差异文本（空数组=一致）。 */
export function diffStudioP24GoldenCase(expectation: StudioP24GoldenExpectation, actual: StudioP24GoldenActual): string[] {
  const diffs: string[] = [];
  if (expectation.classification !== actual.classification) {
    diffs.push(`classification 期望 ${expectation.classification} 实际 ${actual.classification}`);
  }
  for (const reason of expectation.expectedContains) {
    if (!actual.expectedReasons.includes(reason)) diffs.push(`expectedReasons 缺少 ${reason}（实际：${actual.expectedReasons.join(", ") || "空"}）`);
  }
  for (const reason of expectation.unexpectedContains) {
    if (!actual.unexpectedReasons.includes(reason)) diffs.push(`unexpectedReasons 缺少 ${reason}（实际：${actual.unexpectedReasons.join(", ") || "空"}）`);
  }
  if (JSON.stringify(expectation.atTheTime) !== JSON.stringify(actual.atTheTime)) {
    diffs.push(`atTheTime 不一致：期望 ${JSON.stringify(expectation.atTheTime)} 实际 ${JSON.stringify(actual.atTheTime)}`);
  }
  if (actual.impactPackHit !== expectation.impactPackHit) diffs.push(`impactPackHit 期望 true 实际 ${actual.impactPackHit}`);
  if (expectation.impactClassification !== actual.impactClassification) {
    diffs.push(`impactClassification 期望 ${expectation.impactClassification} 实际 ${String(actual.impactClassification)}`);
  }
  return diffs;
}
