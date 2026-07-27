<template>
  <section class="script-workbench">
    <aside class="document-rail">
      <header><span class="eyebrow">分集与剧本</span><h2>制作文档</h2><button type="button" title="新建单元" @click="creating = !creating"><Plus :size="16" /></button></header>
      <div v-if="creating" class="create-document">
        <div><input v-model.number="newDocument.episode" type="number" min="1" placeholder="集" /><input v-model.number="newDocument.unit" type="number" min="1" placeholder="15s" /></div>
        <input v-model="newDocument.title" placeholder="单元标题" />
        <button class="primary-button" type="button" @click="createDocument">创建 Markdown</button>
      </div>
      <label class="rail-search"><Search :size="14" /><input v-model="search" placeholder="搜索标题或正文摘要" /></label>
      <select v-model="episode"><option value="all">全部分集</option><option v-for="value in episodes" :key="value" :value="String(value)">EP{{ pad(value) }}</option></select>
      <div class="document-kind-tabs">
        <button v-for="entry in documentKinds" :key="entry.id" type="button" :class="{ active: documentKind === entry.id }" @click="documentKind = entry.id">{{ entry.label }}</button>
      </div>
      <div class="document-list">
        <button v-for="document in filteredDocuments" :key="document.path" type="button" :class="{ active: activePath === document.path }" @click="openDocument(document)">
          <span>EP{{ pad(document.episode) }} · {{ document.itemType === 'shot' ? `镜${document.shot}` : `15s ${pad(document.unit, 3)}` }}</span>
          <b>{{ document.title }}</b>
          <small>{{ formatSize(document.size) }} · {{ formatTime(document.modifiedAt) }}</small>
        </button>
      </div>
      <footer>{{ filteredDocuments.length }} / {{ documents.length }} 份文档</footer>
    </aside>

    <section class="editor-stage">
      <template v-if="activeDocument">
        <header class="editor-header">
          <div><span class="eyebrow">{{ activeDocument.kind === 'info' ? '00_信息.md' : '提示词文档' }}</span><h2>{{ activeDocument.title }}</h2><p>{{ activeDocument.path }}</p></div>
          <div class="editor-actions">
            <span v-if="dirty" class="dirty-mark">未保存</span>
            <button class="ghost-button" type="button" @click="reveal"><FolderOpen :size="15" /> 文件</button>
            <button class="ghost-button" type="button" :disabled="loading" @click="reload"><RotateCcw :size="15" /> 重载</button>
            <button class="primary-button" type="button" :disabled="saving || !dirty" @click="save"><Save :size="15" /> {{ saving ? "保存中" : "保存版本" }}</button>
          </div>
        </header>
        <div class="editor-meta"><span>{{ content.length.toLocaleString() }} 字符</span><span>保存前自动备份旧版本</span><span v-if="lastHistory">历史：{{ lastHistory }}</span></div>
        <textarea v-model="content" spellcheck="false" aria-label="剧本文档编辑器"></textarea>
      </template>
      <div v-else class="editor-empty"><FilePenLine :size="30" /><span>选择一份制作文档</span><small>编辑会保留旧版本，并使用修改时间防止覆盖外部更新。</small></div>
    </section>

    <aside class="script-context">
      <template v-if="activeDocument">
        <section><div class="context-title"><span>生产节点</span><b>{{ activeItem?.status ?? "未映射" }}</b></div><p>{{ activeItem?.nextAction ?? "重新扫描后映射节点" }}</p><button type="button" @click="$emit('selectItem', activeDocument.itemId)">在检查器中打开</button></section>
        <section><div class="context-title"><span>关联硬锁</span><b>{{ relatedLocks.length }}</b></div><ul><li v-for="lock in relatedLocks" :key="lock.id"><LockKeyhole :size="13" /><div><b>{{ lock.name }}</b><small>{{ lock.note }}</small></div></li></ul></section>
        <section><div class="context-title"><span>文件状态</span><b>{{ dirty ? "有改动" : "已同步" }}</b></div><dl><dt>修改时间</dt><dd>{{ formatTime(modifiedAt) }}</dd><dt>源路径</dt><dd>{{ activeDocument.path }}</dd></dl></section>
      </template>
    </aside>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { FilePenLine, FolderOpen, LockKeyhole, Plus, RotateCcw, Save, Search } from "lucide-vue-next";
import type { ProjectIndex, ScriptDocument } from "@core/types";

const props = defineProps<{ projectRoot: string; index: ProjectIndex }>();
const emit = defineEmits<{ changed: [message: string]; failed: [message: string]; selectItem: [itemId: string] }>();
const documents = ref<ScriptDocument[]>([]);
const activePath = ref("");
const content = ref("");
const originalContent = ref("");
const modifiedAt = ref("");
const lastHistory = ref("");
const search = ref("");
const episode = ref("all");
const documentKind = ref<"all" | "unit" | "shot">("all");
const documentKinds = [{ id: "all" as const, label: "全部" }, { id: "unit" as const, label: "15 秒单元" }, { id: "shot" as const, label: "原镜头" }];
const loading = ref(false);
const saving = ref(false);
const creating = ref(false);
const newDocument = reactive({ episode: 1, unit: 1, title: "" });

const episodes = computed(() => [...new Set(documents.value.map((document) => document.episode).filter((value): value is number => Boolean(value)))].sort((a, b) => a - b));
const filteredDocuments = computed(() => { const needle = search.value.trim().toLowerCase(); return documents.value.filter((document) => (episode.value === "all" || document.episode === Number(episode.value)) && (documentKind.value === "all" || document.itemType === documentKind.value) && (!needle || `${document.title} ${document.excerpt} ${document.path}`.toLowerCase().includes(needle))); });
const activeDocument = computed(() => documents.value.find((document) => document.path === activePath.value) ?? null);
const activeItem = computed(() => props.index.items.find((item) => item.id === activeDocument.value?.itemId));
const relatedLocks = computed(() => props.index.project.hardLocks.filter((lock) => activeDocument.value?.relatedAssetIds.includes(lock.id)));
const dirty = computed(() => content.value !== originalContent.value);

onMounted(loadDocuments);
watch(() => props.projectRoot, async () => { activePath.value = ""; await loadDocuments(); });

async function loadDocuments() {
  documents.value = await window.canvasApi.listScriptDocuments(props.projectRoot);
  if (!activePath.value && documents.value[0]) await openDocument(documents.value[0]);
}
async function openDocument(document: ScriptDocument) { if (dirty.value && !window.confirm("当前文档有未保存改动，确认放弃并打开其他文档？")) return; activePath.value = document.path; await reload(); }
async function reload() { if (!activePath.value) return; loading.value = true; try { const result = await window.canvasApi.readScriptDocument(props.projectRoot, activePath.value); content.value = result.content; originalContent.value = result.content; modifiedAt.value = result.modifiedAt; lastHistory.value = ""; } catch (error) { emit("failed", message(error)); } finally { loading.value = false; } }
async function save() { if (!activeDocument.value) return; saving.value = true; try { const result = await window.canvasApi.saveScriptDocument(props.projectRoot, activeDocument.value.path, content.value, modifiedAt.value); originalContent.value = content.value; modifiedAt.value = result.modifiedAt; lastHistory.value = result.historyPath; await loadDocuments(); emit("changed", "制作文档已保存，旧版本已归档"); } catch (error) { emit("failed", message(error)); } finally { saving.value = false; } }
async function createDocument() { try { const result = await window.canvasApi.createScriptDocument(props.projectRoot, { ...newDocument }); creating.value = false; newDocument.title = ""; await loadDocuments(); const document = documents.value.find((candidate) => candidate.path === result.path); if (document) await openDocument(document); emit("changed", "新制作单元已经创建并进入真实扫描索引"); } catch (error) { emit("failed", message(error)); } }
function reveal() { if (activeDocument.value) void window.canvasApi.showInFolder(activeDocument.value.path); }
function pad(value?: number, length = 2) { return String(value ?? 0).padStart(length, "0"); }
function formatTime(value: string) { return value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"; }
function formatSize(value: number) { return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`; }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
</script>

<style scoped>
.document-kind-tabs { display: grid; grid-template-columns: repeat(3,1fr); margin: 0 16px 8px; border: 1px solid #34362f; }
.document-kind-tabs button { height: 27px; border: 0; border-right: 1px solid #34362f; background: #191a17; color: #70736a; font-size: 8px; cursor: pointer; }
.document-kind-tabs button:last-child { border-right: 0; }
.document-kind-tabs button.active { background: #29271f; color: #d7af55; }
.script-workbench { height: 100%; display: grid; grid-template-columns: 292px minmax(0,1fr) 318px; background: #121310; }.document-rail { min-width: 0; display: flex; flex-direction: column; border-right: 1px solid #30322c; background: #151613; }.document-rail > header { height: 76px; display: grid; grid-template-columns: 1fr auto; align-content: center; padding: 0 16px; border-bottom: 1px solid #30322c; }.document-rail h2 { grid-column: 1; margin: 7px 0 0; font-size: 16px; }.document-rail header button { grid-column: 2; grid-row: 1/3; align-self: center; width: 30px; height: 30px; border: 1px solid #373930; background: transparent; color: #d7af55; cursor: pointer; }.create-document { padding: 12px 16px; border-bottom: 1px solid #30322c; background: #1a1b17; }.create-document > div { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }.create-document input { width: 100%; height: 31px; margin-bottom: 7px; border: 1px solid #35372f; background: #141512; color: #eee; padding: 0 8px; }.create-document button { width: 100%; }.rail-search { height: 34px; margin: 12px 16px 7px; display: flex; align-items: center; gap: 7px; padding: 0 8px; border: 1px solid #34362f; background: #1b1c18; color: #777a70; }.rail-search input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: #eee; font-size: 10px; }.document-rail > select { height: 32px; margin: 0 16px 8px; border: 1px solid #34362f; background: #1b1c18; color: #bbb; padding: 0 8px; }.document-list { flex: 1; overflow: auto; }.document-list button { width: 100%; min-width: 0; padding: 11px 16px; border: 0; border-bottom: 1px solid #292b25; background: transparent; color: #aaa; text-align: left; cursor: pointer; }.document-list button:hover,.document-list button.active { background: #1e1f1b; }.document-list button.active { box-shadow: inset 2px 0 #d7af55; }.document-list span,.document-list b,.document-list small { display: block; }.document-list span { color: #d7af55; font-size: 8px; }.document-list b { margin-top: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 10px; }.document-list small { margin-top: 5px; color: #62655c; font-size: 8px; }.document-rail > footer { height: 36px; display: flex; align-items: center; padding: 0 16px; border-top: 1px solid #30322c; color: #65685f; font-size: 8px; }.editor-stage { min-width: 0; display: flex; flex-direction: column; }.editor-header { min-height: 76px; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 0 20px; border-bottom: 1px solid #30322c; }.editor-header > div:first-child { min-width: 0; }.editor-header h2 { margin: 6px 0 3px; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }.editor-header p { margin: 0; color: #62655c; font-size: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }.editor-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 7px; }.dirty-mark { color: #d7af55; font-size: 8px; }.editor-meta { height: 32px; display: flex; align-items: center; gap: 18px; padding: 0 20px; border-bottom: 1px solid #292b25; color: #676a61; font-size: 8px; }.editor-stage textarea { flex: 1; width: 100%; resize: none; border: 0; outline: 0; padding: 24px min(6vw,70px) 80px; background: #121310; color: #c8cabf; font: 12px/1.9 "SFMono-Regular",Menlo,"PingFang SC",monospace; caret-color: #d7af55; }.editor-empty { height: 100%; display: grid; place-content: center; justify-items: center; gap: 10px; color: #64675e; }.editor-empty span { color: #a7a99f; font-size: 11px; }.editor-empty small { max-width: 280px; text-align: center; font-size: 8px; line-height: 1.6; }.script-context { overflow: auto; border-left: 1px solid #30322c; background: #171815; }.script-context section { padding: 17px 18px; border-bottom: 1px solid #30322c; }.context-title { display: flex; justify-content: space-between; color: #8c8f84; font-size: 9px; }.context-title b { color: #b7b9af; }.script-context p { margin: 12px 0; color: #bfc1b7; font-size: 10px; line-height: 1.6; }.script-context section > button { width: 100%; height: 30px; border: 1px solid #373930; background: transparent; color: #d7af55; font-size: 9px; cursor: pointer; }.script-context ul { margin: 10px 0 0; padding: 0; list-style: none; }.script-context li { display: flex; gap: 8px; padding: 8px 0; color: #d7af55; }.script-context li b,.script-context li small { display: block; }.script-context li b { color: #bbbdb4; font-size: 9px; }.script-context li small { margin-top: 3px; color: #686b62; font-size: 8px; line-height: 1.4; }.script-context dl { display: grid; grid-template-columns: 62px 1fr; gap: 8px; margin: 12px 0 0; font-size: 8px; }.script-context dt { color: #686b62; }.script-context dd { margin: 0; min-width: 0; color: #9c9e95; word-break: break-all; }
</style>
