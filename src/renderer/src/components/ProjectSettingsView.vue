<template>
  <section class="settings-view">
    <header class="module-header">
      <div><span class="eyebrow">项目设置</span><h2>扫描范围与自动化边界</h2><p>配置只写入当前项目的 .aicanvas/project.json。</p></div>
      <button class="primary-button" type="button" data-testid="project-settings-save" :disabled="saving" :title="saving ? '正在处理，不能再保存并重扫' : undefined" @click="save"><Save :size="16" /> {{ saving ? "保存中" : "保存并重扫" }}</button>
    </header>

    <div class="settings-body">
      <section>
        <h3>基本信息</h3>
        <label><span>项目名称</span><input v-model="draft.name" /></label>
        <label><span>项目主根</span><input :value="draft.primaryRoot" disabled /></label>
      </section>

      <section>
        <h3>附加来源根</h3>
        <p>用于关联剧本、参考图和外部资产，不作为默认输出目录。</p>
        <div v-for="(_root, index) in draft.sourceRoots" :key="index" class="path-row">
          <input v-model="draft.sourceRoots[index]" placeholder="绝对路径" />
          <button type="button" :aria-label="`移除来源 ${index + 1}`" @click="draft.sourceRoots.splice(index, 1)"><X :size="15" /></button>
        </div>
        <button class="text-button" type="button" @click="draft.sourceRoots.push('')"><Plus :size="14" /> 添加来源根</button>
      </section>

      <section>
        <h3>允许输出根</h3>
        <p>Codex 只能登记这些目录内的新文件，项目主根始终保留。</p>
        <div v-for="(_root, index) in draft.outputRoots" :key="index" class="path-row">
          <input v-model="draft.outputRoots[index]" :disabled="index === 0" />
          <button v-if="index > 0" type="button" :aria-label="`移除输出 ${index + 1}`" @click="draft.outputRoots.splice(index, 1)"><X :size="15" /></button>
        </div>
        <button class="text-button" type="button" @click="draft.outputRoots.push('')"><Plus :size="14" /> 添加输出根</button>
      </section>

      <section>
        <h3>显式硬锁</h3>
        <p>项目内三视图会自动发现；这里用于登记外部权威参考和具体职责。</p>
        <div v-for="(lock, index) in draft.hardLocks" :key="lock.id" class="lock-editor">
          <input v-model="lock.name" placeholder="名称" />
          <input v-model="lock.path" placeholder="绝对路径" />
          <textarea v-model="lock.note" rows="2" placeholder="唯一职责与禁项"></textarea>
          <button type="button" @click="draft.hardLocks.splice(index, 1)"><Trash2 :size="14" /> 移除</button>
        </div>
        <button class="text-button" type="button" @click="addLock"><Plus :size="14" /> 添加硬锁</button>
      </section>

      <section>
        <h3>自动驾驶批次</h3>
        <div class="automation-grid">
          <label><span>图片单元/批</span><input v-model.number="draft.automation.imageBatchSize" type="number" min="1" max="20" /></label>
          <label><span>视频单元/批</span><input v-model.number="draft.automation.videoBatchSize" type="number" min="1" max="10" /></label>
          <label class="switch-line"><span>视觉验收后暂停</span><input v-model="draft.automation.pauseAfterVisualBatch" type="checkbox" /></label>
          <label class="switch-line locked"><span>禁止覆盖权威素材</span><input type="checkbox" checked disabled /></label>
        </div>
      </section>

      <section>
        <h3>构建身份</h3>
        <p>只读展示 release-manifest.json 的构建身份；源码预览与安装版应完全一致。</p>
        <div class="mcp-facts">
          <div><span>构建版本</span><b>{{ buildIdentity?.version ?? "—" }}</b></div>
          <div><span>运行入口</span><b>{{ runtimeEntryLabel }}</b></div>
          <div><span>MCP 工具数</span><b>{{ buildIdentity?.mcpToolCount ?? "—" }}</b></div>
        </div>
        <label><span>内容指纹</span><input :value="shortSourceDigest" :title="buildIdentity?.sourceDigest ?? ''" disabled /></label>
        <label><span>构建时间</span><input :value="buildIdentity?.builtAt ?? '—'" disabled /></label>
        <label><span>当前工程</span><input :value="buildIdentity?.projectRoot ?? '—'" disabled /></label>
      </section>

      <section class="mcp-section">
        <div class="mcp-heading"><div><h3>Codex 连接</h3><p>本地 stdio 通信，不开放网络端口；应用关闭后仍可扫描与接续。</p></div><span :class="{ ready: mcpInfo?.available }"><PlugZap :size="13" /> {{ mcpInfo?.available ? "服务就绪" : "等待构建" }}</span></div>
        <div class="mcp-facts">
          <div><span>传输</span><b>stdio</b></div><div><span>工具</span><b>{{ mcpInfo?.toolCount ?? "—" }}</b></div><div><span>形态</span><b>{{ mcpInfo?.packaged ? "安装版" : "开发版" }}</b></div>
        </div>
        <label><span>MCP 入口</span><input :value="mcpInfo?.serverPath ?? '正在检查…'" disabled /></label>
        <pre>{{ mcpInfo?.config ?? "正在生成 Codex 配置…" }}</pre>
        <div class="mcp-actions"><button type="button" :disabled="!mcpInfo" @click="copyConfig"><Copy :size="14" /> {{ copied ? "已复制" : "复制 Codex 配置" }}</button><button v-if="mcpInfo?.available" type="button" @click="revealMcp"><FolderOpen :size="14" /> 定位服务</button></div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { Copy, FolderOpen, PlugZap, Plus, Save, Trash2, X } from "lucide-vue-next";
import type { ProjectConfig } from "@core/types";

const props = defineProps<{ config: ProjectConfig }>();
const emit = defineEmits<{ saved: [config: ProjectConfig] }>();
const saving = ref(false);
const copied = ref(false);
const mcpInfo = ref<Awaited<ReturnType<typeof window.canvasApi.getMcpInfo>> | null>(null);
const buildIdentity = ref<Awaited<ReturnType<typeof window.canvasApi.getBuildIdentity>> | null>(null);
const draft = reactive<ProjectConfig>(cloneConfig(props.config));

function cloneConfig(value: ProjectConfig): ProjectConfig { return JSON.parse(JSON.stringify(value)) as ProjectConfig; }

const runtimeEntryLabel = computed(() => {
  if (!buildIdentity.value) return "—";
  return buildIdentity.value.runtimeMode === "packaged" ? "安装版" : "源码预览";
});
// 内容指纹只展示前 12 位，完整值经 title 悬停查看。
const shortSourceDigest = computed(() => {
  const digest = buildIdentity.value?.sourceDigest;
  return digest ? `${digest.slice(0, 12)}…` : "—";
});

watch(
  () => props.config,
  (config) => Object.assign(draft, cloneConfig(config)),
  { deep: true },
);
watch(() => props.config.primaryRoot, () => { void loadMcpInfo(); void loadBuildIdentity(); });
onMounted(() => { void loadMcpInfo(); void loadBuildIdentity(); });

async function loadMcpInfo() { mcpInfo.value = await window.canvasApi.getMcpInfo(props.config.primaryRoot); }
async function loadBuildIdentity() { buildIdentity.value = await window.canvasApi.getBuildIdentity(props.config.primaryRoot); }
async function copyConfig() { if (!mcpInfo.value) return; await window.canvasApi.copyText(mcpInfo.value.config); copied.value = true; setTimeout(() => copied.value = false, 1_600); }
function revealMcp() { if (mcpInfo.value) void window.canvasApi.showInFolder(mcpInfo.value.serverPath); }

function addLock() {
  draft.hardLocks.push({ id: `manual-${crypto.randomUUID().slice(0, 8)}`, name: "", path: "", note: "" });
}

async function save() {
  if (saving.value) return;
  saving.value = true;
  try {
    draft.sourceRoots = draft.sourceRoots.map((root) => root.trim()).filter(Boolean);
    draft.outputRoots = draft.outputRoots.map((root) => root.trim()).filter(Boolean);
    draft.hardLocks = draft.hardLocks.filter((lock) => lock.name.trim() && lock.path.trim());
    const index = await window.canvasApi.saveProjectConfig(cloneConfig(draft));
    emit("saved", index.project);
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.settings-view { height: 100%; overflow-y: auto; background: #121310; }
.module-header { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; justify-content: space-between; padding: 22px 30px; border-bottom: 1px solid #30322c; background: rgba(18,19,16,.95); backdrop-filter: blur(12px); }
.module-header h2 { margin: 7px 0 4px; font-size: 20px; }
.module-header p, section > p { margin: 0; color: #83867b; font-size: 10px; }
.settings-body { width: min(880px, calc(100% - 60px)); margin: 0 auto; padding: 16px 0 70px; }
.settings-body > section { padding: 24px 0; border-bottom: 1px solid #2c2e28; }
h3 { margin: 0 0 15px; font-size: 13px; }
label { display: grid; grid-template-columns: 150px 1fr; align-items: center; gap: 16px; margin-top: 10px; color: #a9aba1; font-size: 10px; }
input, textarea { width: 100%; border: 1px solid #35372f; background: #1b1c18; color: #ecece5; padding: 9px 10px; outline: none; }
input:focus, textarea:focus { border-color: #6b5b31; }
input:disabled { color: #70736a; background: #171814; }
.path-row { display: flex; gap: 8px; margin-top: 9px; }
.path-row button, .lock-editor button { border: 1px solid #34362f; background: transparent; color: #898c81; cursor: pointer; }
.path-row button { width: 36px; }
.text-button { display: inline-flex; align-items: center; gap: 6px; margin-top: 11px; border: 0; background: transparent; color: #d7af55; font-size: 10px; cursor: pointer; }
.lock-editor { display: grid; grid-template-columns: 180px 1fr 90px; gap: 8px; margin-top: 12px; padding: 12px; border: 1px solid #30322c; background: #171815; }
.lock-editor textarea { grid-column: 1 / 3; }
.lock-editor button { grid-row: 1 / 3; grid-column: 3; display: flex; align-items: center; justify-content: center; gap: 5px; }
.automation-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 22px; }
.automation-grid label { grid-template-columns: 1fr 90px; }
.switch-line input { width: auto; justify-self: end; accent-color: #d7af55; }
.switch-line.locked { color: #777a70; }
.mcp-heading { display: flex; align-items: start; justify-content: space-between; gap: 20px; }.mcp-heading h3 { margin-bottom: 6px; }.mcp-heading > span { display: flex; align-items: center; gap: 6px; color: #b15f50; font-size: 9px; }.mcp-heading > span.ready { color: #83aa72; }.mcp-facts { display: grid; grid-template-columns: repeat(3,1fr); gap: 1px; margin-top: 15px; background: #30322c; }.mcp-facts div { padding: 11px; background: #171815; }.mcp-facts span,.mcp-facts b { display: block; }.mcp-facts span { color: #686b62; font-size: 8px; }.mcp-facts b { margin-top: 5px; font: 10px Menlo,monospace; }.mcp-section pre { max-height: 220px; overflow: auto; margin: 14px 0 0; padding: 14px; border: 1px solid #30322c; background: #0f100e; color: #9c9e95; font: 9px/1.65 Menlo,monospace; white-space: pre-wrap; word-break: break-all; }.mcp-actions { display: flex; gap: 8px; margin-top: 10px; }.mcp-actions button { height: 31px; display: flex; align-items: center; gap: 7px; padding: 0 10px; border: 1px solid #3a3c34; background: transparent; color: #d7af55; font-size: 9px; cursor: pointer; }.mcp-actions button:disabled { opacity: .4; }
</style>
