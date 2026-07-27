<template>
  <main class="app-shell">
    <section
      v-if="rootRuntimeGateState !== 'allowed'"
      class="root-runtime-gate"
      role="alert"
      aria-live="assertive"
      data-testid="root-runtime-write-gate">
      <div>
        <ShieldCheck :size="28" aria-hidden="true" />
        <span class="eyebrow">源码运行时保护</span>
        <h2>{{ rootRuntimeGateState === "checking" ? "正在核对运行工件" : "无限画布已停止业务访问" }}</h2>
        <p>{{ rootRuntimeGateMessage }}</p>
        <small v-if="rootRuntimeGateReasons.length">原因：{{ rootRuntimeGateReasons.join("、") }}</small>
      </div>
    </section>
    <header v-if="!managedShell" class="topbar">
      <div class="brand-block">
        <span class="brand-mark">AI</span>
        <div>
          <h1>漫剧画布</h1>
          <p>{{ index?.project.name ?? "尚未导入项目" }}</p>
        </div>
      </div>

      <div v-if="index" class="topbar-metrics">
        <div><span>15 秒单元</span><strong>{{ index.summary.total }}</strong></div>
        <div><span>待续做</span><strong>{{ index.summary.active }}</strong></div>
        <div><span>首尾帧</span><strong>{{ index.summary.rawImages }} / {{ index.summary.labeledImages }}</strong></div>
        <div><span>视频</span><strong>{{ index.summary.videos }}</strong></div>
      </div>

      <div class="topbar-actions">
        <span v-if="index" class="scan-time">{{ scanTime }}</span>
        <button class="ghost-button" type="button" :disabled="projectOperationBusy" @click="openProjectCenter"><FolderKanban :size="16" /> {{ projectSwitching ? "切换中" : "项目" }}</button>
        <button v-if="projectRoot" class="primary-button" type="button" :disabled="projectOperationBusy || (loading && !scanInProgress)" @click="scanInProgress ? cancelScanNow() : scanNow()">
          <X v-if="scanInProgress" :size="16" />
          <RefreshCw v-else :size="16" :class="{ spinning: loading }" /> {{ scanInProgress ? (scanCancelling ? "取消中" : "取消扫描") : (loading ? "读取中" : "扫描") }}
        </button>
      </div>
    </header>

    <nav v-if="projectRoot && !managedShell" class="module-nav">
      <button v-for="entry in moduleEntries" :key="entry.id" type="button" :class="{ active: activeView === entry.id }" @click="activeView = entry.id">
        <component :is="entry.icon" :size="14" /><span>{{ entry.label }}</span>
      </button>
    </nav>

    <MaterialStudioView
      v-if="managedShell && projectRoot"
      :project-root="projectRoot"
      :project-name="managedShell.project.name"
      :api="materialStudioApi"
      :binding-api="studioBindingApi"
      :continuity-review-api="studioContinuityReviewApi"
      :dashboard-api="studioDashboardApi"
      :script-align-api="studioScriptAlignApi"
      :multimedia-timeline-api="studioMultimediaTimelineApi"
      :external-mode-request="studioModeRequest"
      @studio-context-changed="persistStudioContext"
      @project-restored="openRestoredProject"
      @binding-changed="showMessage"
      @failed="showMessage($event, true)" />

    <section v-else-if="!projectRoot" class="import-screen first-run-screen" data-testid="first-run-screen" @dragover.prevent @drop.prevent="onProjectDrop">
      <div class="import-symbol"><FolderKanban :size="30" /></div>
      <span class="eyebrow">AI 漫剧画布</span>
      <h2>从一个剧开始</h2>
      <p>新建工程只需名称；角色、场景、道具、剧本和生成结果都会收在同一个受管工程。</p>
      <div class="first-run-actions">
        <button class="first-run-card primary" type="button" data-testid="first-run-create" :disabled="projectOperationBusy" @click="openProjectCenter"><FolderPlus :size="22" /><b>新建短剧工程</b><span>只填工程名称</span></button>
        <button class="first-run-card" type="button" data-testid="first-run-recent" :disabled="projectOperationBusy || !projects.some(project => project.available)" @click="openMostRecentProject"><Clock3 :size="22" /><b>{{ projectSwitching ? "正在打开工程" : "打开最近工程" }}</b><span>继续上次位置</span></button>
        <button class="first-run-card" type="button" data-testid="first-run-import" :disabled="projectOperationBusy" @click="importProject"><FolderKanban :size="22" /><b>导入已有工程</b><span>先预检，再接入</span></button>
      </div>
      <small class="first-run-safety">默认保存到 {{ defaultManagedParentRoot || "文稿/AI漫剧项目" }}；不会扫描其他工程。</small>
    </section>

    <section v-else-if="activeView === 'canvas'" class="workspace with-module-nav">
      <aside class="sidebar">
        <div class="sidebar-section">
          <label class="search-box">
            <Search :size="16" />
            <input v-model="search" placeholder="镜头、提示词或路径" />
          </label>
        </div>

        <div class="sidebar-section">
          <div class="sidebar-heading"><span>分集</span><small>{{ episodes.length }}</small></div>
          <select v-model="episodeFilter" class="episode-select">
            <option value="all">全部分集</option>
            <option v-for="episode in episodes" :key="episode" :value="String(episode)">EP{{ String(episode).padStart(2, "0") }}</option>
          </select>
          <label class="toggle-row">
            <span>显示原镜头</span>
            <input v-model="showShots" type="checkbox" />
          </label>
          <label class="toggle-row">
            <span>显示资产节点</span>
            <input v-model="showAssets" type="checkbox" />
          </label>
          <label class="toggle-row">
            <span>显示小说叙事链</span>
            <input v-model="showNarrative" type="checkbox" />
          </label>
        </div>

        <div class="sidebar-section status-filter">
          <div class="sidebar-heading"><span>生产状态</span><button type="button" @click="statusFilter = 'all'">清除</button></div>
          <button
            v-for="entry in statusEntries"
            :key="entry.status"
            type="button"
            :class="[{ active: statusFilter === entry.status }, statusClass(entry.status)]"
            @click="statusFilter = entry.status">
            <span><i></i>{{ entry.status }}</span><strong>{{ entry.count }}</strong>
          </button>
        </div>

        <div class="sidebar-footer">
          <span class="live-dot"></span>
          <div><b>文件监听已开启</b><small>{{ projectRoot }}</small></div>
        </div>
      </aside>

      <section ref="canvasWrap" class="canvas-wrap" :class="{ 'semantic-compact': zoom < 0.35 }">
        <div class="canvas-toolbox">
          <button type="button" title="添加导演批注" @click="createCanvasEntity('note')"><StickyNote :size="14" /><span>批注</span></button>
          <button type="button" title="添加自定义分组" @click="createCanvasEntity('group')"><Frame :size="14" /><span>分组</span></button>
          <button type="button" title="撤销（⌘Z）" :disabled="!canvasHistory.canUndo" @click="undoCanvas"><Undo2 :size="14" /></button>
          <button type="button" title="重做（⌘⇧Z）" :disabled="!canvasHistory.canRedo" @click="redoCanvas"><Redo2 :size="14" /></button>
          <select v-if="linkMode" v-model="linkKind" title="关系类型"><option value="continuity">连续性</option><option value="reference">参考</option><option value="dependency">依赖</option><option value="comment">说明</option></select>
          <button type="button" :class="{ active: linkMode }" title="依次点击两个节点建立关系" @click="toggleLinkMode"><Link2 :size="14" /><span>{{ linkSourceId ? '选择目标' : '连线' }}</span></button>
        </div>
        <div v-if="linkMode" class="link-mode-hint"><MousePointer2 :size="13" /> {{ linkSourceId ? `起点 ${linkSourceId}，请选择目标节点` : '请选择关系线起点' }}</div>
        <div v-if="loading && !index" class="loading-screen"><span></span><p>正在读取真实制作进度…</p></div>
        <VueFlow
          v-else
          id="production-flow"
          v-model:nodes="nodes"
          v-model:edges="edges"
          :node-types="nodeTypes"
          :min-zoom="0.12"
          :max-zoom="1.8"
          :default-viewport="{ x: 40, y: 30, zoom: 0.62 }"
          :only-render-visible-elements="true"
          :nodes-connectable="false"
          :edges-updatable="false"
          :select-nodes-on-drag="false"
          :fit-view-on-init="false"
          @node-click="onNodeClick"
          @edge-click="onEdgeClick"
          @node-drag-stop="onNodeDragStop"
          @move="onMove">
          <Background pattern-color="#292b27" :gap="24" :size="1" />
          <Controls position="bottom-left" />
        </VueFlow>
        <div class="canvas-caption">
          <span>{{ canvasNodeCount }} 个可见节点</span>
          <span>缩放 {{ Math.round(zoom * 100) }}%</span>
        </div>
      </section>

      <InspectorPanel
        :item="selectedItem"
        :artifacts="selectedArtifacts"
        :hard-locks="index?.project.hardLocks ?? []"
        :project-root="projectRoot"
        @close="selectedId = null"
        @updated="scanNow" />
    </section>

    <section v-else class="module-shell">
      <div v-if="['shots', 'videos'].includes(activeView)" class="module-split">
        <ProductionWorkspace
          :index="index!"
          :mode="activeView as 'shots' | 'videos'"
          :project-root="projectRoot"
          @select="selectedId = $event"
          @task-created="onTaskCreated"
          @updated="onWorkspaceUpdated"
          @failed="showMessage($event, true)" />
        <InspectorPanel
          :item="selectedItem"
          :artifacts="selectedArtifacts"
          :hard-locks="index?.project.hardLocks ?? []"
          :project-root="projectRoot"
          @close="selectedId = null"
          @updated="scanNow" />
      </div>
      <CanonicalAssetLibraryView
        v-else-if="activeView === 'assets'"
        :project-root="projectRoot"
        @failed="showMessage($event, true)" />
      <TaskCenterView v-else-if="activeView === 'tasks'" :project-root="projectRoot" @changed="showMessage" @failed="showMessage($event, true)" />
      <ShotTimelineView
        v-else-if="activeView === 'timeline' && index"
        :project-root="projectRoot"
        :index="index"
        @task-created="onTaskCreated"
        @queued="onShotsQueued"
        @changed="showMessage"
        @failed="showMessage($event, true)" />
      <ContinuityTimelineView
        v-else-if="activeView === 'continuityTracks' && index"
        :project-root="projectRoot"
        :index="index"
        @open-unit="openContinuityUnit"
        @failed="showMessage($event, true)" />
      <PanelReferenceWorkbench
        v-else-if="activeView === 'panelReferences'"
        :project-root="projectRoot"
        @failed="showMessage($event, true)" />
      <VideoEditorView
        v-else-if="activeView === 'editor' && index"
        :project-root="projectRoot"
        :index="index"
        @changed="showMessage"
        @failed="showMessage($event, true)" />
      <ReviewStudioView
        v-else-if="activeView === 'review' && index"
        :project-root="projectRoot"
        :index="index"
        @updated="onReviewUpdated"
        @failed="showMessage($event, true)" />
      <ContinuationWorkbenchView
        v-else-if="activeView === 'continuation'"
        :project-root="projectRoot"
        @changed="showMessage"
        @failed="showMessage($event, true)" />
      <StoryWorkbenchView
        v-else-if="activeView === 'story' && index"
        :project-root="projectRoot"
        :index="index"
        @changed="showMessage"
        @failed="showMessage($event, true)" />
      <NarrativeAdaptationView
        v-else-if="activeView === 'adaptation' && index"
        :project-root="projectRoot"
        :index="index"
        @changed="onWorkspaceUpdated"
        @failed="showMessage($event, true)"
        @open-design="activeView = 'design'" />
      <ProductionDesignView
        v-else-if="activeView === 'design' && index"
        :project-root="projectRoot"
        :index="index"
        @changed="onWorkspaceUpdated"
        @failed="showMessage($event, true)" />
      <ScriptWorkbenchView
        v-else-if="activeView === 'scripts' && index"
        :project-root="projectRoot"
        :index="index"
        @changed="onDocumentChanged"
        @failed="showMessage($event, true)"
        @select-item="openItemInList" />
      <GenerationQueueView
        v-else-if="activeView === 'generation' && index"
        :project-root="projectRoot"
        :index="index"
        @changed="showMessage"
        @failed="showMessage($event, true)"
        @jump="onGenerationQueueJump" />
      <ProjectSettingsView v-else-if="activeView === 'settings' && index" :config="index.project" @saved="onConfigSaved" />
    </section>

    <div
      v-if="externalManagedProjectBusy"
      class="managed-project-operation-shield"
      role="status"
      aria-live="assertive"
      data-testid="managed-project-operation-shield">
      <div>
        <RefreshCw :size="20" class="spinning" aria-hidden="true" />
        <strong>{{ managedProjectOperation?.kind === "restore" ? "正在安全恢复工程" : "正在建立一致备份" }}</strong>
        <span>{{ managedProjectOperation?.stage }}</span>
        <small>{{ managedProjectOperation?.targetPath }}</small>
      </div>
    </div>

    <ProjectCenter
      v-if="showProjectCenter"
      :projects="projects"
      :current-root="projectRoot"
      :creating="creatingManagedProject"
      :switching="projectSwitching"
      :removing-root="projectRemovingRoot"
      :refreshing="projectsRefreshing"
      :default-parent-root="defaultManagedParentRoot"
      @close="closeProjectCenter"
      @open="openProject"
      @import="importProject"
      @create-managed="createNewManagedProject"
      @choose-parent="chooseManagedParentRoot"
      @refresh="refreshProjects"
      @verify-source="verifyProjectSource"
      @remove="removeProject" />

    <ProjectImportWizard
      v-if="showImportWizard && importRoot"
      :initial-root="importRoot"
      @cancel="closeImportWizard"
      @imported="onProjectImported" />

    <div v-if="canvasEditor" class="canvas-editor-overlay" @click.self="canvasEditor = null">
      <section class="canvas-editor-dialog">
        <header><div><span class="eyebrow">{{ canvasEditor.kind === 'note' ? '导演批注' : '自定义分组' }}</span><h2>{{ canvasEditor.id ? '编辑画布实体' : '新建画布实体' }}</h2></div><button class="icon-button" type="button" @click="canvasEditor = null"><X :size="16" /></button></header>
        <div class="canvas-editor-form">
          <label><span>标题</span><input v-model="canvasEditor.title" maxlength="120" /></label>
          <label><span>正文 / 说明</span><textarea v-model="canvasEditor.body" rows="6" maxlength="20000"></textarea></label>
          <div class="canvas-editor-grid"><label><span>颜色</span><select v-model="canvasEditor.color"><option value="gold">金色</option><option value="blue">蓝色</option><option value="green">绿色</option><option value="red">红色</option><option value="purple">紫色</option><option value="gray">灰色</option></select></label><label><span>宽度</span><input v-model.number="canvasEditor.width" type="number" min="220" max="2400" /></label><label><span>高度</span><input v-model.number="canvasEditor.height" type="number" min="120" max="1800" /></label></div>
          <label v-if="canvasEditor.kind === 'group'"><span>显式成员节点 ID</span><textarea v-model="canvasEditor.memberText" rows="4" placeholder="每行一个节点 ID；也可仅作为视觉分组框"></textarea></label>
        </div>
        <footer><button class="ghost-button" type="button" @click="canvasEditor = null">取消</button><button class="primary-button" type="button" :disabled="savingCanvasEntity || !canvasEditor.title.trim()" @click="saveCanvasEntity"><Save :size="14" /> {{ savingCanvasEntity ? '保存中' : '保存到侧车' }}</button></footer>
      </section>
    </div>

    <transition name="toast">
      <div v-if="message" class="toast-message" :class="{ error: messageIsError }" :role="messageIsError ? 'alert' : 'status'" aria-live="polite">{{ message }}</div>
    </transition>
  </main>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, markRaw, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { Background } from "@vue-flow/background";
import { Controls } from "@vue-flow/controls";
import { VueFlow, useVueFlow, type Edge, type Node, type NodeDragEvent } from "@vue-flow/core";
import { BookOpenCheck, BookOpenText, Boxes, BrainCircuit, Clapperboard, Clock3, FolderKanban, FolderPlus, Frame, GitBranch, LayoutDashboard, LibraryBig, Link2, ListVideo, MousePointer2, Redo2, RefreshCw, Rows3, Save, ScanEye, Scissors, Search, Settings2, ShieldCheck, Sparkles, SquareKanban, StickyNote, Undo2, Workflow, X } from "lucide-vue-next";
import type { AdaptationStore, Artifact, CanvasEntity, CanvasEntityColor, CanvasEntityKind, CanvasHistoryInfo, CanvasLinkKind, CanvasPosition, CanvasSemanticState, ProjectIndex, WorkItem, WorkItemStatus } from "@core/types";
import ProductionNode from "./components/ProductionNode.vue";
import ZoneNode from "./components/ZoneNode.vue";
import InspectorPanel from "./components/InspectorPanel.vue";
import CanvasNoteNode from "./components/CanvasNoteNode.vue";
import CanvasGroupNode from "./components/CanvasGroupNode.vue";
import NarrativeNode from "./components/NarrativeNode.vue";
import type { MaterialStudioUiApi, MaterialStudioUiDetail, MaterialStudioUiEntry } from "./components/MaterialStudioView.vue";
import type { StudioBindingMutationResult, StudioBindingWorkbenchApi } from "./studio-binding-pagination";
import type { StudioContinuityReviewUiApi } from "./studio-continuity-review-store";
import {
  createStudioDashboardRequestCoalescer,
  type StudioProductionDashboardUiApi,
} from "./studio-production-dashboard-store";
import { createStudioCommandEnvelope } from "./studio-command-envelope";
import { createProjectListRefreshController } from "./project-list-refresh-controller";
import {
  createLegacyProjectEpochGate,
  isCurrentLegacyWatcherEvent,
  type LegacyProjectEpochToken,
} from "./legacy-project-epoch-gate";
import { createProjectScopedActionGate, type ProjectScopedActionToken } from "./project-scoped-action-gate";
import { statusClass } from "./utils";
import type { ProjectShell } from "@core/managed-project";
import type { ListedProjectSummary } from "@core/service";

// 首屏只需要画布与节点组件；其余模块视图按需异步加载，避免全部打进主 chunk（沿用 MaterialStudioView 内部先例）。
const MaterialStudioView = defineAsyncComponent(async () => {
  // 受管工程默认直达无限画布。素材中心壳与 400KB 级画布 chunk 并行加载，
  // 避免壳先完成后才串行触发第二次动态导入；浏览器模块缓存会被子组件复用。
  const [materialStudio] = await Promise.all([
    import("./components/MaterialStudioView.vue"),
    import("./components/ManagedStudioCanvasView.vue"),
  ]);
  return materialStudio;
});
const ProductionWorkspace = defineAsyncComponent(() => import("./components/ProductionWorkspace.vue"));
const CanonicalAssetLibraryView = defineAsyncComponent(() => import("./components/CanonicalAssetLibraryView.vue"));
const ProjectCenter = defineAsyncComponent(() => import("./components/ProjectCenter.vue"));
const ProjectSettingsView = defineAsyncComponent(() => import("./components/ProjectSettingsView.vue"));
const TaskCenterView = defineAsyncComponent(() => import("./components/TaskCenterView.vue"));
const ScriptWorkbenchView = defineAsyncComponent(() => import("./components/ScriptWorkbenchView.vue"));
const GenerationQueueView = defineAsyncComponent(() => import("./components/GenerationQueueView.vue"));
const ShotTimelineView = defineAsyncComponent(() => import("./components/ShotTimelineView.vue"));
const ContinuityTimelineView = defineAsyncComponent(() => import("./components/ContinuityTimelineView.vue"));
const PanelReferenceWorkbench = defineAsyncComponent(() => import("./components/PanelReferenceWorkbench.vue"));
const ReviewStudioView = defineAsyncComponent(() => import("./components/ReviewStudioView.vue"));
const ProjectImportWizard = defineAsyncComponent(() => import("./components/ProjectImportWizard.vue"));
const ContinuationWorkbenchView = defineAsyncComponent(() => import("./components/ContinuationWorkbenchView.vue"));
const StoryWorkbenchView = defineAsyncComponent(() => import("./components/StoryWorkbenchView.vue"));
const VideoEditorView = defineAsyncComponent(() => import("./components/VideoEditorView.vue"));
const ProductionDesignView = defineAsyncComponent(() => import("./components/ProductionDesignView.vue"));
const NarrativeAdaptationView = defineAsyncComponent(() => import("./components/NarrativeAdaptationView.vue"));

const STAGES: WorkItem["stage"][] = ["剧本", "硬锁资产", "首尾帧", "视频", "验收"];
const STUDIO_TEXT_PREVIEW_CHARACTERS = 20_000;
const STAGE_X: Record<WorkItem["stage"], number> = { 剧本: 0, 硬锁资产: 350, 首尾帧: 700, 视频: 1_050, 验收: 1_400 };
// Vue Flow 的节点组件类型要求运行时注入完整 NodeProps；这里由 Vue Flow 负责注入。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeTypes: any = { production: markRaw(ProductionNode), narrative: markRaw(NarrativeNode), zone: markRaw(ZoneNode), note: markRaw(CanvasNoteNode), group: markRaw(CanvasGroupNode) };
type ModuleView = "studio" | "canvas" | "story" | "adaptation" | "design" | "scripts" | "shots" | "timeline" | "continuityTracks" | "panelReferences" | "editor" | "assets" | "videos" | "review" | "continuation" | "generation" | "tasks" | "settings";
const moduleEntries = [
  { id: "canvas" as const, label: "生产画布", icon: markRaw(LayoutDashboard) },
  { id: "story" as const, label: "故事图谱", icon: markRaw(LibraryBig) },
  { id: "adaptation" as const, label: "自动改编", icon: markRaw(Sparkles) },
  { id: "design" as const, label: "生产设计", icon: markRaw(BookOpenCheck) },
  { id: "scripts" as const, label: "分集剧本", icon: markRaw(BookOpenText) },
  { id: "shots" as const, label: "单元清单", icon: markRaw(ListVideo) },
  { id: "timeline" as const, label: "镜头时间线", icon: markRaw(Rows3) },
  { id: "continuityTracks" as const, label: "连续性", icon: markRaw(GitBranch) },
  { id: "panelReferences" as const, label: "引用闭包", icon: markRaw(ShieldCheck) },
  { id: "editor" as const, label: "导演剪辑台", icon: markRaw(Scissors) },
  { id: "assets" as const, label: "资产库", icon: markRaw(Boxes) },
  { id: "videos" as const, label: "视频工作台", icon: markRaw(Clapperboard) },
  { id: "review" as const, label: "导演验收", icon: markRaw(ScanEye) },
  { id: "continuation" as const, label: "Codex 接续", icon: markRaw(BrainCircuit) },
  { id: "generation" as const, label: "生成队列", icon: markRaw(Workflow) },
  { id: "tasks" as const, label: "任务中心", icon: markRaw(SquareKanban) },
  { id: "settings" as const, label: "项目设置", icon: markRaw(Settings2) },
];

const index = ref<ProjectIndex | null>(null);
const managedShell = ref<ProjectShell | null>(null);
// VueFlow 的递归 Node 泛型不适合深层响应式；rebuildFlow 始终整页替换，使用 shallowRef（对齐受管画布先例）。
const nodes = shallowRef<Node[]>([]);
const edges = shallowRef<Edge[]>([]);
const projectRoot = ref("");
const projects = ref<ListedProjectSummary[]>([]);
const defaultManagedParentRoot = ref("");
const showProjectCenter = ref(false);
const projectsRefreshing = ref(false);
const rootRuntimeGateState = ref<"checking" | "allowed" | "blocked" | "unknown">("checking");
const rootRuntimeGateReasons = ref<string[]>([]);
const rootRuntimeGateMessage = ref("只进行豁免的运行时诊断；核对通过前不会读取或修改任何工程。");
const creatingManagedProject = ref(false);
const projectSwitching = ref(false);
const projectRemovingRoot = ref("");
type RendererManagedProjectOperation = {
  operationId: string;
  kind?: "backup" | "restore";
  phase: "idle" | "running" | "succeeded" | "failed" | "canceled";
  busy: boolean;
  stage: string;
  sourceRoot?: string;
  targetPath?: string;
  error?: string;
  updatedAt: string;
};
const managedProjectOperation = ref<RendererManagedProjectOperation | null>(null);
const externalManagedProjectBusy = computed(() => managedProjectOperation.value?.busy === true);
const projectOperationBusy = computed(() => creatingManagedProject.value
  || projectSwitching.value
  || Boolean(projectRemovingRoot.value)
  || externalManagedProjectBusy.value);
const showImportWizard = ref(false);
const importRoot = ref("");
const activeView = ref<ModuleView>("canvas");
const search = ref("");
const episodeFilter = ref("all");
const statusFilter = ref<WorkItemStatus | "all">("all");
const showShots = ref(false);
const showAssets = ref(false);
const showNarrative = ref(false);
const adaptationWorkspace = ref<AdaptationStore | null>(null);
const selectedId = ref<string | null>(null);
/** 生成队列跳转焦点（非受管镜头列表 / 受管素材中心） */
const generationJumpFocus = ref<{ unitId?: string; panelId?: string; jobId: string } | null>(null);
/** 受管素材中心外部切模式（绑定/画布） */
const studioModeRequest = ref<{
  mode: "canvas" | "dashboard" | "binding";
  unitId?: string;
  panelId?: string;
  token: number;
} | null>(null);
const loading = ref(true);
const scanInProgress = ref(false);
const scanCancelling = ref(false);
const zoom = ref(0.62);
const canvasWrap = ref<HTMLElement | null>(null);
const canvasViewport = ref({ x: 40, y: 30, zoom: 0.62 });
const productionFlow = useVueFlow("production-flow");
const canvasState = ref<CanvasSemanticState>({ schemaVersion: 1, revision: 0, entities: [], links: [], updatedAt: new Date(0).toISOString() });
const canvasHistory = ref<CanvasHistoryInfo>({ canUndo: false, canRedo: false, undoCount: 0, redoCount: 0, revision: 0 });
const linkMode = ref(false);
const linkSourceId = ref("");
const linkKind = ref<CanvasLinkKind>("continuity");
const savingCanvasEntity = ref(false);
type CanvasEditorDraft = Pick<CanvasEntity, "kind" | "title" | "body" | "color" | "position" | "width" | "height" | "memberOffsets"> & { id?: string; memberText: string };
const canvasEditor = ref<CanvasEditorDraft | null>(null);
const message = ref("");
const messageIsError = ref(false);
let messageTimer: ReturnType<typeof setTimeout> | null = null;
let removeIndexListener: (() => void) | undefined;
let removeErrorListener: (() => void) | undefined;
let removeSemanticListener: (() => void) | undefined;
let removeManagedProjectOperationListener: (() => void) | undefined;
let layoutGeneration = 0;
let projectSwitchGeneration = 0;
let projectCenterReturnFocus: HTMLElement | null = null;
const legacyProjectEpochGate = createLegacyProjectEpochGate();
const projectRemovalGate = createProjectScopedActionGate();
let activeLegacyScanToken: LegacyProjectEpochToken | null = null;
let activeLegacyWatcherIdentity: Awaited<ReturnType<typeof window.canvasApi.startWatch>> | null = null;
const layoutPositions = ref<Record<string, { x: number; y: number }>>({});
let layoutPositionsKey = "";

interface ProjectUiSnapshot {
  projectRoot: string;
  managedShell: ProjectShell | null;
  index: ProjectIndex | null;
  activeView: ModuleView;
  selectedId: string | null;
  episodeFilter: string;
  statusFilter: WorkItemStatus | "all";
  linkMode: boolean;
  linkSourceId: string;
  adaptationWorkspace: AdaptationStore | null;
  canvasState: CanvasSemanticState;
  canvasHistory: CanvasHistoryInfo;
}

interface StagedProjectUi {
  projectRoot: string;
  managedShell: ProjectShell | null;
  index: ProjectIndex | null;
  episodeFilter: string;
  adaptationWorkspace: AdaptationStore | null;
  canvasState: CanvasSemanticState;
  canvasHistory: CanvasHistoryInfo;
}

interface FrozenProjectRemovalScope {
  token: ProjectScopedActionToken;
  targetRoot: string;
  removingCurrent: boolean;
  legacyEpoch?: number;
}

function emptyCanvasState(): CanvasSemanticState {
  return { schemaVersion: 1, revision: 0, entities: [], links: [], updatedAt: new Date(0).toISOString() };
}

function emptyCanvasHistory(): CanvasHistoryInfo {
  return { canUndo: false, canRedo: false, undoCount: 0, redoCount: 0, revision: 0 };
}

function captureLegacyProjectToken(root = projectRoot.value): LegacyProjectEpochToken | null {
  const frozenRoot = root.trim();
  return frozenRoot ? legacyProjectEpochGate.capture(frozenRoot) : null;
}

function isLegacyProjectTokenCurrent(token: LegacyProjectEpochToken): boolean {
  return legacyProjectEpochGate.isCurrent(token, projectRoot.value);
}

function isActiveLegacyWatcherEvent(event: {
  projectRoot: string;
  watcherEpoch: number;
}): boolean {
  return isCurrentLegacyWatcherEvent(activeLegacyWatcherIdentity, event, projectRoot.value);
}

function projectRemovalOwnsOperation(scope: FrozenProjectRemovalScope): boolean {
  return projectRemovalGate.isCurrent(
    scope.token,
    projectRemovingRoot.value,
    scope.targetRoot,
  );
}

function projectRemovalIsCurrent(scope: FrozenProjectRemovalScope): boolean {
  return projectRemovalOwnsOperation(scope) && (!scope.removingCurrent || (
    projectRoot.value === scope.targetRoot
    && scope.legacyEpoch !== undefined
    && legacyProjectEpochGate.isEpochCurrent(scope.legacyEpoch)
  ));
}

function sameLegacyProjectToken(
  left: LegacyProjectEpochToken | null,
  right: LegacyProjectEpochToken,
): boolean {
  return Boolean(left && left.root === right.root && left.epoch === right.epoch);
}

function invalidateLegacyProjectAsyncState(): {
  epoch: number;
  activeScan: LegacyProjectEpochToken | null;
} {
  const activeScan = activeLegacyScanToken;
  activeLegacyScanToken = null;
  activeLegacyWatcherIdentity = null;
  const epoch = legacyProjectEpochGate.invalidate();
  layoutGeneration += 1;
  layoutPositions.value = {};
  layoutPositionsKey = "";
  scanInProgress.value = false;
  scanCancelling.value = false;
  savingCanvasEntity.value = false;
  loading.value = false;
  return { epoch, activeScan };
}

async function cancelInvalidatedLegacyScan(
  token: LegacyProjectEpochToken | null,
): Promise<boolean> {
  if (!token) return false;
  return window.canvasApi.cancelScan(token.root).catch(() => false);
}

function assetDetailForStudio(
  asset: NonNullable<Awaited<ReturnType<typeof window.canvasApi.getStudioAsset>>>,
  project = projectRoot.value,
): MaterialStudioUiDetail {
  return {
    id: asset.id,
    kind: asset.category,
    title: asset.name,
    description: asset.description,
    revision: asset.revision,
    aliases: asset.aliases,
    applicability: asset.applicability,
    relations: asset.relations.map((relation) => ({
      id: relation.id,
      seriesId: relation.seriesId,
      revision: relation.revision,
      ...(relation.supersedesRelationId ? { supersedesRelationId: relation.supersedesRelationId } : {}),
      ...(relation.supersededByRelationId ? { supersededByRelationId: relation.supersededByRelationId } : {}),
      head: relation.head,
      status: relation.status,
      kind: relation.kind,
      subjectAssetId: relation.subject.assetId,
      objectAssetId: relation.object.assetId,
      subjectRevision: relation.subject.assetRevision,
      objectRevision: relation.object.assetRevision,
      ...(relation.ordinal !== undefined ? { ordinal: relation.ordinal } : {}),
      role: relation.role,
      note: relation.note,
      fingerprint: relation.fingerprint,
    })),
    authorityThumbnailUrl: asset.primaryAuthority?.thumbnailRecipeKey
      ? `aicanvas-studio://thumbnail/${asset.primaryAuthority.thumbnailRecipeKey}?projectRoot=${encodeURIComponent(project)}`
      : undefined,
    primaryAuthority: asset.primaryAuthority ? {
      versionId: asset.primaryAuthority.versionId,
      mediaSha256: asset.primaryAuthority.mediaSha256,
    } : undefined,
    versions: asset.versions.map((version) => ({
      id: version.id,
      ordinal: version.ordinal,
      mediaSha256: version.mediaSha256,
      ...(version.thumbnailRecipeKey ? {
        thumbnailUrl: `aicanvas-studio://thumbnail/${version.thumbnailRecipeKey}?projectRoot=${encodeURIComponent(project)}`,
      } : {}),
      mediaUrl: `aicanvas-studio://media/${version.mediaSha256}?projectRoot=${encodeURIComponent(project)}`,
      reviewStatus: version.reviewStatus,
      isPrimary: version.id === asset.primaryAuthority?.versionId,
      sourceNote: version.sourceNote || undefined,
      reviewNote: [...asset.reviewHistory].reverse().find((review) => review.versionId === version.id)?.note,
      createdAt: version.createdAt,
    })),
    identityFeatures: asset.identityFeatures,
    positiveLocks: asset.positiveLocks,
    negativeLocks: asset.negativeLocks,
    prompt: asset.defaultPrompt || asset.negativeLocks.length ? {
      positive: asset.defaultPrompt || undefined,
      negative: asset.negativeLocks.join("；") || undefined,
      frozenPackId: asset.currentDefinitionVersionId,
    } : undefined,
  };
}

function bindingMutationResult(
  result: Awaited<ReturnType<typeof window.canvasApi.executeStudioCommand>>,
): StudioBindingMutationResult {
  if (result.status !== "succeeded") {
    throw new Error(result.error?.message || `剧本绑定命令未成功：${result.status}`);
  }
  const outcome = result.result as { message?: unknown } | undefined;
  return typeof outcome?.message === "string" ? { message: outcome.message } : {};
}

const studioBindingApi: StudioBindingWorkbenchApi = {
  listUnits(root, query) {
    return window.canvasApi.listStudioBindingUnits(root, query);
  },
  getControl(root, query) {
    return window.canvasApi.getStudioBindingControl(root, query);
  },
  async analyze(root, input) {
    const result = await window.canvasApi.executeStudioCommand(root, await createStudioCommandEnvelope({
      command: "analyze_studio_script_entities",
      payload: input,
    }));
    return bindingMutationResult(result);
  },
  async resolve(root, input) {
    const result = await window.canvasApi.executeStudioCommand(root, await createStudioCommandEnvelope({
      command: "resolve_studio_entity_proposal",
      payload: input,
    }));
    return bindingMutationResult(result);
  },
  async confirmEmpty(root, input) {
    const result = await window.canvasApi.executeStudioCommand(root, await createStudioCommandEnvelope({
      command: "confirm_studio_panel_empty",
      payload: input,
    }));
    return bindingMutationResult(result);
  },
  async freeze(root, input) {
    const result = await window.canvasApi.executeStudioCommand(root, await createStudioCommandEnvelope({
      command: "freeze_studio_asset_binding_set",
      payload: input,
    }));
    return bindingMutationResult(result);
  },
};

const studioContinuityReviewApi: StudioContinuityReviewUiApi = {
  getControl(root, input) {
    return window.canvasApi.getStudioContinuityReviewControl(root, input);
  },
  async getMedia(root, sha256) {
    const media = await window.canvasApi.getStudioMedia(root, sha256);
    return media ? { mediaUrl: media.mediaUrl, ...(media.thumbnail ? { thumbnail: { url: media.thumbnail.url } } : {}) } : null;
  },
  getReviewIdentity(root, packId) {
    return window.canvasApi.getStudioGenerationReviewIdentity(root, packId);
  },
  async submitReview(root, input) {
    const result = await window.canvasApi.executeStudioCommand(root, await createStudioCommandEnvelope({
      command: "submit_studio_generation_review",
      payload: {
        ...input,
        reviewer: "user" as const,
      },
    }));
    if (result.status !== "succeeded" || !result.result) {
      throw new Error(result.error?.message || "审片写回失败。");
    }
    return result.result as Awaited<ReturnType<NonNullable<StudioContinuityReviewUiApi["submitReview"]>>>;
  },
  async appendContinuityCorrection(root, input) {
    const result = await window.canvasApi.executeStudioCommand(root, await createStudioCommandEnvelope({
      command: "append_studio_continuity_correction",
      payload: {
        expectedHeadRevision: input.expectedHeadRevision,
        scope: input.scope,
        subjectId: input.subjectId,
        field: input.field,
        supersedesEntryId: input.supersedesEntryId,
        state: input.state.status === "resolved"
          ? {
            status: "resolved" as const,
            value: input.state.value,
            provenance: [{
              kind: "user-visual-confirmation",
              reference: "Studio continuity review",
              note: "用户在无限画布连续性复核中确认的画面可见状态。",
            }],
          }
          : {
            status: "not-applicable" as const,
            reason: input.state.reason,
            provenance: [{
              kind: "user-visual-confirmation",
              reference: "Studio continuity review",
              note: "用户在无限画布连续性复核中确认该字段不适用于当前画面对象。",
            }],
          },
      },
    }));
    if (result.status !== "succeeded") {
      throw new Error(result.error?.message || "连续性校正写回失败。");
    }
  },
};

const studioDashboardApi: StudioProductionDashboardUiApi = createStudioDashboardRequestCoalescer({
  getDashboard(root, query) {
    return window.canvasApi.getStudioProductionDashboard(root, query);
  },
  getProductionProjectionBundle(root, query) {
    return window.canvasApi.getStudioProductionProjectionBundle(root, query);
  },
  getHistoricalEvidenceByUnit(root, unitId) {
    return window.canvasApi.getStudioHistoricalGenerationEvidenceByUnit(root, unitId);
  },
  getCheckpointCanvasProjection(root) {
    return window.canvasApi.getStudioGenerationCheckpointCanvasProjection(root);
  },
});

const studioScriptAlignApi = {
  listUnits(
    root: string,
    query: Parameters<typeof window.canvasApi.listStudioProductionUnits>[1],
  ) {
    return window.canvasApi.listStudioProductionUnits(root, query);
  },
  getLibraryIndex(
    root: string,
    query: Parameters<typeof window.canvasApi.getStudioScriptLibraryIndex>[1],
  ) {
    return window.canvasApi.getStudioScriptLibraryIndex(root, query);
  },
  getReaderView(
    root: string,
    query: Parameters<typeof window.canvasApi.getStudioScriptReaderView>[1],
  ) {
    return window.canvasApi.getStudioScriptReaderView(root, query);
  },
  getStudioScriptMediaAlignBoard(
    root: string,
    query: { season: string; episode: string },
  ) {
    return window.canvasApi.getStudioScriptMediaAlignBoard(root, query);
  },
  openStoryboardWizard(
    root: string,
    input: Parameters<typeof window.canvasApi.openStudioStoryboardWizard>[1],
  ) {
    return window.canvasApi.openStudioStoryboardWizard(root, input);
  },
  async getMediaPreview(root: string, sha256: string) {
    const media = await window.canvasApi.getStudioMedia(root, sha256);
    return media
      ? {
          mediaUrl: media.mediaUrl,
          kind: media.kind,
          ...(media.thumbnail ? { thumbnailUrl: media.thumbnail.url } : {}),
        }
      : null;
  },
  importScript(root: string) {
    return window.canvasApi.pickAndImportStudioScript(root);
  },
  async materializeStoryboardWizard(
    root: string,
    input: {
      season: string;
      episode: string;
      sequence: number;
      unitTitle: string;
      scriptRevisionId: string;
      panels: import("@core/studio-storyboard-wizard").WizardEditablePanel[];
    },
  ) {
    const semanticBytes = new TextEncoder().encode(JSON.stringify(input));
    const semanticDigest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", semanticBytes))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const unitId = `unit-wizard-${semanticDigest.slice(0, 40)}`;
    const promptDocumentId = `prompt-wizard-${semanticDigest.slice(0, 40)}`;
    const promptTitle = `${input.unitTitle} · 15 秒分镜提示词`;
    const promptBody = input.panels.map((panel) =>
      `G${panel.panelIndex} ${panel.shotType} ${panel.startSeconds}-${panel.endSeconds}s ${panel.title}: ${panel.visualAction}`,
    ).join("\n");

    const requireResult = <T,>(
      result: Awaited<ReturnType<typeof window.canvasApi.executeStudioCommand>>,
      label: string,
    ): T => {
      if (result.status !== "succeeded" || !result.result) {
        throw new Error(result.error?.message || `${label}失败：${result.status}`);
      }
      return result.result as T;
    };

    const promptDocument = requireResult<{ id: string }>(
      await window.canvasApi.executeStudioCommand(root, await createStudioCommandEnvelope({
        command: "create_studio_prompt_document",
        payload: {
          id: promptDocumentId,
          title: promptTitle,
          expectedRevision: 0,
        },
      })),
      "建立向导提示词文档",
    );
    const promptRevision = requireResult<{ revision: { id: string } }>(
      await window.canvasApi.executeStudioCommand(root, await createStudioCommandEnvelope({
        command: "append_studio_prompt_revision",
        payload: {
          documentId: promptDocument.id,
          expectedRevision: 0,
          body: promptBody,
          source: "studio-storyboard-wizard-ui",
          sourceVersion: semanticDigest,
        },
      })),
      "写入向导提示词修订",
    );

    const assetIds = [...new Set(input.panels.flatMap((panel) => panel.suggestedAssetIds))];
    const assets = new Map<string, NonNullable<Awaited<ReturnType<typeof window.canvasApi.getStudioAsset>>>>();
    await Promise.all(assetIds.map(async (assetId) => {
      const asset = await window.canvasApi.getStudioAsset(root, assetId);
      if (asset) assets.set(assetId, asset);
    }));
    const unit = requireResult<{ unit: { id: string; revision: number } }>(
      await window.canvasApi.executeStudioCommand(root, await createStudioCommandEnvelope({
        command: "create_studio_production_unit",
        payload: {
          id: unitId,
          expectedRevision: 0,
          season: input.season,
          episode: input.episode,
          sequence: input.sequence,
          title: input.unitTitle,
          durationSeconds: 15,
          scriptRevisionId: input.scriptRevisionId,
          panels: input.panels.map((panel) => ({
            title: panel.title,
            visualAction: panel.visualAction,
            shotComposition: panel.shotComposition,
            filmingMethod: panel.filmingMethod,
            ...(panel.dialogue.trim() ? { dialogue: panel.dialogue.trim() } : {}),
            startSeconds: panel.startSeconds,
            endSeconds: panel.endSeconds,
            durationSeconds: panel.durationSeconds,
            promptRevisionId: promptRevision.revision.id,
            sourceSpans: panel.sourceSpans,
            assets: panel.suggestedAssetIds.flatMap((assetId) => {
              const asset = assets.get(assetId);
              if (!asset) return [];
              return [{
                assetId,
                category: asset.category,
                presence: "optional" as const,
                role: asset.name,
                continuityState: "unknown",
                evidence: [{
                  kind: "wizard-suggest",
                  reference: input.scriptRevisionId,
                  note: "15 秒分镜向导的确定性身份建议，仍需 Binding 人工裁决。",
                }],
              }];
            }),
            ...(panel.transition.trim() ? { transition: panel.transition.trim() } : {}),
            ...(panel.costumeState.trim() ? { costumeState: panel.costumeState.trim() } : {}),
            ...(panel.sceneLighting.trim() ? { sceneLighting: panel.sceneLighting.trim() } : {}),
            shotType: panel.shotType,
            ...(panel.negativePrompt.trim() ? { negativePrompt: panel.negativePrompt.trim() } : {}),
          })),
        },
      })),
      "物化 15 秒生产单元",
    );
    const binding = await window.canvasApi.getStudioBindingControl(root, { unitId: unit.unit.id });
    return {
      unitId: unit.unit.id,
      unitRevision: unit.unit.revision,
      promptDocumentId: promptDocument.id,
      promptRevisionId: promptRevision.revision.id,
      panelStatuses: binding.panels.map((panel) => ({
        panelId: panel.id,
        panelIndex: panel.ordinal,
        status: panel.status,
      })),
    };
  },
};

const studioMultimediaTimelineApi = {
  listUnits(
    root: string,
    query: Parameters<typeof window.canvasApi.listStudioProductionUnits>[1],
  ) {
    return window.canvasApi.listStudioProductionUnits(root, query);
  },
  getTimeline(root: string, query: { unitId: string }) {
    return window.canvasApi.getStudioMultimediaTimeline(root, query);
  },
  async pickAndImportMedia(root: string) {
    const paths = await window.canvasApi.pickStudioMediaFiles();
    const sourcePath = paths[0];
    if (!sourcePath) return { imported: false };
    const result = await window.canvasApi.executeStudioCommand(root, await createStudioCommandEnvelope({
      command: "import_studio_media",
      payload: { sourcePath },
    }));
    const media = result.result as {
      sha256?: string;
      kind?: "video" | "audio" | "image";
      mimeType?: string;
      sizeBytes?: number;
      sourceBasename?: string;
    } | undefined;
    if (!media?.sha256 || (media.kind !== "video" && media.kind !== "audio")
      || !media.mimeType || !Number.isFinite(media.sizeBytes) || !media.sourceBasename) {
      throw new Error("所选文件不是可绑定的视频或音频，未修改时间线。");
    }
    return {
      imported: true,
      media: {
        sha256: media.sha256,
        kind: media.kind,
        mimeType: media.mimeType,
        sizeBytes: media.sizeBytes!,
        sourceBasename: media.sourceBasename,
      },
    };
  },
  async attachMedia(root: string, payload: {
    unitId: string;
    unitRevision: number;
    expectedUnitFingerprint: string;
    slotId: string;
    expectedHeadRevision: number;
    panelIndex?: number;
    startSeconds: number;
    endSeconds: number;
    role: "storyboard" | "video" | "dialogue" | "music" | "sfx";
    mediaSha256: string;
    note?: string;
  }) {
    const result = await window.canvasApi.executeStudioCommand(root, await createStudioCommandEnvelope({
      command: "attach_studio_multimedia_timeline_media",
      payload,
    }));
    return result.result;
  },
};

function materialTimelineStatus(status: string): "pending" | "current" | "complete" {
  if (status === "generation-ready") return "complete";
  if (["ambiguous", "unmatched", "bound", "stale"].includes(status)) return "current";
  return "pending";
}

function studioPanelStatusLabel(status: string): string {
  return ({
    pending: "待处理",
    unchecked: "待分析",
    ambiguous: "待消歧",
    unmatched: "缺少资产",
    bound: "已绑定",
    stale: "需更新",
    "generation-ready": "可生成",
  } as Record<string, string>)[status] ?? status;
}

const materialStudioApi: MaterialStudioUiApi = {
  openProjectCenter,
  // P24 U4：文稿修订历史（只读通道，≤20 条）。
  listTextRevisions: (root, query) => window.canvasApi.listStudioTextRevisions(root, query),
  async getOverview(root) {
    const [shell, material, production, dashboardOverview] = await Promise.all([
      window.canvasApi.getManagedProjectShell(root),
      window.canvasApi.getMaterialStudioState(root),
      window.canvasApi.getStudioProductionState(root),
      studioDashboardApi.getDashboard(root, { operation: "overview" }),
    ]);
    if (!shell) throw new Error("当前项目不是受管素材工程。");
    const nextUnitId = dashboardOverview.operation === "overview"
      ? dashboardOverview.nextAction.locator?.unitId
      : undefined;
    const dashboardUnitResponse = nextUnitId
      ? await window.canvasApi.getStudioProductionDashboard(root, {
        operation: "unit",
        unitId: nextUnitId,
        ...(dashboardOverview.operation === "overview" && dashboardOverview.nextAction.locator?.panelId
          ? { panelId: dashboardOverview.nextAction.locator.panelId }
          : {}),
      })
      : null;
    const currentUnit = dashboardUnitResponse?.operation === "unit" ? dashboardUnitResponse : null;
    const reviewedSlotCount = dashboardOverview.operation === "overview"
      ? dashboardOverview.checkpoint.completedSlotCount
      : 0;
    const counts = {
      textDocuments: production.counts.textDocuments,
      scripts: production.counts.scriptDocuments,
      prompts: production.counts.promptDocuments,
      character: material.counts.characters,
      scene: material.counts.scenes,
      prop: material.counts.props,
      style: material.counts.styles,
      media: material.counts.media,
      canonicalAssets: material.counts.canonicalAssets,
      total: production.counts.textDocuments + material.counts.canonicalAssets + material.counts.media,
    };
    // nextAction 必须来自 Core Dashboard 投影，禁止 UI 自行推导业务动作。
    const nextAction = dashboardOverview.operation === "overview"
      ? `${dashboardOverview.nextAction.label}：${dashboardOverview.nextAction.reason}`
      : "打开生产驾驶舱查看 Core 下一动作。";
    return {
      projectName: shell.project.name,
      nextAction,
      nextActionControl: dashboardOverview.operation === "overview"
        ? dashboardOverview.nextAction
        : undefined,
      counts,
      timeline: {
        currentLabel: currentUnit
          ? `${currentUnit.unit.episodeId} · ${currentUnit.unit.label} · ${currentUnit.unit.panelCount} 宫格${reviewedSlotCount ? ` · 已审片槽位 ${reviewedSlotCount}` : ""}`
          : reviewedSlotCount ? `已审片槽位 ${reviewedSlotCount}` : "等待 Core 指定下一分镜",
        unitCount: production.counts.units,
        // 旧 UI 合同名仍为 completedUnitCount；值取 Core checkpoint 的真实已审片槽位，
        // MaterialStudioView 应在独立改动中将展示标签校正为“已审片槽位”。
        completedUnitCount: reviewedSlotCount,
        segments: currentUnit?.panels.map((panel) => ({
          id: panel.id,
          label: `${panel.ordinal}. ${panel.label} · ${studioPanelStatusLabel(panel.status)}`,
          durationSeconds: panel.durationSeconds,
          status: materialTimelineStatus(panel.status),
        })) ?? [],
      },
    };
  },
  async listEntries(root, query) {
    if (query.section === "media") {
      const page = await window.canvasApi.listStudioMedia(root, {
        search: query.search,
        cursor: query.cursor,
        limit: query.limit,
      });
      return {
        items: page.items.map((media): MaterialStudioUiEntry => ({
          id: `media:${media.sha256}`,
          kind: media.kind,
          title: media.sourceBasename,
          subtitle: media.mimeType,
          summary: "已安全存入当前工程",
          meta: `${(media.sizeBytes / 1024 / 1024).toFixed(2)} MiB · ${media.derivativeStatus === "ready" ? "预览就绪" : "代理待生成"}`,
          thumbnailUrl: media.thumbnail?.url,
          mediaSha256: media.sha256,
          updatedAt: media.createdAt,
        })),
        nextCursor: page.nextCursor,
      };
    }
    if (query.section === "script" || query.section === "prompt") {
      const page = await window.canvasApi.listStudioTextDocuments(root, {
        kind: query.section,
        search: query.search,
        cursor: query.cursor,
        limit: query.limit,
      });
      return {
        items: page.items.map((document): MaterialStudioUiEntry => ({
          id: `${document.kind}:${document.id}`,
          kind: document.kind,
          title: document.title,
          subtitle: document.kind === "script" ? "剧本正文" : "冻结提示词",
          meta: document.revision ? "正文已保存" : "等待正文",
          updatedAt: document.updatedAt,
        })),
        nextCursor: page.nextCursor,
      };
    }
    const page = await window.canvasApi.listStudioAssets(root, {
      category: query.section,
      search: query.search,
      cursor: query.cursor,
      limit: query.limit,
    });
    return {
      items: page.items.map((asset): MaterialStudioUiEntry => ({
        id: `asset:${asset.id}`,
        kind: asset.category,
        title: asset.name,
        subtitle: asset.aliases.filter((alias) => alias !== asset.name).slice(0, 3).join(" · "),
        summary: asset.description,
        meta: `${asset.versionCount} 个参考版本 · ${asset.primaryAuthority ? "权威已锁定" : "等待权威图"}`,
        thumbnailUrl: asset.primaryAuthority?.thumbnailRecipeKey
          ? `aicanvas-studio://thumbnail/${asset.primaryAuthority.thumbnailRecipeKey}?projectRoot=${encodeURIComponent(root)}`
          : undefined,
        authorityState: asset.primaryAuthority ? "locked" : asset.versionCount ? "candidate" : "missing",
        updatedAt: asset.updatedAt,
      })),
      nextCursor: page.nextCursor,
    };
  },
  async getEntryDetail(root, entryId) {
    const separator = entryId.indexOf(":");
    const scope = separator >= 0 ? entryId.slice(0, separator) : "";
    const id = separator >= 0 ? entryId.slice(separator + 1) : entryId;
    if (scope === "asset") {
      const asset = await window.canvasApi.getStudioAsset(root, id);
      return asset ? assetDetailForStudio(asset, root) : null;
    }
    if (scope === "media") {
      const media = await window.canvasApi.getStudioMedia(root, id);
      if (!media) return null;
      let previewUrl = media.thumbnail?.url;
      let playbackUrl = media.kind === "image" ? undefined : media.mediaUrl;
      let previewStatus: "ready" | "blocked" | "failed" | "not-required" = media.kind === "image" ? "not-required" : "blocked";
      let previewMessage = media.kind === "image" ? "图片使用冻结缩略图，原图仅在明确需要时读取。" : "尚未准备轻量预览。";
      if (media.kind !== "image") {
        try {
          const prepared = await window.canvasApi.prepareStudioMediaDerivatives(root, media.sha256);
          const poster = prepared.derivatives.find((entry) => entry.status === "ready"
            && (entry.kind === "video_poster" || entry.kind === "audio_waveform"));
          const proxy = prepared.derivatives.find((entry) => entry.status === "ready" && entry.kind === "video_proxy");
          previewUrl = poster?.url;
          playbackUrl = media.kind === "video" ? (proxy?.url ?? media.mediaUrl) : media.mediaUrl;
          previewStatus = prepared.status;
          previewMessage = prepared.status === "ready"
            ? `${prepared.replayed ? "复用" : "已生成"}轻量${media.kind === "video" ? "封面与 720p 代理" : "波形"}，未把原媒体载入画布状态。`
            : "本机媒体引擎不可用，保留原媒体并停止派生；启动过程不会自动重试。";
        } catch (reason) {
          previewStatus = "failed";
          previewMessage = `轻量预览准备失败：${reason instanceof Error ? reason.message : String(reason)}`;
        }
      }
      return {
        id: media.sha256,
        kind: media.kind,
        title: media.sourceBasename,
        description: `${media.mimeType} · ${(media.sizeBytes / 1024 / 1024).toFixed(2)} MiB`,
        revision: 1,
        authorityThumbnailUrl: previewUrl,
        mediaPreview: {
          status: previewStatus,
          message: previewMessage,
          ...(previewUrl ? { previewUrl } : {}),
          ...(playbackUrl ? { playbackUrl } : {}),
          mimeType: media.mimeType,
        },
      };
    }
    if (scope === "script" || scope === "prompt") {
      const document = await window.canvasApi.getStudioTextDocument(root, id);
      if (!document || document.kind !== scope) return null;
      const latestMetadata = document.revision > 0
        ? await window.canvasApi.getLatestStudioTextRevisionMetadata(root, document.id)
        : null;
      const latest = latestMetadata
        ? await window.canvasApi.getStudioTextRevision(root, latestMetadata.id)
        : null;
      const bodyPreview = latest?.body.slice(0, STUDIO_TEXT_PREVIEW_CHARACTERS) ?? "";
      return {
        id: document.id,
        kind: document.kind,
        title: document.title,
        description: document.revision ? `已保存 ${document.revision} 个历史版本（不可改）。` : "尚未保存正文。",
        revision: document.revision,
        ...(latest ? {
          textDocument: {
            kind: document.kind,
            bodyPreview,
            bodySizeBytes: latest.bodySizeBytes,
            bodySha256: latest.bodySha256,
            source: latest.source,
            sourceVersion: latest.sourceVersion,
            truncated: latest.body.length > bodyPreview.length,
          },
        } : {}),
      };
    }
    return null;
  },
  async chooseAndImportScript(root) {
    return window.canvasApi.pickAndImportStudioScript(root);
  },
  async chooseAndImportPrompt(root) {
    return window.canvasApi.pickAndImportStudioPrompt(root);
  },
  async chooseAndImportMedia(root) {
    const paths = await window.canvasApi.pickStudioMediaFiles();
    if (!paths.length) return { imported: false };
    let firstSha: string | undefined;
    for (const sourcePath of paths) {
      const result = await window.canvasApi.executeStudioCommand(root, await createStudioCommandEnvelope({
        command: "import_studio_media",
        payload: { sourcePath },
      }));
      const imported = result.result as { sha256?: string } | undefined;
      firstSha ??= imported?.sha256;
    }
    return { imported: true, entryId: firstSha ? `media:${firstSha}` : undefined };
  },
  async exportCrossProjectAssetPackage(root, input) {
    const outputPackageRoot = await window.canvasApi.pickStudioCrossProjectAssetExportRoot();
    if (!outputPackageRoot) return null;
    const result = await window.canvasApi.executeStudioCommand(root, await createStudioCommandEnvelope({
      command: "export_studio_cross_project_asset_package",
      payload: {
        items: [{
          assetId: input.assetId,
          expectedRevision: input.expectedRevision,
        }],
        outputPackageRoot,
      },
    }));
    if (result.status !== "succeeded" || !result.result) {
      throw new Error(result.error?.message || "跨工程资产复用包导出失败。");
    }
    return result.result as import("@core/studio-cross-project-asset-reuse").ExportStudioCrossProjectAssetPackageResult;
  },
  pickCrossProjectAssetPackage() {
    return window.canvasApi.pickStudioCrossProjectAssetPackage();
  },
  async importCrossProjectAssetPackage(root, input) {
    const result = await window.canvasApi.executeStudioCommand(root, await createStudioCommandEnvelope({
      command: "import_studio_cross_project_asset_package",
      payload: input,
    }));
    if (result.status !== "succeeded" || !result.result) {
      throw new Error(result.error?.message || "跨工程资产复用包导入失败。");
    }
    return result.result as import("@core/studio-cross-project-asset-reuse").ImportStudioCrossProjectAssetPackageResult;
  },
  async createAsset(root, input) {
    const result = await window.canvasApi.executeStudioCommand(root, await createStudioCommandEnvelope({
      command: "create_studio_asset",
      payload: input,
    }));
    const asset = result.result as { id?: string } | undefined;
    if (!asset?.id) throw new Error("素材资产创建结果缺少 ID。");
    return { assetId: asset.id };
  },
  async appendPendingAssetVersion(root, input) {
    await window.canvasApi.executeStudioCommand(root, await createStudioCommandEnvelope({
      command: "append_studio_asset_version",
      payload: {
        assetId: input.assetId,
        mediaSha256: input.mediaSha256,
        reviewStatus: "pending",
        sourceNote: input.sourceNote,
        expectedRevision: input.expectedRevision,
      },
    }));
    const asset = await window.canvasApi.getStudioAsset(root, input.assetId);
    if (!asset) throw new Error("版本追加后无法读取目标资产。");
    return assetDetailForStudio(asset, root);
  },
  async reviewPendingAssetVersion(root, input) {
    const result = await window.canvasApi.executeStudioCommand(root, await createStudioCommandEnvelope({
      command: "review_studio_asset_version",
      payload: input,
    }));
    const asset = result.result as NonNullable<Awaited<ReturnType<typeof window.canvasApi.getStudioAsset>>> | undefined;
    if (!asset?.id) throw new Error("版本审核结果无效。");
    return assetDetailForStudio(asset, root);
  },
  async promoteApprovedAuthority(root, input) {
    const result = await window.canvasApi.executeStudioCommand(root, await createStudioCommandEnvelope({
      command: "set_studio_primary_authority",
      payload: { ...input, note: "由素材中心提升为当前硬锁权威。" },
    }));
    const asset = result.result as NonNullable<Awaited<ReturnType<typeof window.canvasApi.getStudioAsset>>> | undefined;
    if (!asset?.id) throw new Error("权威版本提升结果无效。");
    return assetDetailForStudio(asset, root);
  },
  async appendAssetRelation(root, input) {
    const related = await window.canvasApi.getStudioAsset(root, input.relatedAssetId);
    if (!related) throw new Error(`关联资产不存在：${input.relatedAssetId}`);
    const compositeMember = input.kind === "composite_member";
    await window.canvasApi.executeStudioCommand(root, await createStudioCommandEnvelope({
      command: "append_studio_asset_relation",
      payload: {
        kind: input.kind,
        subjectAssetId: compositeMember ? related.id : input.assetId,
        objectAssetId: compositeMember ? input.assetId : related.id,
        expectedSubjectRevision: compositeMember ? related.revision : input.expectedRevision,
        expectedObjectRevision: compositeMember ? input.expectedRevision : related.revision,
        ...(input.ordinal !== undefined ? { ordinal: input.ordinal } : {}),
        ...(input.role ? { role: input.role } : {}),
        ...(input.note ? { note: input.note } : {}),
      },
    }));
    const asset = await window.canvasApi.getStudioAsset(root, input.assetId);
    if (!asset) throw new Error("关系追加后无法读取目标资产。");
    return assetDetailForStudio(asset, root);
  },
  async rebaseAssetRelation(root, input) {
    const [subject, object] = await Promise.all([
      window.canvasApi.getStudioAsset(root, input.relation.subjectAssetId),
      window.canvasApi.getStudioAsset(root, input.relation.objectAssetId),
    ]);
    if (!subject) throw new Error(`关系 subject 资产不存在：${input.relation.subjectAssetId}`);
    if (!object) throw new Error(`关系 object 资产不存在：${input.relation.objectAssetId}`);
    await window.canvasApi.executeStudioCommand(root, await createStudioCommandEnvelope({
      command: "append_studio_asset_relation",
      payload: {
        supersedesRelationId: input.relation.id,
        kind: input.relation.kind,
        subjectAssetId: input.relation.subjectAssetId,
        objectAssetId: input.relation.objectAssetId,
        expectedSubjectRevision: subject.revision,
        expectedObjectRevision: object.revision,
        ...(input.relation.ordinal !== undefined ? { ordinal: input.relation.ordinal } : {}),
        ...(input.relation.role ? { role: input.relation.role } : {}),
        ...(input.relation.note ? { note: input.relation.note } : {}),
      },
    }));
    const asset = await window.canvasApi.getStudioAsset(root, input.assetId);
    if (!asset) throw new Error("关系重建后无法读取目标资产。");
    return assetDetailForStudio(asset, root);
  },
  async openTimeline() {
    showMessage("15 秒单元已在生产知识库中按资产时间线保存；可先导入剧本并建立资产。 ");
  },
};

const artifactMap = computed(() => new Map((index.value?.artifacts ?? []).map((artifact) => [artifact.id, artifact])));
const episodes = computed(() =>
  [...new Set((index.value?.items ?? []).filter((item) => item.type === "unit").map((item) => item.episode).filter((value): value is number => Boolean(value)))].sort(
    (a, b) => a - b,
  ),
);
const statusEntries = computed(() => {
  const counts = new Map<WorkItemStatus, number>();
  for (const item of index.value?.items ?? []) {
    if (item.type !== "unit") continue;
    if (episodeFilter.value !== "all" && item.episode !== Number(episodeFilter.value)) continue;
    counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  }
  return [...counts].map(([status, count]) => ({ status, count }));
});
const visibleItems = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return (index.value?.items ?? []).filter((item) => {
    if (item.type === "episode") return false;
    if (item.type === "asset" && !showAssets.value) return false;
    if (item.type === "shot" && !showShots.value) return false;
    if (item.type !== "asset" && episodeFilter.value !== "all" && item.episode !== Number(episodeFilter.value)) return false;
    if (statusFilter.value !== "all" && item.status !== statusFilter.value) return false;
    if (needle && !`${item.title} ${item.infoExcerpt ?? ""} ${item.sourcePaths.join(" ")}`.toLowerCase().includes(needle)) return false;
    return true;
  });
});
const selectedItem = computed(() => index.value?.items.find((item) => item.id === selectedId.value) ?? null);
const selectedArtifacts = computed(() => {
  const item = selectedItem.value;
  if (!item) return [];
  return item.artifactIds.map((id) => artifactMap.value.get(id)).filter((artifact): artifact is Artifact => Boolean(artifact));
});
const canvasNodeCount = computed<number>(() => (nodes.value as Array<{ type?: string }>).filter((node) => node.type !== "zone" && node.type !== "group").length);
const scanTime = computed(() => {
  if (!index.value) return "";
  const date = new Date(index.value.scannedAt);
  const stats = index.value.scanStats;
  const inspection = stats ? ` · ${stats.reusedChecks ? `复用 ${stats.reusedChecks}/${stats.inspectedChecks + stats.reusedChecks}` : `新检 ${stats.inspectedChecks}`}${stats.reservedPublicationFilesSkipped ? ` · 写入中 ${stats.reservedPublicationFilesSkipped}` : ""}` : "";
  return `${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} · ${index.value.scanDurationMs}ms${inspection}`;
});
const viewKey = computed(() => `${episodeFilter.value}-${showShots.value ? "shots" : "units"}-${showAssets.value ? "assets" : "no-assets"}-${showNarrative.value ? "narrative" : "production"}-${statusFilter.value}`);

// 仅在跨越 0.35 紧凑阈值时才需要重建节点；缩放本身（zoom 变化）不触发 rebuildFlow（P18 实测：100 次缩放产生 101 次重建）。
const compactZoom = computed(() => zoom.value < 0.35);
watch([visibleItems, viewKey, compactZoom], () => void rebuildFlow());

onMounted(async () => {
  try {
    const gate = await window.canvasApi.getRuntimeWriteGate();
    rootRuntimeGateReasons.value = Array.isArray("reasons" in gate ? gate.reasons : undefined)
      ? [...gate.reasons]
      : [];
    if (gate.allowed !== true) {
      rootRuntimeGateState.value = "blocked";
      rootRuntimeGateMessage.value = rootRuntimeGateReasons.value.some((reason) => (
        reason === "runtime-artifact-source-mismatch"
        || reason === "runtime-artifact-changed"
        || reason === "runtime-artifact-unavailable"
      ))
        ? "当前运行工件与源码不一致。请重新构建并重启源码版无限画布；不要继续使用旧进程。"
        : "源码已在本进程启动后变化或不可核验。请重启源码版无限画布后继续。";
      return;
    }
    rootRuntimeGateState.value = "allowed";
  } catch (error) {
    rootRuntimeGateState.value = "unknown";
    rootRuntimeGateMessage.value = `运行时诊断失败，已按不安全状态关闭业务访问：${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  try {
    window.aiCanvasDiagnostics = { snapshot: canvasDiagnosticsSnapshot, focusNode: focusCanvasNode, setZoom: (target) => productionFlow.zoomTo(target, { duration: 0 }) };
  removeIndexListener = window.canvasApi.onIndexUpdated((updated) => {
    if (projectSwitching.value || updated.project.primaryRoot !== projectRoot.value) return;
    index.value = updated;
    showMessage("文件变化已同步到画布");
  });
  removeErrorListener = window.canvasApi.onWatchError((error) => showMessage(error, true));
  removeSemanticListener = window.canvasApi.onCanvasSemanticUpdated((event) => {
    if (projectSwitching.value || !isActiveLegacyWatcherEvent(event)) return;
    const state = event.state;
    if (state.revision <= canvasState.value.revision && !(state.revision === 0 && canvasState.value.revision > 0)) return;
    canvasState.value = state;
    void rebuildFlow();
    void refreshCanvasHistory();
    showMessage("画布批注与关系已实时同步");
  });
  window.addEventListener("keydown", onCanvasShortcut);
  removeManagedProjectOperationListener = window.canvasApi.onManagedProjectOperationState(applyManagedProjectOperationState);
  const [activeProject, registeredProjects, defaultProjectsRoot, operationState] = await Promise.all([
    window.canvasApi.getActiveProject(),
    requestProjectList(),
    window.canvasApi.getDefaultManagedProjectsRoot(),
    window.canvasApi.getManagedProjectOperationState(),
  ]);
  applyManagedProjectOperationState(operationState);
  projects.value = registeredProjects;
  defaultManagedParentRoot.value = defaultProjectsRoot;
  const launchImportRoot = new URLSearchParams(window.location.search).get("importRoot");
  if (launchImportRoot) {
    importRoot.value = launchImportRoot;
    showImportWizard.value = true;
  }
  // 启动只恢复显式活动项目；缺失/不可用时不猜测项目列表第一项。
  const recent = activeProject?.available ? activeProject : undefined;
  if (recent?.primaryRoot) {
    const startupRoot = recent.primaryRoot;
    invalidateLegacyProjectAsyncState();
    projectRoot.value = startupRoot;
    const startupToken = captureLegacyProjectToken(startupRoot)!;
    const startupShell = await window.canvasApi.getManagedProjectShell(startupRoot);
    if (!isLegacyProjectTokenCurrent(startupToken)) return;
    managedShell.value = startupShell;
    if (managedShell.value) {
      activeView.value = "studio";
      index.value = null;
      loading.value = false;
    } else {
      if (!await loadIndex(false, startupToken)) return;
      const startupWatcherIdentity = await window.canvasApi.startWatch(startupRoot);
      if (!isLegacyProjectTokenCurrent(startupToken)) {
        await window.canvasApi.stopWatch(startupRoot).catch(() => undefined);
        return;
      }
      activeLegacyWatcherIdentity = startupWatcherIdentity;
    }
    await window.canvasApi.activateProject(startupRoot);
    if (!isLegacyProjectTokenCurrent(startupToken)) return;
  } else {
    loading.value = false;
  }
  } catch (error) {
    loading.value = false;
    showMessage(`源码无限画布启动读取失败：${error instanceof Error ? error.message : String(error)}`, true);
  }
});

onBeforeUnmount(() => {
  projectSwitchGeneration += 1;
  const invalidated = invalidateLegacyProjectAsyncState();
  projectRemovalGate.dispose();
  projectRemovingRoot.value = "";
  void cancelInvalidatedLegacyScan(invalidated.activeScan);
  projectListRefreshController.dispose();
  if (projectRoot.value) void window.canvasApi.stopWatch(projectRoot.value);
  removeIndexListener?.();
  removeErrorListener?.();
  removeSemanticListener?.();
  removeManagedProjectOperationListener?.();
  window.removeEventListener("keydown", onCanvasShortcut);
  if (messageTimer) clearTimeout(messageTimer);
  delete window.aiCanvasDiagnostics;
});

function applyManagedProjectOperationState(detail: RendererManagedProjectOperation): void {
  const current = managedProjectOperation.value;
  if (current && Date.parse(current.updatedAt) > Date.parse(detail.updatedAt)) return;
  managedProjectOperation.value = detail;
}

function canvasDiagnosticsSnapshot() {
  const productionNodes = (nodes.value as Array<{ id: string; type?: string; position: { x: number; y: number } }>).filter((node) => node.type === "production");
  const duplicatePositionPairs: string[][] = [];
  const overlapPairs: string[][] = [];
  for (let left = 0; left < productionNodes.length; left += 1) {
    const a = productionNodes[left]!;
    for (let right = left + 1; right < productionNodes.length; right += 1) {
      const b = productionNodes[right]!;
      if (a.position.x === b.position.x && a.position.y === b.position.y) duplicatePositionPairs.push([a.id, b.id]);
      if (a.position.x < b.position.x + 280 && a.position.x + 280 > b.position.x && a.position.y < b.position.y + 218 && a.position.y + 218 > b.position.y) overlapPairs.push([a.id, b.id]);
    }
  }
  return {
    projectRoot: projectRoot.value,
    visibleItems: visibleItems.value.length,
    logicalProductionNodes: productionNodes.length,
    productionNodeIds: productionNodes.map((node) => node.id),
    duplicatePositionPairs,
    overlapPairs,
    viewport: productionFlow.getViewport(),
  };
}

async function focusCanvasNode(nodeId: string, targetZoom = 0.62): Promise<boolean> {
  const node = (nodes.value as Array<{ id: string; type?: string; position: { x: number; y: number } }>).find((candidate) => candidate.id === nodeId && candidate.type === "production");
  if (!node) return false;
  const centered = await productionFlow.setCenter(node.position.x + 140, node.position.y + 109, { zoom: targetZoom, duration: 0 });
  await nextTick();
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  return centered;
}

async function loadIndex(
  refresh = false,
  expectedToken?: LegacyProjectEpochToken,
): Promise<boolean> {
  if (projectSwitching.value) return false;
  const token = expectedToken ?? captureLegacyProjectToken();
  if (!token || !isLegacyProjectTokenCurrent(token)) return false;
  loading.value = true;
  try {
    const [nextIndex, nextCanvasState, nextCanvasHistory, nextAdaptationWorkspace] = await Promise.all([
      window.canvasApi.getIndex(token.root, refresh),
      window.canvasApi.getCanvasSemanticState(token.root),
      window.canvasApi.getCanvasHistoryInfo(token.root),
      window.canvasApi.getAdaptationWorkspace(token.root).catch(() => null),
    ]);
    if (!isLegacyProjectTokenCurrent(token)) return false;
    if (nextIndex.project.primaryRoot !== token.root) {
      throw new Error(`项目索引根与请求不一致：${nextIndex.project.primaryRoot}`);
    }
    index.value = nextIndex;
    canvasState.value = nextCanvasState;
    canvasHistory.value = nextCanvasHistory;
    adaptationWorkspace.value = nextAdaptationWorkspace;
    if (nextIndex.summary.total > 200 && episodeFilter.value === "all") {
      const first = nextIndex.items.find((item) => item.type === "unit" && item.episode)?.episode;
      if (first) episodeFilter.value = String(first);
    }
    await rebuildFlow(token);
    return isLegacyProjectTokenCurrent(token);
  } catch (error) {
    if (isLegacyProjectTokenCurrent(token)) {
      showMessage(error instanceof Error ? error.message : String(error), true);
    }
    return false;
  } finally {
    if (isLegacyProjectTokenCurrent(token)) loading.value = false;
  }
}

async function scanNow() {
  if (projectSwitching.value || activeLegacyScanToken) return;
  const token = captureLegacyProjectToken();
  if (!token || !isLegacyProjectTokenCurrent(token)) return;
  activeLegacyScanToken = token;
  loading.value = true;
  scanInProgress.value = true;
  scanCancelling.value = false;
  try {
    const nextIndex = await window.canvasApi.scan(token.root);
    if (!isLegacyProjectTokenCurrent(token)) return;
    if (nextIndex.project.primaryRoot !== token.root) {
      throw new Error(`扫描结果根与请求不一致：${nextIndex.project.primaryRoot}`);
    }
    index.value = nextIndex;
    await rebuildFlow(token);
    if (!isLegacyProjectTokenCurrent(token)) return;
    const stats = nextIndex.scanStats;
    showMessage(`扫描完成：${nextIndex.summary.total} 个 15 秒单元${stats ? `，新检 ${stats.inspectedChecks}、复用 ${stats.reusedChecks}${stats.reservedPublicationFilesSkipped ? `、跳过写入中输出 ${stats.reservedPublicationFilesSkipped}` : ""}` : ""}`);
  } catch (error) {
    if (isLegacyProjectTokenCurrent(token)) {
      if (error instanceof Error && (error.name === "AbortError" || /取消/.test(error.message))) showMessage("扫描已取消，画布继续使用上一次完整快照");
      else showMessage(error instanceof Error ? error.message : String(error), true);
    }
  } finally {
    if (sameLegacyProjectToken(activeLegacyScanToken, token)) activeLegacyScanToken = null;
    if (isLegacyProjectTokenCurrent(token)) {
      scanInProgress.value = false;
      scanCancelling.value = false;
      loading.value = false;
    }
  }
}

async function cancelScanNow() {
  const token = activeLegacyScanToken;
  if (!token || !isLegacyProjectTokenCurrent(token) || scanCancelling.value) return;
  scanCancelling.value = true;
  const accepted = await window.canvasApi.cancelScan(token.root).catch(() => false);
  if (isLegacyProjectTokenCurrent(token) && !accepted) scanCancelling.value = false;
}

function captureProjectUiSnapshot(): ProjectUiSnapshot {
  return {
    projectRoot: projectRoot.value,
    managedShell: managedShell.value,
    index: index.value,
    activeView: activeView.value,
    selectedId: selectedId.value,
    episodeFilter: episodeFilter.value,
    statusFilter: statusFilter.value,
    linkMode: linkMode.value,
    linkSourceId: linkSourceId.value,
    adaptationWorkspace: adaptationWorkspace.value,
    canvasState: canvasState.value,
    canvasHistory: canvasHistory.value,
  };
}

function restoreProjectUiSnapshot(snapshot: ProjectUiSnapshot): void {
  projectRoot.value = snapshot.projectRoot;
  managedShell.value = snapshot.managedShell;
  index.value = snapshot.index;
  activeView.value = snapshot.activeView;
  selectedId.value = snapshot.selectedId;
  episodeFilter.value = snapshot.episodeFilter;
  statusFilter.value = snapshot.statusFilter;
  linkMode.value = snapshot.linkMode;
  linkSourceId.value = snapshot.linkSourceId;
  // 切换起点已使旧异步读取失效，不能恢复一个再也不会自行清除的旧 loading。
  loading.value = false;
  adaptationWorkspace.value = snapshot.adaptationWorkspace;
  canvasState.value = snapshot.canvasState;
  canvasHistory.value = snapshot.canvasHistory;
}

function assertProjectSwitchCurrent(generation: number, epoch: number): void {
  if (generation !== projectSwitchGeneration || !legacyProjectEpochGate.isEpochCurrent(epoch)) {
    throw new Error("项目切换请求已失效。");
  }
}

async function stageProjectUi(
  next: string,
  refresh: boolean,
  generation: number,
  epoch: number,
): Promise<StagedProjectUi> {
  const shell = await window.canvasApi.getManagedProjectShell(next);
  assertProjectSwitchCurrent(generation, epoch);
  if (shell) {
    return {
      projectRoot: next,
      managedShell: shell,
      index: null,
      episodeFilter: "all",
      adaptationWorkspace: null,
      canvasState: emptyCanvasState(),
      canvasHistory: emptyCanvasHistory(),
    };
  }
  const [nextIndex, nextCanvasState, nextCanvasHistory, nextAdaptationWorkspace] = await Promise.all([
    window.canvasApi.getIndex(next, refresh),
    window.canvasApi.getCanvasSemanticState(next),
    window.canvasApi.getCanvasHistoryInfo(next),
    window.canvasApi.getAdaptationWorkspace(next).catch(() => null),
  ]);
  assertProjectSwitchCurrent(generation, epoch);
  if (nextIndex.project.primaryRoot !== next) {
    throw new Error(`待切换项目索引根与目标不一致：${nextIndex.project.primaryRoot}`);
  }
  let nextEpisodeFilter = "all";
  if (nextIndex.summary.total > 200) {
    const firstEpisode = nextIndex.items.find((item) => item.type === "unit" && item.episode)?.episode;
    if (firstEpisode) nextEpisodeFilter = String(firstEpisode);
  }
  return {
    projectRoot: next,
    managedShell: null,
    index: nextIndex,
    episodeFilter: nextEpisodeFilter,
    adaptationWorkspace: nextAdaptationWorkspace,
    canvasState: nextCanvasState,
    canvasHistory: nextCanvasHistory,
  };
}

function commitProjectUi(staged: StagedProjectUi, generation: number, epoch: number): void {
  assertProjectSwitchCurrent(generation, epoch);
  projectRoot.value = staged.projectRoot;
  managedShell.value = staged.managedShell;
  index.value = staged.index;
  adaptationWorkspace.value = staged.adaptationWorkspace;
  canvasState.value = staged.canvasState;
  canvasHistory.value = staged.canvasHistory;
  nodes.value = [];
  edges.value = [];
  selectedId.value = null;
  episodeFilter.value = staged.episodeFilter;
  statusFilter.value = "all";
  linkMode.value = false;
  linkSourceId.value = "";
  activeView.value = staged.managedShell ? "studio" : "canvas";
  loading.value = false;
}

function restoreProjectCenterFocus(): void {
  const target = projectCenterReturnFocus;
  projectCenterReturnFocus = null;
  void nextTick(() => {
    if (target?.isConnected) target.focus({ preventScroll: true });
  });
}

function hideProjectCenter(): void {
  showProjectCenter.value = false;
  restoreProjectCenterFocus();
}

function openProjectCenter() {
  if (projectOperationBusy.value) return;
  projectCenterReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  showProjectCenter.value = true;
  void refreshProjects().catch((error) => showMessage(error instanceof Error ? error.message : String(error), true));
}

function closeProjectCenter(): void {
  if (projectOperationBusy.value) return;
  hideProjectCenter();
}

const PROJECT_LIST_TIMEOUT_MS = 10_000;
const PROJECT_SOURCE_VERIFY_TIMEOUT_MS = 60_000;
const projectListRefreshController = createProjectListRefreshController({
  fetchProjects: (options) => window.canvasApi.listProjects(options),
  cancelFetch: (requestId) => window.canvasApi.cancelProjectListRequest(requestId),
  applyProjects: (nextProjects) => {
    projects.value = nextProjects;
  },
  setRefreshing: (refreshing) => {
    projectsRefreshing.value = refreshing;
  },
  listTimeoutMs: PROJECT_LIST_TIMEOUT_MS,
  verifyTimeoutMs: PROJECT_SOURCE_VERIFY_TIMEOUT_MS,
  setTimer: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
  clearTimer: (timer) => window.clearTimeout(timer as number),
});

function requestProjectList(): Promise<ListedProjectSummary[]> {
  return projectListRefreshController.requestList();
}

async function refreshProjects(): Promise<void> {
  await requestProjectList();
}

async function verifyProjectSource(sourceProjectRoot: string): Promise<void> {
  try {
    const verifiedProjects = await projectListRefreshController.verifySource(sourceProjectRoot);
    const verified = verifiedProjects.find((project) => project.primaryRoot === sourceProjectRoot)
      ?.localCreativeImport?.contentImport;
    if (!verified?.sourceCheckedAt
      || (verified.sourceSnapshot !== "current" && verified.sourceSnapshot !== "stale")) {
      throw new Error(verified?.sourceVerificationError
        ? `来源核验失败：${verified.sourceVerificationError}`
        : "所选项目未取得可验证的内容 SHA 结果；已保留“来源待核验”状态。");
    }
    showMessage(verified.sourceSnapshot === "current"
      ? "所选项目来源内容 SHA 核验通过。"
      : "核验完成：所选项目来源已变化，请先同步内容。", verified.sourceSnapshot === "stale");
  } catch (error) {
    showMessage(error instanceof Error ? error.message : String(error), true);
  }
}

async function openMostRecentProject() {
  if (projectOperationBusy.value) return;
  try {
    const activeProject = await window.canvasApi.getActiveProject();
    const registeredProjects = projects.value.length ? projects.value : await requestProjectList();
    const recent = activeProject?.available
      ? activeProject
      : [...registeredProjects]
        .filter((project) => project.available)
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
    if (!recent) {
      showMessage("没有可用的最近工程。", true);
      return;
    }
    await openProject(recent.primaryRoot, false);
  } catch (error) {
    showMessage(error instanceof Error ? error.message : String(error), true);
  }
}

async function chooseManagedParentRoot() {
  if (projectOperationBusy.value) return;
  const picked = await window.canvasApi.pickManagedProjectsParent(defaultManagedParentRoot.value);
  if (picked && !projectOperationBusy.value) defaultManagedParentRoot.value = picked;
}

async function importProject() {
  if (projectOperationBusy.value) return;
  const next = await window.canvasApi.pickProject("选择 AI 漫剧项目主根");
  if (!next || projectOperationBusy.value) return;
  importRoot.value = next;
  hideProjectCenter();
  showImportWizard.value = true;
}

async function createNewManagedProject(input: { parentRoot: string; name: string; slug?: string }) {
  if (creatingManagedProject.value) return;
  creatingManagedProject.value = true;
  try {
    const shell = await window.canvasApi.createManagedStudioProject(input);
    const opened = await openProject(shell.paths.root, false);
    if (opened) showMessage(`受管素材工程已建立：${shell.project.name}；未扫描或导入任何旧工程。`);
    else await refreshProjects().catch(() => undefined);
  } catch (error) {
    showMessage(error instanceof Error ? error.message : String(error), true);
  } finally {
    creatingManagedProject.value = false;
  }
}

async function openRestoredProject(restoredRoot: string) {
  if (await openProject(restoredRoot, false)) showMessage("备份已恢复到新目录并作为当前工程打开。");
}

async function persistStudioContext(context: { mode: string; unitId?: string; panelId?: string }) {
  if (!projectRoot.value || !managedShell.value) return;
  const mode = context.mode === "generation" ? "dashboard"
    : context.mode === "agent" || context.mode === "help" ? "canvas"
      : context.mode;
  if (!["canvas", "dashboard", "library", "binding", "continuity-review"].includes(mode)) return;
  await window.canvasApi.setActiveStudioContext(projectRoot.value, {
    mode: mode as "canvas" | "dashboard" | "library" | "binding" | "continuity-review",
    focus: {
      ...(context.unitId ? { unitId: context.unitId } : {}),
      ...(context.panelId ? { panelId: context.panelId } : {}),
    },
  }).catch((reason) => showMessage(reason instanceof Error ? reason.message : String(reason), true));
}

async function onProjectDrop(event: DragEvent) {
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  const next = window.canvasApi.getPathForFile(file);
  if (!next) { showMessage("无法读取拖入目录的本地路径", true); return; }
  importRoot.value = next;
  showImportWizard.value = true;
}

function closeImportWizard() { showImportWizard.value = false; importRoot.value = ""; }

async function onProjectImported(imported: ProjectIndex) {
  closeImportWizard();
  if (await openProject(imported.project.primaryRoot, false)) {
    showMessage(`项目已接入：${imported.summary.total} 个 15 秒单元`);
  }
}

async function openProject(next: string, refresh = false): Promise<boolean> {
  if (projectSwitching.value) {
    showMessage("已有项目切换正在进行，请稍候。", true);
    return false;
  }
  if (projectRemovingRoot.value) {
    showMessage("正在移除项目登记，请稍候。", true);
    return false;
  }
  const targetRoot = next.trim();
  if (!targetRoot) {
    showMessage("项目路径不能为空。", true);
    return false;
  }
  const generation = ++projectSwitchGeneration;
  const snapshot = captureProjectUiSnapshot();
  const previousWatcherIdentity = activeLegacyWatcherIdentity;
  const invalidated = invalidateLegacyProjectAsyncState();
  const epoch = invalidated.epoch;
  const cancelOldScan = cancelInvalidatedLegacyScan(invalidated.activeScan);
  let activeProjectBefore: Awaited<ReturnType<typeof window.canvasApi.getActiveProject>> | null = null;
  let watchTransitionAttempted = false;
  let targetWatcherIdentity: Awaited<ReturnType<typeof window.canvasApi.startWatch>> | null = null;
  let restoredWatcherIdentity: Awaited<ReturnType<typeof window.canvasApi.startWatch>> | null = null;
  let rebuildToken: LegacyProjectEpochToken | null = null;
  projectSwitching.value = true;
  try {
    [activeProjectBefore] = await Promise.all([
      window.canvasApi.getActiveProject(),
      cancelOldScan,
    ]);
    assertProjectSwitchCurrent(generation, epoch);
    const staged = await stageProjectUi(targetRoot, refresh, generation, epoch);
    assertProjectSwitchCurrent(generation, epoch);

    // 主进程只有一个监听 owner；新监听会先替换旧监听，失败分支必须恢复旧 root。
    watchTransitionAttempted = true;
    targetWatcherIdentity = await window.canvasApi.startWatch(targetRoot);
    assertProjectSwitchCurrent(generation, epoch);
    await window.canvasApi.activateProject(targetRoot);
    assertProjectSwitchCurrent(generation, epoch);

    // 只有 shell/index、监听和活动登记均成功后，才一次性提交渲染状态。
    commitProjectUi(staged, generation, epoch);
    activeLegacyWatcherIdentity = targetWatcherIdentity;
    hideProjectCenter();
    if (!staged.managedShell) rebuildToken = captureLegacyProjectToken(targetRoot);
    void refreshProjects().catch((error) => showMessage(error instanceof Error ? error.message : String(error), true));
    return true;
  } catch (error) {
    const rollbackFailures: string[] = [];
    let restoredPreviousWatch = false;
    if (watchTransitionAttempted) {
      await window.canvasApi.stopWatch(targetRoot).catch((reason) => rollbackFailures.push(`停止新监听失败：${reason instanceof Error ? reason.message : String(reason)}`));
      if (generation === projectSwitchGeneration
        && legacyProjectEpochGate.isEpochCurrent(epoch)
        && snapshot.projectRoot) {
        await window.canvasApi.startWatch(snapshot.projectRoot)
          .then((identity) => {
            restoredPreviousWatch = true;
            restoredWatcherIdentity = identity;
          })
          .catch((reason) => rollbackFailures.push(`恢复旧监听失败：${reason instanceof Error ? reason.message : String(reason)}`));
      }
    }
    if (generation !== projectSwitchGeneration || !legacyProjectEpochGate.isEpochCurrent(epoch)) {
      if (restoredPreviousWatch) await window.canvasApi.stopWatch(snapshot.projectRoot).catch(() => undefined);
      return false;
    }
    if (activeProjectBefore?.available && activeProjectBefore.primaryRoot !== targetRoot) {
      await window.canvasApi.activateProject(activeProjectBefore.primaryRoot).catch((reason) => rollbackFailures.push(`恢复活动登记失败：${reason instanceof Error ? reason.message : String(reason)}`));
    }
    if (generation !== projectSwitchGeneration || !legacyProjectEpochGate.isEpochCurrent(epoch)) {
      if (restoredPreviousWatch) await window.canvasApi.stopWatch(snapshot.projectRoot).catch(() => undefined);
      return false;
    }
    restoreProjectUiSnapshot(snapshot);
    activeLegacyWatcherIdentity = watchTransitionAttempted
      ? restoredWatcherIdentity
      : previousWatcherIdentity;
    if (snapshot.projectRoot && !snapshot.managedShell) {
      rebuildToken = captureLegacyProjectToken(snapshot.projectRoot);
    }
    const reason = error instanceof Error ? error.message : String(error);
    showMessage(`项目切换失败，已保留原工程：${reason}${rollbackFailures.length ? `；${rollbackFailures.join("；")}` : ""}`, true);
    return false;
  } finally {
    if (generation === projectSwitchGeneration && legacyProjectEpochGate.isEpochCurrent(epoch)) {
      projectSwitching.value = false;
      if (rebuildToken && isLegacyProjectTokenCurrent(rebuildToken)) {
        const tokenToRebuild = rebuildToken;
        void nextTick()
          .then(() => rebuildFlow(tokenToRebuild))
          .catch((error) => {
            if (isLegacyProjectTokenCurrent(tokenToRebuild)) {
              showMessage(error instanceof Error ? error.message : String(error), true);
            }
          });
      }
    }
  }
}

async function removeProject(root: string) {
  if (projectOperationBusy.value) return;
  const targetRoot = root.trim();
  if (!targetRoot) return;
  const removingCurrent = projectRoot.value === targetRoot;
  const previousWatcherIdentity = removingCurrent ? activeLegacyWatcherIdentity : null;
  projectRemovingRoot.value = targetRoot;
  const invalidated = removingCurrent ? invalidateLegacyProjectAsyncState() : null;
  const scope: FrozenProjectRemovalScope = {
    token: projectRemovalGate.begin(targetRoot, targetRoot),
    targetRoot,
    removingCurrent,
    ...(invalidated ? { legacyEpoch: invalidated.epoch } : {}),
  };
  let watchTransitionAttempted = false;
  try {
    if (invalidated) {
      await cancelInvalidatedLegacyScan(invalidated.activeScan);
      if (!projectRemovalIsCurrent(scope)) return;
    }
    if (removingCurrent) {
      watchTransitionAttempted = true;
      await window.canvasApi.stopWatch(targetRoot);
      if (!projectRemovalIsCurrent(scope)) return;
    }
    await window.canvasApi.removeProject(targetRoot);
    if (!projectRemovalIsCurrent(scope)) return;
    if (removingCurrent) {
      projectRoot.value = "";
      managedShell.value = null;
      index.value = null;
      adaptationWorkspace.value = null;
      canvasState.value = emptyCanvasState();
      canvasHistory.value = emptyCanvasHistory();
      nodes.value = [];
      edges.value = [];
      selectedId.value = null;
      loading.value = false;
    }
    let refreshFailure = "";
    try {
      await refreshProjects();
    } catch (error) {
      refreshFailure = error instanceof Error ? error.message : String(error);
    }
    if (!projectRemovalOwnsOperation(scope)) return;
    showMessage(
      refreshFailure
        ? `项目登记已移除，但清单刷新失败：${refreshFailure}`
        : "已移除项目登记，未删除任何素材",
      Boolean(refreshFailure),
    );
  } catch (error) {
    if (!projectRemovalIsCurrent(scope)) return;
    let restoreFailure = "";
    if (removingCurrent && watchTransitionAttempted) {
      const restoredIdentity = await window.canvasApi.startWatch(targetRoot).catch((reason) => {
        restoreFailure = reason instanceof Error ? reason.message : String(reason);
        return null;
      });
      if (!projectRemovalIsCurrent(scope)) {
        if (restoredIdentity) await window.canvasApi.stopWatch(targetRoot).catch(() => undefined);
        return;
      }
      activeLegacyWatcherIdentity = restoredIdentity;
    } else if (removingCurrent) {
      activeLegacyWatcherIdentity = previousWatcherIdentity;
    }
    if (removingCurrent) {
      const token = captureLegacyProjectToken(targetRoot);
      if (token && isLegacyProjectTokenCurrent(token)) void rebuildFlow(token);
    }
    if (projectRemovalIsCurrent(scope)) {
      const reason = error instanceof Error ? error.message : String(error);
      showMessage(`${reason}${restoreFailure ? `；恢复项目监听失败：${restoreFailure}` : ""}`, true);
    }
  } finally {
    if (projectRemovalOwnsOperation(scope)) {
      projectRemovingRoot.value = "";
      projectRemovalGate.invalidate();
    }
  }
}

function onTaskCreated(taskId: string) {
  showMessage(`任务包已创建：${taskId}`);
  activeView.value = "tasks";
}

function onShotsQueued(count: number) {
  showMessage(`${count} 个原镜头已加入图片生成队列`);
  activeView.value = "generation";
}

async function openContinuityUnit(payload: { unitItemId: string; episode: number }) {
  const target = index.value?.items.find((item) => item.id === payload.unitItemId && item.type === "unit");
  if (!target) {
    showMessage(`连续性跨度引用的单元不存在：${payload.unitItemId}`, true);
    return;
  }
  search.value = "";
  statusFilter.value = "all";
  showShots.value = false;
  episodeFilter.value = String(payload.episode);
  selectedId.value = payload.unitItemId;
  activeView.value = "canvas";
  await nextTick();
  await rebuildFlow();
  if (!await focusCanvasNode(payload.unitItemId)) {
    showMessage(`已切到 EP${String(payload.episode).padStart(2, "0")}，但未能定位单元节点`, true);
    return;
  }
  showMessage(`已定位 ${target.title}`);
}

async function onDocumentChanged(messageText: string) {
  if (await loadIndex()) showMessage(messageText);
}

async function onWorkspaceUpdated(messageText: string) {
  if (await loadIndex()) showMessage(messageText);
}

async function onReviewUpdated(messageText: string) {
  if (await loadIndex()) showMessage(messageText);
}

function openItemInList(itemId: string) {
  selectedId.value = itemId;
  activeView.value = "shots";
}

/** LumenX TaskQueue jump：item → 镜头列表 focus；unit/panel → 素材中心绑定/画布 */
function onGenerationQueueJump(payload: {
  kind: string;
  targetId: string;
  jobId: string;
  unitId?: string;
  panelId?: string;
}) {
  if (payload.kind === "item" && payload.targetId) {
    openItemInList(payload.targetId);
    showMessage(`已跳转到镜头项 ${payload.targetId}`);
    return;
  }
  if ((payload.kind === "unit" || payload.kind === "panel") && payload.targetId) {
    const unitId = payload.unitId || (payload.kind === "unit" ? payload.targetId : undefined);
    const panelId = payload.panelId || (payload.kind === "panel" ? payload.targetId : undefined);
    generationJumpFocus.value = {
      unitId,
      panelId,
      jobId: payload.jobId,
    };
    if (managedShell.value) {
      studioModeRequest.value = {
        mode: "binding",
        unitId,
        panelId,
        token: Date.now(),
      };
    } else {
      activeView.value = "studio";
    }
    showMessage(`已跳转并 focus ${payload.kind}:${payload.targetId}`);
    return;
  }
  showMessage(`队列任务 ${payload.jobId} 无可用跳转目标`, true);
}

async function onConfigSaved() {
  const token = captureLegacyProjectToken();
  if (!token || !await loadIndex(false, token)) return;
  await refreshProjects();
  if (isLegacyProjectTokenCurrent(token)) showMessage("项目设置已保存并重新扫描");
}

/** 布局位置缓存：loadLayout IPC 按 projectRoot::viewKey 只取一次（P18 实测：缩放重建时每次都有一次 IPC）。 */
async function ensureLayoutPositions(
  token: LegacyProjectEpochToken,
  frozenViewKey: string,
): Promise<boolean> {
  if (!isLegacyProjectTokenCurrent(token)) return false;
  const key = `${token.root}::${frozenViewKey}`;
  if (key === layoutPositionsKey) return true;
  const loaded = await window.canvasApi.loadLayout(token.root, frozenViewKey).catch(() => null);
  if (!isLegacyProjectTokenCurrent(token) || viewKey.value !== frozenViewKey) return false;
  // IPC 失败不写缓存不记键：下一次 rebuild 重试，而不是整段会话丢失已存坐标（审核轻#3）。
  if (loaded === null) return false;
  layoutPositions.value = loaded;
  layoutPositionsKey = key;
  return true;
}

/** 持久化布局位置并同步缓存，保证下一次 rebuildFlow 读到最新坐标。 */
async function persistLayoutPositions(
  positions: Record<string, { x: number; y: number }>,
  expectedToken?: LegacyProjectEpochToken,
): Promise<boolean> {
  if (projectSwitching.value || projectRemovingRoot.value) return false;
  const token = expectedToken ?? captureLegacyProjectToken();
  if (!token || !isLegacyProjectTokenCurrent(token)) return false;
  const frozenViewKey = viewKey.value;
  const key = `${token.root}::${frozenViewKey}`;
  // 先并入缓存：拖拽存盘的 IPC 窗口内若触发 rebuild，也能读到新坐标而不是弹回旧坐标（审核轻#1）。
  if (layoutPositionsKey === key) {
    layoutPositions.value = { ...layoutPositions.value, ...positions };
  }
  try {
    await window.canvasApi.saveLayout(token.root, frozenViewKey, positions);
    return isLegacyProjectTokenCurrent(token);
  } catch (error) {
    if (isLegacyProjectTokenCurrent(token)) throw error;
    return false;
  }
}

async function rebuildFlow(expectedToken?: LegacyProjectEpochToken) {
  if (projectSwitching.value) return;
  const token = expectedToken ?? captureLegacyProjectToken();
  if (!token || !isLegacyProjectTokenCurrent(token)) return;
  const frozenViewKey = viewKey.value;
  const generation = ++layoutGeneration;
  const items = visibleItems.value;
  if (!await ensureLayoutPositions(token, frozenViewKey)) return;
  if (generation !== layoutGeneration
    || !isLegacyProjectTokenCurrent(token)
    || viewKey.value !== frozenViewKey
    || layoutPositionsKey !== `${token.root}::${frozenViewKey}`) return;
  const saved: Record<string, { x: number; y: number }> = layoutPositions.value;
  const narrativeOffset = showNarrative.value ? 1_120 : 0;
  const stageItems = Object.fromEntries(STAGES.map((stage) => [stage, items.filter((item) => item.stage === stage)])) as Record<WorkItem["stage"], WorkItem[]>;
  const maxRows = Math.max(3, ...STAGES.map((stage) => stageItems[stage].length), showNarrative.value ? adaptationWorkspace.value?.beats.length ?? 0 : 0);
  const laneHeight = Math.max(600, maxRows * 250 + 120);
  const nextNodes: Node[] = STAGES.map((stage, stageIndex) => ({
    id: `zone-${stage}`,
    type: "zone",
    position: { x: STAGE_X[stage] + narrativeOffset, y: 0 },
    data: { title: stage, count: stageItems[stage].length, index: `0${stageIndex + 1}`, height: laneHeight },
    draggable: false,
    selectable: false,
    connectable: false,
    zIndex: -1,
    style: { width: "320px", height: `${laneHeight}px` },
  }));
  const groupByMember = new Map<string, CanvasEntity>();
  canvasState.value.entities.filter((entity) => entity.kind === "group").forEach((group) => group.memberIds.forEach((memberId) => {
    if (!groupByMember.has(memberId)) groupByMember.set(memberId, group);
  }));
  for (const entity of [...canvasState.value.entities].sort((a, b) => Number(a.kind === "note") - Number(b.kind === "note") || a.createdAt.localeCompare(b.createdAt))) {
    nextNodes.push({
      id: entity.id,
      type: entity.kind,
      position: entity.position,
      data: { entity, onEdit: editCanvasEntity, onDelete: removeCanvasEntity },
      dragHandle: ".canvas-entity-handle",
      zIndex: entity.kind === "group" ? 0 : 4,
      style: { width: `${entity.width}px`, height: `${entity.height}px` },
    });
  }
  const narrativeEdges: Edge[] = [];
  if (showNarrative.value && adaptationWorkspace.value) {
    const workspace = adaptationWorkspace.value;
    const eventFacts = workspace.facts.filter((fact) => fact.kind === "event").sort((a, b) => (a.sourceSpans[0]?.startOffset ?? 0) - (b.sourceSpans[0]?.startOffset ?? 0));
    const sourceIds = [...new Set(eventFacts.map((fact) => fact.sourceSpans[0]?.sourceId).filter((value): value is string => Boolean(value)))];
    sourceIds.forEach((sourceId, row) => nextNodes.push({ id: `narrative-source-${sourceId}`, type: "narrative", position: { x: 0, y: 72 + row * 150 }, data: { kind: "source", title: `原文 ${row + 1}`, detail: sourceId, meta: `${eventFacts.filter((fact) => fact.sourceSpans[0]?.sourceId === sourceId).length} 个可视事件`, compact: zoom.value < .35 }, draggable: false, zIndex: 2 }));
    eventFacts.forEach((fact, row) => {
      const nodeId = `narrative-fact-${fact.id}`;
      nextNodes.push({ id: nodeId, type: "narrative", position: { x: 280, y: 72 + row * 150 }, data: { kind: "fact", title: fact.statement.slice(0, 72), detail: fact.epistemicStatus === "confirmed" ? "原文确认" : fact.epistemicStatus === "inferred" ? "明确推断" : "待确认", meta: `${fact.id} · R${fact.revision}`, compact: zoom.value < .35 }, draggable: false, zIndex: 2 });
      const sourceId = fact.sourceSpans[0]?.sourceId;
      if (sourceId) narrativeEdges.push({ id: `source-${sourceId}-${fact.id}`, source: `narrative-source-${sourceId}`, target: nodeId, type: "smoothstep", style: { stroke: "#666a61", strokeWidth: 1.2 } });
    });
    workspace.beats.forEach((beat, row) => {
      const nodeId = `narrative-beat-${beat.id}`;
      nextNodes.push({ id: nodeId, type: "narrative", position: { x: 560, y: 72 + row * 150 }, data: { kind: "beat", title: `${String(beat.order).padStart(2, "0")} · ${beat.title.slice(0, 58)}`, detail: beat.narrativePurpose, meta: `${beat.estimatedDurationSeconds.toFixed(1)}s · 强度 ${beat.intensity}/5`, compact: zoom.value < .35 }, draggable: false, zIndex: 2 });
      beat.factIds.filter((factId) => eventFacts.some((fact) => fact.id === factId)).forEach((factId) => narrativeEdges.push({ id: `fact-${factId}-${beat.id}`, source: `narrative-fact-${factId}`, target: nodeId, type: "smoothstep", style: { stroke: "#667d65", strokeWidth: 1.3 } }));
    });
    workspace.plans.slice(0, 2).forEach((plan, row) => {
      const nodeId = `narrative-plan-${plan.id}`;
      nextNodes.push({ id: nodeId, type: "narrative", position: { x: 840, y: 72 + row * 190 }, data: { kind: "plan", title: plan.mode === "concise" ? "精简模式" : "拆分模式", detail: `${plan.units.length} 个 15 秒单元 · ${plan.units.reduce((sum, unit) => sum + unit.storyboardRows.length, 0)} 镜`, meta: `${plan.status} · ${plan.validation.hardErrors.length} 硬错误`, compact: zoom.value < .35 }, draggable: false, zIndex: 2 });
      const beatIds = new Set(plan.units.flatMap((unit) => unit.beatIds));
      beatIds.forEach((beatId) => narrativeEdges.push({ id: `beat-${beatId}-${plan.id}`, source: `narrative-beat-${beatId}`, target: nodeId, type: "smoothstep", style: { stroke: "#9a7a35", strokeWidth: 1.4 } }));
      for (const itemId of new Set(plan.units.flatMap((unit) => unit.storyboardRows.map((storyboard) => storyboard.itemId)).filter((id) => !id.startsWith("planned:")))) if (items.some((item) => item.id === itemId)) narrativeEdges.push({ id: `plan-${plan.id}-${itemId}`, source: nodeId, target: itemId, type: "smoothstep", animated: plan.status === "selected", style: { stroke: "#d7af55", strokeWidth: 2 } });
    });
  }
  for (const stage of STAGES) {
    stageItems[stage]
      .sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0) || (a.unit ?? 0) - (b.unit ?? 0) || a.id.localeCompare(b.id))
      .forEach((item, row) => {
        const artifacts = item.artifactIds.map((id) => artifactMap.value.get(id)).filter((artifact): artifact is Artifact => Boolean(artifact));
        const globalPosition = saved[item.id] ?? { x: STAGE_X[stage] + narrativeOffset + 20, y: 72 + row * 250 };
        const parentGroup = groupByMember.get(item.id);
        const memberOffset = parentGroup?.memberOffsets[item.id] ?? (parentGroup ? { x: globalPosition.x - parentGroup.position.x, y: globalPosition.y - parentGroup.position.y } : undefined);
        nextNodes.push({
          id: item.id,
          type: "production",
          position: memberOffset ?? globalPosition,
          parentNode: parentGroup?.id,
          data: {
            item,
            artifacts,
            compact: zoom.value < 0.35,
            videoCount: artifacts.filter((artifact) => artifact.kind === "video" && !artifact.deprecated).length,
          },
          dragHandle: ".node-header",
          zIndex: 2,
        });
      });
  }
  const visibleIds = new Set(items.map((item) => item.id));
  const nodeIds = new Set([...visibleIds, ...canvasState.value.entities.map((entity) => entity.id)]);
  const dependencyEdges: Edge[] = items.flatMap((item) =>
    item.dependencies
      .filter((dependency) => visibleIds.has(dependency))
      .map((dependency) => ({
        id: `${dependency}-${item.id}`,
        source: dependency,
        target: item.id,
        type: "smoothstep",
        animated: item.status === "视频生成中",
        style: { stroke: item.status === "已完成" ? "#6d7f62" : "#6c6758", strokeWidth: 1.5 },
      })),
  );
  const linkColors: Record<CanvasLinkKind, string> = { continuity: "#d7af55", reference: "#70a7c5", dependency: "#d36b59", comment: "#b98fdf" };
  const semanticEdges: Edge[] = canvasState.value.links
    .filter((link) => nodeIds.has(link.sourceId) && nodeIds.has(link.targetId))
    .map((link) => ({
      id: link.id,
      source: link.sourceId,
      target: link.targetId,
      type: "smoothstep",
      label: link.label || ({ continuity: "连续性", reference: "参考", dependency: "依赖", comment: "说明" } as const)[link.kind],
      zIndex: 3,
      style: { stroke: linkColors[link.kind], strokeWidth: 2, strokeDasharray: link.kind === "dependency" ? undefined : "6 4" },
      labelStyle: { fill: linkColors[link.kind], fontSize: 9 },
      labelBgStyle: { fill: "#151613", fillOpacity: 0.92 },
    }));
  if (generation !== layoutGeneration
    || !isLegacyProjectTokenCurrent(token)
    || viewKey.value !== frozenViewKey) return;
  nodes.value = nextNodes;
  edges.value = [...narrativeEdges, ...dependencyEdges, ...semanticEdges];
  await nextTick();
}

function onNodeClick(event: { node: Node }) {
  if (linkMode.value && event.node.type !== "zone") {
    void chooseLinkEndpoint(event.node.id);
    return;
  }
  if (event.node.type === "narrative") { activeView.value = "adaptation"; return; }
  if (event.node.type !== "production") return;
  selectedId.value = event.node.id;
}

function onNodeDragStop(event: NodeDragEvent) {
  if (event.node.type === "note" || event.node.type === "group") {
    void saveCanvasEntityMove(event.node.id, event.node.position);
    return;
  }
  if (event.node.type !== "production") return;
  const parentNode = (event.node as Node & { parentNode?: string }).parentNode;
  if (parentNode) {
    void saveGroupMemberOffset(parentNode, event.node.id, event.node.position);
    return;
  }
  void persistLayoutPositions({ [event.node.id]: { x: event.node.position.x, y: event.node.position.y } });
}

function onMove(event: { flowTransform?: { zoom?: number }; zoom?: number }) {
  const nextZoom = event.flowTransform?.zoom ?? event.zoom;
  const transform = event.flowTransform as { x?: number; y?: number; zoom?: number } | undefined;
  if (transform) canvasViewport.value = { x: transform.x ?? canvasViewport.value.x, y: transform.y ?? canvasViewport.value.y, zoom: transform.zoom ?? canvasViewport.value.zoom };
  if (typeof nextZoom === "number" && Math.abs(nextZoom - zoom.value) > 0.04) zoom.value = nextZoom;
}

function canvasCenter(kind: CanvasEntityKind) {
  const bounds = canvasWrap.value?.getBoundingClientRect();
  const viewport = canvasViewport.value;
  const width = kind === "group" ? 720 : 280;
  const height = kind === "group" ? 420 : 190;
  return {
    x: Math.round((((bounds?.width ?? 900) / 2 - viewport.x) / viewport.zoom) - width / 2),
    y: Math.round((((bounds?.height ?? 700) / 2 - viewport.y) / viewport.zoom) - height / 2),
  };
}

function createCanvasEntity(kind: CanvasEntityKind) {
  canvasEditor.value = {
    kind,
    title: kind === "note" ? "新导演批注" : "新制作分组",
    body: "",
    color: "gold",
    position: canvasCenter(kind),
    width: kind === "group" ? 720 : 280,
    height: kind === "group" ? 420 : 190,
    memberOffsets: {},
    memberText: "",
  };
}

function editCanvasEntity(entity: CanvasEntity) {
  canvasEditor.value = { ...entity, position: { ...entity.position }, memberOffsets: { ...entity.memberOffsets }, memberText: entity.memberIds.join("\n") };
}

async function saveCanvasEntity() {
  if (projectSwitching.value || projectRemovingRoot.value) return;
  const token = captureLegacyProjectToken();
  if (!canvasEditor.value || !token || !isLegacyProjectTokenCurrent(token)) return;
  const draft: CanvasEditorDraft = {
    ...canvasEditor.value,
    position: { ...canvasEditor.value.position },
    memberOffsets: { ...canvasEditor.value.memberOffsets },
  };
  savingCanvasEntity.value = true;
  try {
    const memberIds = draft.memberText.split(/[\n,，]+/).map((value) => value.trim()).filter(Boolean);
    const previous = draft.id ? canvasState.value.entities.find((entity) => entity.id === draft.id) : undefined;
    const memberOffsets: Record<string, CanvasPosition> = {};
    memberIds.forEach((id, index) => {
      const node = nodes.value.find((candidate) => candidate.id === id) as (Node & { parentNode?: string }) | undefined;
      if (node) {
        memberOffsets[id] = node.parentNode === draft.id
          ? { x: node.position.x, y: node.position.y }
          : { x: node.position.x - draft.position.x, y: node.position.y - draft.position.y };
      } else if (previous?.memberOffsets[id]) memberOffsets[id] = previous.memberOffsets[id]!;
      else memberOffsets[id] = { x: 30 + (index % 3) * 300, y: 70 + Math.floor(index / 3) * 250 };
    });
    const removedMembers = (previous?.memberIds ?? []).filter((id) => !memberIds.includes(id));
    if (removedMembers.length) {
      const releasedPositions = Object.fromEntries(removedMembers.flatMap((id) => {
        const offset = previous?.memberOffsets[id];
        return offset ? [[id, { x: previous!.position.x + offset.x, y: previous!.position.y + offset.y }]] : [];
      }));
      if (Object.keys(releasedPositions).length
        && !await persistLayoutPositions(releasedPositions, token)) return;
    }
    if (!isLegacyProjectTokenCurrent(token)) return;
    const result = await window.canvasApi.upsertCanvasEntity(token.root, {
      id: draft.id,
      kind: draft.kind,
      title: draft.title,
      body: draft.body,
      color: draft.color as CanvasEntityColor,
      position: draft.position,
      width: draft.width,
      height: draft.height,
      memberIds,
      memberOffsets,
    });
    if (!isLegacyProjectTokenCurrent(token)) return;
    canvasState.value = result.state;
    canvasEditor.value = null;
    if (!await refreshCanvasHistory(token)) return;
    await rebuildFlow(token);
    if (!isLegacyProjectTokenCurrent(token)) return;
    showMessage(`${result.entity.kind === "note" ? "批注" : "分组"}已写入画布侧车`);
  } catch (error) {
    if (isLegacyProjectTokenCurrent(token)) showMessage(error instanceof Error ? error.message : String(error), true);
  } finally {
    if (isLegacyProjectTokenCurrent(token)) savingCanvasEntity.value = false;
  }
}

async function saveCanvasEntityMove(id: string, position: { x: number; y: number }) {
  if (projectSwitching.value || projectRemovingRoot.value) return;
  const token = captureLegacyProjectToken();
  if (!token || !isLegacyProjectTokenCurrent(token)) return;
  try {
    const nextState = await window.canvasApi.moveCanvasEntities(token.root, {
      [id]: { x: position.x, y: position.y },
    });
    if (!isLegacyProjectTokenCurrent(token)) return;
    canvasState.value = nextState;
    await refreshCanvasHistory(token);
  } catch (error) {
    if (isLegacyProjectTokenCurrent(token)) showMessage(error instanceof Error ? error.message : String(error), true);
  }
}

async function saveGroupMemberOffset(groupId: string, memberId: string, position: { x: number; y: number }) {
  if (projectSwitching.value || projectRemovingRoot.value) return;
  const token = captureLegacyProjectToken();
  if (!token || !isLegacyProjectTokenCurrent(token)) return;
  const group = canvasState.value.entities.find((entity) => entity.id === groupId && entity.kind === "group");
  if (!group) return;
  try {
    const result = await window.canvasApi.upsertCanvasEntity(token.root, {
      ...group,
      position: { ...group.position },
      memberIds: [...group.memberIds],
      memberOffsets: { ...group.memberOffsets, [memberId]: { x: position.x, y: position.y } },
    });
    if (!isLegacyProjectTokenCurrent(token)) return;
    canvasState.value = result.state;
    await refreshCanvasHistory(token);
  } catch (error) {
    if (isLegacyProjectTokenCurrent(token)) showMessage(error instanceof Error ? error.message : String(error), true);
  }
}

async function removeCanvasEntity(id: string) {
  if (projectSwitching.value || projectRemovingRoot.value) return;
  const token = captureLegacyProjectToken();
  if (!token || !isLegacyProjectTokenCurrent(token)) return;
  const entity = canvasState.value.entities.find((candidate) => candidate.id === id);
  if (!entity || !window.confirm(`删除画布${entity.kind === "note" ? "批注" : "分组"}“${entity.title}”？\n不会删除任何素材文件。`)) return;
  try {
    if (entity.kind === "group") {
      const releasedPositions = Object.fromEntries(entity.memberIds.flatMap((memberId) => {
        const offset = entity.memberOffsets[memberId];
        return offset ? [[memberId, { x: entity.position.x + offset.x, y: entity.position.y + offset.y }]] : [];
      }));
      if (Object.keys(releasedPositions).length
        && !await persistLayoutPositions(releasedPositions, token)) return;
    }
    if (!isLegacyProjectTokenCurrent(token)) return;
    const nextState = await window.canvasApi.deleteCanvasEntity(token.root, id);
    if (!isLegacyProjectTokenCurrent(token)) return;
    canvasState.value = nextState;
    if (!await refreshCanvasHistory(token)) return;
    await rebuildFlow(token);
    if (!isLegacyProjectTokenCurrent(token)) return;
    showMessage("画布实体已删除，素材文件未改动");
  } catch (error) {
    if (isLegacyProjectTokenCurrent(token)) showMessage(error instanceof Error ? error.message : String(error), true);
  }
}

function toggleLinkMode() {
  linkMode.value = !linkMode.value;
  linkSourceId.value = "";
}

async function chooseLinkEndpoint(nodeId: string) {
  if (projectSwitching.value || projectRemovingRoot.value) return;
  if (!linkSourceId.value) {
    linkSourceId.value = nodeId;
    showMessage("已选择关系线起点，请点击目标节点");
    return;
  }
  if (linkSourceId.value === nodeId) {
    showMessage("关系线起点和目标不能相同", true);
    return;
  }
  const token = captureLegacyProjectToken();
  if (!token || !isLegacyProjectTokenCurrent(token)) return;
  const sourceId = linkSourceId.value;
  const kind = linkKind.value;
  try {
    const labels: Record<CanvasLinkKind, string> = { continuity: "人工连续性", reference: "人工参考", dependency: "人工依赖", comment: "人工说明" };
    const result = await window.canvasApi.upsertCanvasLink(token.root, {
      sourceId,
      targetId: nodeId,
      kind,
      label: labels[kind],
    });
    if (!isLegacyProjectTokenCurrent(token)) return;
    canvasState.value = result.state;
    if (!await refreshCanvasHistory(token)) return;
    linkSourceId.value = "";
    linkMode.value = false;
    await rebuildFlow(token);
    if (!isLegacyProjectTokenCurrent(token)) return;
    showMessage("人工关系线已写入画布侧车");
  } catch (error) {
    if (isLegacyProjectTokenCurrent(token)) showMessage(error instanceof Error ? error.message : String(error), true);
  }
}

async function onEdgeClick(event: { edge: Edge }) {
  if (projectSwitching.value || projectRemovingRoot.value) return;
  const token = captureLegacyProjectToken();
  if (!token || !isLegacyProjectTokenCurrent(token)) return;
  const link = canvasState.value.links.find((candidate) => candidate.id === event.edge.id);
  if (!link) return;
  if (!window.confirm(`删除关系线“${link.label || link.kind}”？\n不会修改生产节点或素材文件。`)) return;
  try {
    const nextState = await window.canvasApi.deleteCanvasLink(token.root, link.id);
    if (!isLegacyProjectTokenCurrent(token)) return;
    canvasState.value = nextState;
    if (!await refreshCanvasHistory(token)) return;
    await rebuildFlow(token);
    if (!isLegacyProjectTokenCurrent(token)) return;
    showMessage("人工关系线已删除");
  } catch (error) {
    if (isLegacyProjectTokenCurrent(token)) showMessage(error instanceof Error ? error.message : String(error), true);
  }
}

async function refreshCanvasHistory(expectedToken?: LegacyProjectEpochToken): Promise<boolean> {
  const token = expectedToken ?? captureLegacyProjectToken();
  if (!token || !isLegacyProjectTokenCurrent(token)) return false;
  const nextHistory = await window.canvasApi.getCanvasHistoryInfo(token.root);
  if (!isLegacyProjectTokenCurrent(token)) return false;
  canvasHistory.value = nextHistory;
  return true;
}

async function undoCanvas() {
  if (projectSwitching.value || projectRemovingRoot.value) return;
  const token = captureLegacyProjectToken();
  if (!token || !isLegacyProjectTokenCurrent(token) || !canvasHistory.value.canUndo) return;
  try {
    const result = await window.canvasApi.undoCanvasSemanticState(token.root);
    if (!isLegacyProjectTokenCurrent(token)) return;
    canvasState.value = result.state;
    canvasHistory.value = result.history;
    await rebuildFlow(token);
    if (!isLegacyProjectTokenCurrent(token)) return;
    showMessage("已撤销上一项画布操作");
  } catch (error) {
    if (isLegacyProjectTokenCurrent(token)) showMessage(error instanceof Error ? error.message : String(error), true);
  }
}

async function redoCanvas() {
  if (projectSwitching.value || projectRemovingRoot.value) return;
  const token = captureLegacyProjectToken();
  if (!token || !isLegacyProjectTokenCurrent(token) || !canvasHistory.value.canRedo) return;
  try {
    const result = await window.canvasApi.redoCanvasSemanticState(token.root);
    if (!isLegacyProjectTokenCurrent(token)) return;
    canvasState.value = result.state;
    canvasHistory.value = result.history;
    await rebuildFlow(token);
    if (!isLegacyProjectTokenCurrent(token)) return;
    showMessage("已重做画布操作");
  } catch (error) {
    if (isLegacyProjectTokenCurrent(token)) showMessage(error instanceof Error ? error.message : String(error), true);
  }
}

function onCanvasShortcut(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  // P23：受管壳下旧语义画布 undo（正式业务数据）一律早退，杜绝与布局 undo 的跨域双撤销。
  if (!projectRoot.value || managedShell.value || activeView.value !== "canvas" || target?.matches("input,textarea,select,[contenteditable='true']")) return;
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
  event.preventDefault();
  if (event.shiftKey) void redoCanvas();
  else void undoCanvas();
}

function showMessage(text: string, error = false) {
  message.value = text;
  messageIsError.value = error;
  if (messageTimer) clearTimeout(messageTimer);
  messageTimer = setTimeout(() => (message.value = ""), 3_500);
}
</script>

<style scoped>
.root-runtime-gate{position:fixed;inset:0;z-index:400;display:grid;place-items:center;padding:28px;background:#090a08;color:#ebe9df}.root-runtime-gate>div{width:min(560px,calc(100vw - 56px));padding:30px;border:1px solid #765f2d;background:#15150f;box-shadow:0 28px 90px rgba(0,0,0,.72)}.root-runtime-gate svg{color:#d7af55}.root-runtime-gate h2{margin:12px 0 8px;font-size:22px}.root-runtime-gate p{margin:0;color:#b9b6a8;line-height:1.7}.root-runtime-gate small{display:block;margin-top:14px;color:#817a67;font:10px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-word}
.managed-project-operation-shield{position:fixed;inset:0;z-index:260;display:grid;place-items:center;padding:24px;background:rgba(5,6,4,.82);backdrop-filter:blur(7px)}.managed-project-operation-shield>div{width:min(460px,calc(100vw - 48px));display:grid;grid-template-columns:auto 1fr;gap:8px 12px;align-items:center;padding:22px;border:1px solid #6d5b32;background:#15140e;box-shadow:0 26px 80px rgba(0,0,0,.58);color:#d7af55}.managed-project-operation-shield svg{grid-row:1/4}.managed-project-operation-shield strong,.managed-project-operation-shield span,.managed-project-operation-shield small{min-width:0;display:block}.managed-project-operation-shield strong{font-size:13px}.managed-project-operation-shield span{color:#aaa58f;font-size:10px}.managed-project-operation-shield small{overflow:hidden;color:#6f7167;font:8px ui-monospace,SFMono-Regular,Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}
.canvas-toolbox button:disabled { color: #45473f; cursor: default; }
.canvas-toolbox button:disabled:hover { background: transparent; color: #45473f; }
.canvas-toolbox { position: absolute; top: 13px; left: 13px; z-index: 12; display: flex; align-items: center; gap: 1px; border: 1px solid #34362f; background: rgba(21,22,19,.94); box-shadow: 0 10px 26px rgba(0,0,0,.3); backdrop-filter: blur(10px); }.canvas-toolbox button { height: 32px; display: flex; align-items: center; gap: 6px; padding: 0 9px; border: 0; border-right: 1px solid #34362f; background: transparent; color: #9a9d92; font-size: 8px; cursor: pointer; }.canvas-toolbox button:hover,.canvas-toolbox button.active { background: #29271f; color: #d7af55; }.canvas-toolbox select { height: 26px; margin: 0 5px; border: 1px solid #3b3d35; background: #191a17; color: #bbb; font-size: 8px; }.link-mode-hint { position: absolute; top: 54px; left: 13px; z-index: 12; display: flex; align-items: center; gap: 7px; max-width: 470px; padding: 8px 10px; border: 1px solid #67572f; background: rgba(38,33,20,.94); color: #e1c16b; font-size: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.28); }
.canvas-editor-overlay { position: fixed; inset: 0; z-index: 230; display: grid; place-items: center; background: rgba(5,6,4,.76); backdrop-filter: blur(8px); }.canvas-editor-dialog { width: min(620px,calc(100vw - 80px)); max-height: calc(100vh - 70px); overflow: auto; border: 1px solid #3c3e36; background: #171815; box-shadow: 0 28px 90px rgba(0,0,0,.58); }.canvas-editor-dialog > header { height: 72px; display: flex; align-items: center; justify-content: space-between; padding: 0 20px; border-bottom: 1px solid #30322c; }.canvas-editor-dialog h2 { margin: 7px 0 0; font-size: 16px; }.canvas-editor-form { padding: 18px 20px; }.canvas-editor-form label { display: grid; grid-template-columns: 110px 1fr; align-items: start; gap: 12px; margin-top: 11px; color: #8f9287; font-size: 9px; }.canvas-editor-form input,.canvas-editor-form select,.canvas-editor-form textarea { width: 100%; border: 1px solid #35372f; outline: 0; background: #121310; color: #e8e8e1; padding: 8px 9px; }.canvas-editor-form textarea { resize: vertical; line-height: 1.6; }.canvas-editor-form input:focus,.canvas-editor-form select:focus,.canvas-editor-form textarea:focus { border-color: #66572f; }.canvas-editor-grid { display: grid; grid-template-columns: 1.25fr 1fr 1fr; gap: 9px; margin-top: 11px; }.canvas-editor-grid label { display: block; margin: 0; }.canvas-editor-grid label span { display: block; margin-bottom: 6px; }.canvas-editor-dialog > footer { height: 58px; display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 0 20px; border-top: 1px solid #30322c; background: #151613; }
</style>
