<script setup lang="ts">
/**
 * 导演「生成追溯」只读抽屉。数据经 canvas:get-studio-trace；不 evaluate 像素、不调 Binding。
 */
import { formatPreviousStandingReadonlyLine } from "@core/studio-panel-standing";

export type StudioTraceDrawerModel = {
  pack: { packId: string; fingerprint: string };
  target: { targetKind: string; targetKey: string };
  unit: { unitId: string; unitRevision: number };
  changeClassification: { classification: string; expectedReasons: string[]; unexpectedReasons: string[] };
  previousStandings?: Array<{
    panelId: string;
    previousStanding: {
      panelIndex: number;
      shotComposition: string;
      visualAction: string;
      filmingMethod: string;
      source?: string;
    };
  }>;
  frozenPanelOverlays?: Array<{
    panelId: string;
    lighting: string | null;
    costume: string | null;
  }>;
  runs: Array<{ runId: string; provider: string; terminal: boolean }>;
  results: Array<{ resultId: string; variant: string; inputCurrent: boolean }>;
  runsTruncated: boolean;
  resultsTruncated: boolean;
  consistencyPeek?: {
    status: "cached" | "unevaluated";
    verdict?: "consistent" | "needs-review" | "drifted" | "not-checkable";
    generationRunId: string | null;
  };
};

defineProps<{
  open: boolean;
  loading: boolean;
  error: string;
  trace: StudioTraceDrawerModel | null;
}>();

const emit = defineEmits<{
  close: [];
}>();

function standingLine(row: NonNullable<StudioTraceDrawerModel["previousStandings"]>[number]): string {
  return formatPreviousStandingReadonlyLine(row.previousStanding) ?? "前镜行无法格式化";
}

function consistencyPeekLabel(peek?: StudioTraceDrawerModel["consistencyPeek"]): string {
  if (!peek || peek.status === "unevaluated" || !peek.verdict) return "一致性：未评估";
  if (peek.verdict === "consistent") return "一致性：一致";
  if (peek.verdict === "needs-review") return "一致性：需复核";
  if (peek.verdict === "drifted") return "一致性：明显漂移";
  return "一致性：无法检查";
}

function classificationLabel(value: string): string {
  if (value === "expected") return "预期变化";
  if (value === "unexpected") return "非预期变化";
  if (value === "current") return "当前一致";
  return value;
}
</script>

<template>
  <aside
    v-if="open"
    class="trace-drawer"
    data-testid="studio-generation-trace-drawer"
    role="dialog"
    aria-label="生成追溯"
  >
    <header>
      <h3>生成追溯</h3>
      <button type="button" data-testid="studio-generation-trace-close" @click="emit('close')">关闭</button>
    </header>
    <p class="hint">只读 get_studio_trace。历史身份经冻结包还原，不读 unit head。不是 BindingSet，不自动 Review PASS。</p>
    <p v-if="loading" data-testid="studio-generation-trace-loading">正在读取追溯…</p>
    <p v-else-if="error" class="error" data-testid="studio-generation-trace-error">{{ error }}</p>
    <template v-else-if="trace">
      <dl data-testid="studio-generation-trace-identity">
        <dt>目标</dt>
        <dd>{{ trace.target.targetKind }} · {{ trace.target.targetKey }}</dd>
        <dt>单元</dt>
        <dd>{{ trace.unit.unitId }} · r{{ trace.unit.unitRevision }}</dd>
        <dt>冻结包</dt>
        <dd>{{ trace.pack.packId }} · {{ trace.pack.fingerprint.slice(0, 12) }}</dd>
        <dt>变化分类</dt>
        <dd data-testid="studio-generation-trace-classification">{{ classificationLabel(trace.changeClassification.classification) }}</dd>
        <dt>一致性</dt>
        <dd data-testid="studio-generation-trace-peek">{{ consistencyPeekLabel(trace.consistencyPeek) }}</dd>
      </dl>
      <section data-testid="studio-generation-trace-previous-standings">
        <h4>前镜交接</h4>
        <ul v-if="trace.previousStandings?.length">
          <li v-for="row in trace.previousStandings" :key="`${row.panelId}:${row.previousStanding.panelIndex}`">
            <code>{{ row.panelId || "panelId 未记" }}</code>
            <span>{{ standingLine(row) }}</span>
          </li>
        </ul>
        <p v-else class="empty">历史包无「前镜交接」行，已省略 previousStandings。</p>
      </section>
      <section data-testid="studio-generation-trace-overlays">
        <h4>光线 / 服装覆盖</h4>
        <ul v-if="trace.frozenPanelOverlays?.length">
          <li v-for="row in trace.frozenPanelOverlays" :key="`overlay:${row.panelId}:${row.lighting ?? ''}:${row.costume ?? ''}`">
            <code>{{ row.panelId || "panelId 未记" }}</code>
            <span>{{ [row.lighting ? `光线：${row.lighting}` : "", row.costume ? `服装：${row.costume}` : ""].filter(Boolean).join(" · ") }}。不是 BindingSet。</span>
          </li>
        </ul>
        <p v-else class="empty">历史包无「光线/服装（宫格覆盖）」行，已省略 frozenPanelOverlays。</p>
      </section>
      <p class="counts" data-testid="studio-generation-trace-counts">
        runs {{ trace.runs.length }}{{ trace.runsTruncated ? "+" : "" }}
        · results {{ trace.results.length }}{{ trace.resultsTruncated ? "+" : "" }}
      </p>
    </template>
  </aside>
</template>

<style scoped>
.trace-drawer {
  position: absolute;
  right: 12px;
  top: 56px;
  z-index: 41;
  width: min(420px, calc(100% - 24px));
  max-height: min(74vh, 640px);
  overflow: auto;
  border: 1px solid var(--msc-line, #34362f);
  border-radius: 10px;
  background: var(--msc-surface, #1a1c17);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.35);
  padding: 10px 12px 14px;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
header h3,
section h4 {
  margin: 0;
  font-size: 13px;
  color: var(--msc-text, #e8e6dc);
}
header button {
  border: 0;
  background: transparent;
  color: var(--msc-text-2, #a6a99e);
  cursor: pointer;
}
.hint,
.empty,
.counts {
  margin: 6px 0 10px;
  color: var(--msc-text-3, #7a7d72);
  font-size: 10px;
  line-height: 1.45;
}
.error {
  color: #d28b8b;
  font-size: 12px;
  line-height: 1.45;
}
dl {
  display: grid;
  grid-template-columns: 72px 1fr;
  gap: 4px 8px;
  margin: 0 0 12px;
  font-size: 12px;
}
dt {
  color: var(--msc-text-3, #7a7d72);
}
dd {
  margin: 0;
  color: var(--msc-text, #e8e6dc);
  overflow-wrap: anywhere;
}
section ul {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: grid;
  gap: 8px;
}
section li {
  display: grid;
  gap: 3px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--msc-text-2, #a6a99e);
}
section code {
  color: #9bb07a;
  font: 10px/1.3 Menlo, monospace;
}
</style>
