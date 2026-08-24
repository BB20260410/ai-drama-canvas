<template>
  <div class="import-overlay" @click.self="requestCancel">
    <section class="import-wizard">
      <header class="wizard-header">
        <div><span class="eyebrow">项目入库</span><h2>把真实制作目录接入画布</h2><p>预检只读取文件；最后确认后才建立或更新 .aicanvas。</p></div>
        <button class="icon-button" type="button" data-testid="project-import-close" aria-label="关闭导入向导" :disabled="working" :title="working ? '正在处理，不能再关闭导入向导' : undefined" @click="requestCancel"><X :size="18" /></button>
      </header>

      <nav class="step-rail" aria-label="导入步骤">
        <button v-for="(label, index) in steps" :key="label" type="button" :class="{ active: stage === index, done: stage > index }" :disabled="working || index > maxStage" :title="working ? '正在处理，不能再切换步骤' : undefined" @click="stage = index">
          <i>{{ stage > index ? '✓' : index + 1 }}</i><span>{{ label }}</span>
        </button>
      </nav>

      <div class="wizard-main">
        <Transition name="stage" mode="out-in">
          <section v-if="stage === 0" key="source" class="stage-panel source-stage">
            <div class="stage-heading"><span>01 / 04</span><h3>定义项目边界</h3><p>主根是事实来源和默认输出位置；附加来源只读取，不会自动写入。</p></div>
            <label class="field"><span>项目名称</span><input v-model="draft.name" placeholder="例如：黄金面具 · 古蜀卷" /></label>
            <div class="field"><span>起步方式</span><div class="mode-switch" role="radiogroup" aria-label="项目起步方式"><button type="button" role="radio" :aria-checked="projectMode === 'filesystem'" :class="{ active: projectMode === 'filesystem' }" @click="projectMode = 'filesystem'"><b>制作目录</b><small>目录中已经有 15 秒单元或镜头</small></button><button type="button" role="radio" :aria-checked="projectMode === 'story_first'" :class="{ active: projectMode === 'story_first' }" @click="projectMode = 'story_first'"><b>小说起步项目</b><small>允许空画布，先导入原文再建立分集</small></button></div></div>
            <label class="field"><span>项目主根</span><div class="path-input"><input v-model="draft.primaryRoot" readonly /><button type="button" :disabled="working || pickingRoot" :title="(working || pickingRoot) ? '正在处理，不能再更换项目主根' : undefined" @click="replacePrimary"><FolderOpen :size="14" /> 更换</button></div></label>
            <div class="root-editor">
              <div class="editor-heading"><div><b>附加来源根</b><small>剧本、参考图或其他生产目录</small></div><button type="button" :disabled="working || pickingRoot" :title="(working || pickingRoot) ? '正在处理，不能再添加扫描根' : undefined" @click="addRoot('source')"><Plus :size="14" /> 添加</button></div>
              <div v-if="!draft.sourceRoots.length" class="empty-line">当前只扫描项目主根</div>
              <div v-for="(root, index) in draft.sourceRoots" :key="`source-${index}`" class="path-row"><span>S{{ index + 1 }}</span><input v-model="draft.sourceRoots[index]" /><button type="button" :aria-label="`移除来源 ${index + 1}`" @click="draft.sourceRoots.splice(index, 1)"><X :size="14" /></button></div>
            </div>
            <div class="root-editor output-editor">
              <div class="editor-heading"><div><b>额外输出根</b><small>Codex 允许写入的新版本位置</small></div><button type="button" :disabled="working || pickingRoot" :title="(working || pickingRoot) ? '正在处理，不能再添加扫描根' : undefined" @click="addRoot('output')"><Plus :size="14" /> 添加</button></div>
              <div v-for="(root, index) in extraOutputRoots" :key="`output-${index}`" class="path-row"><span>O{{ index + 1 }}</span><input :value="root" @input="updateOutput(index, ($event.target as HTMLInputElement).value)" /><button type="button" :aria-label="`移除输出 ${index + 1}`" @click="removeOutput(index)"><X :size="14" /></button></div>
            </div>
          </section>

          <section v-else-if="stage === 1" key="recognition" class="stage-panel recognition-stage">
            <div class="stage-heading"><span>02 / 04</span><h3>核对识别结果</h3><p>这些数字来自当前真实文件，不依据聊天记录。</p></div>
            <div v-if="preview" class="recognition-layout">
              <div class="recognition-hero"><div><span>15 秒单元</span><b>{{ preview.recognized.units }}</b></div><div><span>原镜头</span><b>{{ preview.recognized.shots }}</b><small>{{ preview.recognized.nestedShots }} 已归属父单元</small></div><div><span>素材版本</span><b>{{ preview.recognized.artifacts }}</b><small>{{ preview.recognized.deprecatedArtifacts }} 已分流旧版</small></div><div><span>机械异常</span><b :class="{ danger: preview.recognized.mechanicalFailures }">{{ preview.recognized.mechanicalFailures }}</b></div></div>
              <div class="root-ledger"><header><span>扫描根</span><span>发现 / 识别</span></header><article v-for="root in preview.roots" :key="`${root.role}-${root.root}`"><i :class="root.role">{{ roleLabel(root.role) }}</i><div><b>{{ basename(root.root) }}</b><small>{{ root.root }}</small></div><span>{{ root.discoveredFiles }} / {{ root.recognizedArtifacts }}</span></article></div>
              <div v-if="preview.projectMode === 'story_first' && preview.recognized.units === 0 && preview.recognized.shots === 0" class="story-first-note"><BookOpenText :size="18" /><div><b>这是小说起步空项目</b><p>本次确认只建立可恢复侧车与空索引，不会伪造生产进度；后续需导入原文并建立分集单元。</p></div></div>
              <div class="sample-strip"><header><span>识别样本</span><small>最多显示 16 个节点</small></header><div><article v-for="item in preview.sampleItems" :key="item.id"><span>EP{{ pad(item.episode) }} · {{ item.type === 'shot' ? `镜${item.shot}` : `15s ${pad(item.unit,3)}` }}</span><b>{{ item.title }}</b><small>{{ item.status }} · {{ item.nextAction }}</small></article></div></div>
            </div>
          </section>

          <section v-else-if="stage === 2" key="rules" class="stage-panel rules-stage">
            <div class="stage-heading"><span>03 / 04</span><h3>确认分流规则与风险</h3><p>命中忽略词的目录仍会索引为历史版本，但不计入完成度。</p></div>
            <div class="rules-layout">
              <div class="rule-editors"><label class="ignore-editor"><span>忽略目录关键词 · 每行一个</span><textarea v-model="ignoreText" rows="7" spellcheck="false"></textarea><small>建议保留：旧版、弃用、备份、archive、deprecated</small></label><label class="ignore-editor"><span>自定义 15 秒单元正则 · 每行一个</span><textarea v-model="unitPatternText" rows="4" spellcheck="false" placeholder="第(?&lt;episode&gt;\d+)集/段(?&lt;unit&gt;\d+)"></textarea><small>推荐使用命名组 episode 与 unit</small></label><label class="ignore-editor"><span>自定义原镜头正则 · 每行一个</span><textarea v-model="shotPatternText" rows="4" spellcheck="false" placeholder="第(?&lt;episode&gt;\d+)集/镜(?&lt;shot&gt;\d+)"></textarea><small>推荐使用命名组 episode、unit（可选）与 shot</small></label><label class="ignore-editor"><span>手工路径映射 JSON</span><textarea v-model="manualMappingText" rows="5" spellcheck="false" placeholder='[{"pathPrefix":"第一集/开场","type":"unit","episode":1,"unit":1}]'></textarea><small>无法从文件名推断编号时使用；最长路径前缀优先</small></label></div>
              <div class="issue-ledger"><header><span>预检结论</span><b>{{ issueCounts.error }} 错误 · {{ issueCounts.warning }} 警告</b></header><div v-if="!preview?.issues.length" class="all-clear"><CircleCheck :size="18" /> 没有发现导入风险</div><article v-for="issue in preview?.issues" :key="`${issue.code}-${issue.path}-${issue.message}`" :class="issue.severity"><i><CircleAlert v-if="issue.severity !== 'info'" :size="14" /><Info v-else :size="14" /></i><div><b>{{ issue.message }}</b><small v-if="issue.path">{{ issue.path }}</small></div></article></div>
            </div>
          </section>

          <section v-else key="confirm" class="stage-panel confirm-stage">
            <div class="stage-heading"><span>04 / 04</span><h3>{{ preview?.mode === 'new' ? '建立项目侧车' : '接续现有项目' }}</h3><p>不会移动、删除或覆盖任何原始素材；只写画布侧车、缓存和可读进度文件。</p></div>
            <div v-if="preview" class="confirm-layout">
              <div class="confirm-project"><span class="project-glyph"><FolderKanban :size="30" /></span><div><em>{{ modeLabel(preview.mode) }}</em><h4>{{ preview.config.name }}</h4><p>{{ preview.config.primaryRoot }}</p></div></div>
              <div v-if="preview.projectMode === 'story_first'" class="story-first-confirm"><BookOpenText :size="18" /><div><b>确认以小说起步</b><p>你确认当前可能没有任何 15 秒单元。应用仍会验证主根可读写，并建立真实的空索引；空索引不代表制作已经完成。</p></div></div>
              <div class="write-ledger"><header>将写入或更新</header><div v-for="file in preview.willWrite" :key="file"><span></span><code>{{ file }}</code></div></div>
              <div class="safety-note"><ShieldCheck :size="20" /><div><b>原始素材保持原位</b><p>移除项目登记也不会删除项目目录或 .aicanvas；已有画布、验收与任务历史会被保留。</p></div></div>
            </div>
          </section>
        </Transition>
      </div>

      <footer class="wizard-footer">
        <div class="scan-state"><LoaderCircle v-if="working" class="spinning" :size="15" /><CircleCheck v-else-if="preview?.canImport" :size="15" /><CircleAlert v-else :size="15" /><span>{{ stateText }}</span></div>
        <div><button type="button" class="secondary" data-testid="project-import-back" :disabled="working" :title="working ? '正在处理，不能再返回' : undefined" @click="stage ? stage-- : requestCancel">{{ stage ? '上一步' : '取消' }}</button><button type="button" class="primary" data-testid="project-import-advance" :disabled="working || (stage === 3 && !preview?.canImport)" :title="working ? '正在处理，不能再导入项目' : undefined" @click="advance"><span>{{ working ? "处理中" : primaryLabel }}</span><ArrowRight v-if="stage < 3" :size="15" /><Check v-else :size="15" /></button></div>
      </footer>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { ArrowRight, BookOpenText, Check, CircleAlert, CircleCheck, FolderKanban, FolderOpen, Info, LoaderCircle, Plus, ShieldCheck, X } from "lucide-vue-next";
import type { ProjectConfig, ProjectImportMode, ProjectImportPreview, ProjectIndex } from "@core/types";

const props = defineProps<{ initialRoot: string }>();
const emit = defineEmits<{ cancel: []; imported: [index: ProjectIndex] }>();
const steps = ["目录", "识别", "规则", "确认"];
const stage = ref(0);
const maxStage = ref(0);
const working = ref(true);
const pickingRoot = ref(false);
const errorText = ref("");
const preview = ref<ProjectImportPreview | null>(null);
const projectMode = ref<ProjectImportMode>("filesystem");
const draft = reactive<ProjectConfig>({ schemaVersion: 1, id: "", name: "", primaryRoot: props.initialRoot, sourceRoots: [], outputRoots: [props.initialRoot], ignoreSegments: [], namingRules: { patterns: [], manualMappings: [] }, hardLocks: [], automation: { imageBatchSize: 6, videoBatchSize: 3, pauseAfterVisualBatch: true, allowOverwriteAuthoritative: false }, createdAt: "", updatedAt: "" });
const ignoreText = ref("");
const unitPatternText = ref("");
const shotPatternText = ref("");
const manualMappingText = ref("[]");
let syncing = false;
const dirty = ref(true);

const extraOutputRoots = computed(() => draft.outputRoots.filter((root) => root !== draft.primaryRoot));
const issueCounts = computed(() => ({ error: preview.value?.issues.filter((issue) => issue.severity === "error").length ?? 0, warning: preview.value?.issues.filter((issue) => issue.severity === "warning").length ?? 0 }));
const primaryLabel = computed(() => stage.value === 0 ? "开始只读预检" : stage.value === 1 ? "检查导入规则" : stage.value === 2 ? "查看写入范围" : preview.value?.mode === "new" ? "确认导入项目" : "确认接续项目");
const stateText = computed(() => working.value ? "正在读取目录…" : errorText.value || (dirty.value ? "规则已改变，需要重新预检" : preview.value?.canImport ? `预检通过 · ${preview.value.scanDurationMs}ms` : "存在必须处理的导入错误"));

watch(draft, () => { if (!syncing) dirty.value = true; }, { deep: true, flush: "sync" });
watch(projectMode, () => { if (!syncing) dirty.value = true; }, { flush: "sync" });
watch(ignoreText, () => { if (!syncing) dirty.value = true; }, { flush: "sync" });
watch([unitPatternText, shotPatternText, manualMappingText], () => { if (!syncing) dirty.value = true; }, { flush: "sync" });
onMounted(() => void prepare());

function applyPreview(value: ProjectImportPreview) {
  syncing = true;
  preview.value = value;
  projectMode.value = value.projectMode;
  Object.assign(draft, JSON.parse(JSON.stringify(value.config)) as ProjectConfig);
  ignoreText.value = value.config.ignoreSegments.join("\n");
  unitPatternText.value = value.config.namingRules.patterns.filter((rule) => rule.type === "unit").map((rule) => rule.pattern).join("\n");
  shotPatternText.value = value.config.namingRules.patterns.filter((rule) => rule.type === "shot").map((rule) => rule.pattern).join("\n");
  manualMappingText.value = JSON.stringify(value.config.namingRules.manualMappings, null, 2);
  dirty.value = false;
  syncing = false;
}

function requestCancel() {
  if (working.value) return;
  emit("cancel");
}

async function runPrepare() {
  errorText.value = "";
  const unitPatterns = unitPatternText.value.split("\n").map((item) => item.trim()).filter(Boolean);
  const shotPatterns = shotPatternText.value.split("\n").map((item) => item.trim()).filter(Boolean);
  const manualMappings = JSON.parse(manualMappingText.value || "[]") as ProjectConfig["namingRules"]["manualMappings"];
  if (!Array.isArray(manualMappings)) throw new Error("手工路径映射必须是 JSON 数组。");
  const namingRules = { patterns: [...unitPatterns.map((pattern, index) => ({ id: `custom-unit-${index + 1}`, type: "unit" as const, pattern })), ...shotPatterns.map((pattern, index) => ({ id: `custom-shot-${index + 1}`, type: "shot" as const, pattern }))], manualMappings };
  const value = await window.canvasApi.prepareImport({ primaryRoot: draft.primaryRoot, projectMode: projectMode.value, name: draft.name || undefined, sourceRoots: [...draft.sourceRoots], outputRoots: [...draft.outputRoots], ignoreSegments: ignoreText.value ? ignoreText.value.split(/\n|,/).map((item) => item.trim()).filter(Boolean) : undefined, namingRules });
  applyPreview(value);
}

async function prepare() {
  if (working.value) return;
  working.value = true;
  try {
    await runPrepare();
  } catch (error) { errorText.value = message(error); }
  finally { working.value = false; }
}

async function advance() {
  if (working.value) return;
  working.value = true;
  try {
    if (stage.value < 3) {
      if (dirty.value || !preview.value) await runPrepare();
      if (errorText.value) return;
      stage.value += 1;
      maxStage.value = Math.max(maxStage.value, stage.value);
      return;
    }
    if (!preview.value || !preview.value.canImport) return;
    if (dirty.value) { await runPrepare(); return; }
    emit("imported", await window.canvasApi.commitImport({ previewId: preview.value.previewId, config: JSON.parse(JSON.stringify(preview.value.config)) as ProjectConfig, projectMode: preview.value.projectMode }));
  } catch (error) { errorText.value = message(error); }
  finally { working.value = false; }
}

async function replacePrimary() {
  if (working.value || pickingRoot.value) return;
  pickingRoot.value = true;
  try {
    const root = await window.canvasApi.pickProject("选择项目主根");
    if (root) { draft.primaryRoot = root; draft.outputRoots = [root, ...extraOutputRoots.value]; }
  } finally { pickingRoot.value = false; }
}
async function addRoot(role: "source" | "output") {
  if (working.value || pickingRoot.value) return;
  pickingRoot.value = true;
  try {
    const root = await window.canvasApi.pickProject(role === "source" ? "选择附加来源根" : "选择允许输出根");
    if (!root) return;
    if (role === "source" && !draft.sourceRoots.includes(root) && root !== draft.primaryRoot) draft.sourceRoots.push(root);
    if (role === "output" && !draft.outputRoots.includes(root)) draft.outputRoots.push(root);
  } finally { pickingRoot.value = false; }
}
function updateOutput(index: number, value: string) { const current = [...extraOutputRoots.value]; current[index] = value; draft.outputRoots = [draft.primaryRoot, ...current]; }
function removeOutput(index: number) { const current = [...extraOutputRoots.value]; current.splice(index, 1); draft.outputRoots = [draft.primaryRoot, ...current]; }
function roleLabel(role: "primary" | "source" | "output") { return ({ primary: "主", source: "源", output: "出" })[role]; }
function modeLabel(mode: ProjectImportPreview["mode"]) { return ({ new: "新项目", resume: "恢复侧车", registered: "更新已登记项目" })[mode]; }
function basename(value: string) { return value.split("/").filter(Boolean).at(-1) || value; }
function pad(value?: number, length=2) { return String(value ?? 0).padStart(length, "0"); }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
</script>

<style scoped>
.import-overlay{position:fixed;inset:0;z-index:260;display:grid;place-items:center;background:rgba(5,6,4,.84);backdrop-filter:blur(12px);animation:veil-in .18s ease-out}.import-wizard{width:min(1120px,calc(100vw - 54px));height:min(820px,calc(100vh - 48px));display:grid;grid-template-columns:176px minmax(0,1fr);grid-template-rows:92px minmax(0,1fr) 66px;overflow:hidden;border:1px solid #3b3d35;background:#11120f;box-shadow:0 36px 110px rgba(0,0,0,.7);animation:wizard-in .24s cubic-bezier(.2,.75,.25,1)}.wizard-header{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;padding:0 26px;border-bottom:1px solid #30322c;background:#171815}.wizard-header h2{margin:7px 0 4px;font-size:20px}.wizard-header p{margin:0;color:#777a70;font-size:9px}.step-rail{padding:28px 0;border-right:1px solid #30322c;background:#151613}.step-rail button{width:100%;height:58px;display:flex;align-items:center;gap:12px;padding:0 20px;border:0;border-left:2px solid transparent;background:transparent;color:#666960;text-align:left;cursor:pointer}.step-rail button i{width:24px;height:24px;display:grid;place-items:center;border:1px solid #3c3e36;border-radius:50%;font:8px Menlo,monospace;font-style:normal}.step-rail button span{font-size:9px}.step-rail button.active{border-left-color:#d7af55;background:#1e1e19;color:#e4e4dc}.step-rail button.active i{border-color:#d7af55;color:#d7af55}.step-rail button.done{color:#92958a}.step-rail button.done i{border-color:#59714f;background:#1b2618;color:#83aa72}.step-rail button:disabled{cursor:default}.wizard-main{min-width:0;overflow:auto;background:#10110e}.stage-panel{min-height:100%;padding:31px 34px 54px}.stage-heading{margin-bottom:28px}.stage-heading>span{color:#d7af55;font:8px Menlo,monospace}.stage-heading h3{margin:8px 0 5px;font-size:18px}.stage-heading p{margin:0;color:#74776d;font-size:9px}.field{display:grid;grid-template-columns:140px 1fr;align-items:center;gap:16px;margin-top:13px;color:#9a9d92;font-size:9px}.field>input,.path-input input,.path-row input,.ignore-editor textarea{width:100%;border:1px solid #35372f;outline:0;background:#181916;color:#e6e6de;padding:10px}.field input:focus,.path-row input:focus,.ignore-editor textarea:focus{border-color:#66572f}.mode-switch{display:grid;grid-template-columns:1fr 1fr;border:1px solid #35372f;background:#181916}.mode-switch button{min-height:48px;padding:8px 12px;border:0;border-right:1px solid #35372f;background:transparent;color:#7c7f75;text-align:left;cursor:pointer}.mode-switch button:last-child{border-right:0}.mode-switch b,.mode-switch small{display:block}.mode-switch b{font-size:9px}.mode-switch small{margin-top:5px;color:#5f6259;font-size:7px}.mode-switch button.active{box-shadow:inset 0 -2px #d7af55;background:#202019;color:#e6e6de}.mode-switch button.active small{color:#9d906c}.path-input{display:grid;grid-template-columns:1fr auto}.path-input input{border-right:0;color:#aaa}.path-input button,.editor-heading button{display:flex;align-items:center;gap:6px;border:1px solid #3a3c34;background:transparent;color:#d7af55;padding:0 11px;font-size:8px;cursor:pointer}.root-editor{margin-top:28px;border-top:1px solid #2e302a}.output-editor{margin-top:18px}.editor-heading{height:52px;display:flex;align-items:center;justify-content:space-between}.editor-heading b,.editor-heading small{display:block}.editor-heading b{font-size:10px}.editor-heading small{margin-top:4px;color:#676a61;font-size:8px}.editor-heading button{height:27px}.empty-line{height:42px;display:flex;align-items:center;border-bottom:1px solid #282a24;color:#5f6259;font-size:8px}.path-row{height:43px;display:grid;grid-template-columns:30px 1fr 34px;align-items:center;border-bottom:1px solid #282a24}.path-row>span{color:#d7af55;font:8px Menlo,monospace}.path-row input{height:31px;border:0;background:transparent;padding:0}.path-row>button{height:28px;border:0;background:transparent;color:#6e7168;cursor:pointer}.recognition-hero{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:#30322c}.recognition-hero>div{min-height:108px;padding:18px;background:#171815}.recognition-hero span,.recognition-hero b,.recognition-hero small{display:block}.recognition-hero span{color:#777a70;font-size:8px}.recognition-hero b{margin-top:12px;font:25px Menlo,monospace}.recognition-hero b.danger{color:#d36b59}.recognition-hero small{margin-top:7px;color:#5f6259;font-size:7px}.root-ledger{margin-top:24px;border-top:1px solid #30322c}.root-ledger header,.root-ledger article{display:grid;grid-template-columns:38px 1fr 110px;align-items:center}.root-ledger header{height:34px;color:#62655c;font-size:7px}.root-ledger header span:first-child{grid-column:1/3}.root-ledger article{min-height:54px;border-top:1px solid #282a24}.root-ledger article>i{width:22px;height:22px;display:grid;place-items:center;border:1px solid #4a4c43;color:#a7a99f;font:7px Menlo,monospace;font-style:normal}.root-ledger article>i.primary{border-color:#6c5930;color:#d7af55}.root-ledger article>i.source{border-color:#3b5660;color:#78a6b5}.root-ledger article b,.root-ledger article small{display:block}.root-ledger article b{font-size:9px}.root-ledger article small{max-width:630px;margin-top:4px;overflow:hidden;color:#5e6158;font:7px Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}.root-ledger article>span{color:#999c92;font:9px Menlo,monospace}.story-first-note,.story-first-confirm{display:flex;gap:12px;margin-top:20px;padding:13px 15px;border-left:2px solid #78a6b5;background:#171d1d;color:#78a6b5}.story-first-note b,.story-first-confirm b{color:#d4d8d3;font-size:9px}.story-first-note p,.story-first-confirm p{margin:5px 0 0;color:#76817d;font-size:8px;line-height:1.55}.sample-strip{margin-top:24px}.sample-strip>header{display:flex;justify-content:space-between;padding-bottom:9px;border-bottom:1px solid #30322c;color:#7a7d73;font-size:8px}.sample-strip>header small{color:#565950}.sample-strip>div{display:grid;grid-template-columns:repeat(2,1fr);column-gap:20px}.sample-strip article{min-width:0;padding:11px 0;border-bottom:1px solid #282a24}.sample-strip article span,.sample-strip article b,.sample-strip article small{display:block}.sample-strip article span{color:#d7af55;font-size:7px}.sample-strip article b{margin-top:5px;overflow:hidden;font-size:9px;text-overflow:ellipsis;white-space:nowrap}.sample-strip article small{margin-top:5px;color:#62655c;font-size:7px}.rules-layout{display:grid;grid-template-columns:minmax(260px,.75fr) 1.25fr;gap:34px}.ignore-editor>span,.ignore-editor>small{display:block}.ignore-editor>span{margin-bottom:10px;color:#a2a49a;font-size:9px}.ignore-editor textarea{resize:vertical;font:9px/1.8 Menlo,monospace}.ignore-editor>small{margin-top:8px;color:#62655c;font-size:7px}.issue-ledger{border-top:1px solid #30322c}.issue-ledger>header{height:39px;display:flex;align-items:center;justify-content:space-between;color:#777a70;font-size:8px}.issue-ledger>header b{color:#8c8f84;font-weight:400}.issue-ledger article{display:grid;grid-template-columns:27px 1fr;gap:8px;padding:11px 0;border-top:1px solid #292b25}.issue-ledger article>i{color:#d7af55}.issue-ledger article.error>i{color:#d36b59}.issue-ledger article.info>i{color:#78a6b5}.issue-ledger article b,.issue-ledger article small{display:block}.issue-ledger article b{font-size:8px;line-height:1.45}.issue-ledger article small{margin-top:5px;color:#5d6057;font:7px Menlo,monospace;word-break:break-all}.all-clear{display:flex;align-items:center;gap:8px;padding:22px 0;border-top:1px solid #292b25;color:#83aa72;font-size:9px}.confirm-layout{max-width:780px}.confirm-project{display:flex;align-items:center;gap:18px;padding:22px 0 26px;border-top:1px solid #30322c;border-bottom:1px solid #30322c}.project-glyph{width:64px;height:64px;display:grid;place-items:center;border:1px solid #69582f;color:#d7af55}.confirm-project em{color:#d7af55;font-size:7px;font-style:normal}.confirm-project h4{margin:7px 0 5px;font-size:18px}.confirm-project p{margin:0;color:#676a61;font:8px Menlo,monospace}.write-ledger{margin-top:22px}.write-ledger header{margin-bottom:9px;color:#7c7f74;font-size:8px}.write-ledger>div{display:grid;grid-template-columns:14px 1fr;align-items:center;min-height:32px;border-top:1px solid #292b25}.write-ledger span{width:5px;height:5px;border-radius:50%;background:#83aa72}.write-ledger code{overflow:hidden;color:#7a7d73;font:7px Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}.safety-note{display:flex;gap:13px;margin-top:25px;padding:16px;border-left:2px solid #d7af55;background:#191a15;color:#d7af55}.safety-note b{color:#d4d5cd;font-size:9px}.safety-note p{margin:6px 0 0;color:#74776d;font-size:8px;line-height:1.5}.wizard-footer{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;padding:0 24px;border-top:1px solid #30322c;background:#171815}.scan-state{display:flex;align-items:center;gap:8px;color:#777a70;font-size:8px}.wizard-footer>div:last-child{display:flex;gap:8px}.wizard-footer button{height:34px;border:1px solid #3a3c34;padding:0 14px;font-size:8px;cursor:pointer}.wizard-footer button:disabled{opacity:.38;cursor:default}.wizard-footer .secondary{background:transparent;color:#92958a}.wizard-footer .primary{min-width:132px;display:flex;align-items:center;justify-content:center;gap:8px;border-color:#d7af55;background:#d7af55;color:#17130a;font-weight:700}.spinning{animation:spin .9s linear infinite}.stage-enter-active,.stage-leave-active{transition:opacity .14s ease,transform .18s ease}.stage-enter-from{opacity:0;transform:translateX(10px)}.stage-leave-to{opacity:0;transform:translateX(-7px)}@keyframes veil-in{from{opacity:0}}@keyframes wizard-in{from{opacity:0;transform:translateY(10px) scale(.99)}}@keyframes spin{to{transform:rotate(360deg)}}
.rule-editors{display:grid;gap:18px}.rules-layout{grid-template-columns:minmax(300px,.9fr) 1.1fr}
</style>
