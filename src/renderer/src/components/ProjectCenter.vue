<template>
  <div class="project-overlay" @click.self="requestClose" @keydown.esc.stop.prevent="requestClose">
    <section
      ref="dialogElement"
      class="project-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-center-title"
      aria-describedby="project-center-description"
      :aria-busy="busy"
      data-testid="project-center-dialog"
      @keydown.tab="trapFocus"
      tabindex="-1">
      <header>
        <div><span class="eyebrow">项目中心</span><h2 id="project-center-title">本地项目</h2><p id="project-center-description">新工程与旧工程完全隔离；移除登记不会删除任何素材或侧车。</p></div>
        <button class="icon-button" type="button" data-testid="project-center-close" :disabled="busy" aria-label="关闭项目中心" @click="requestClose"><X :size="18" aria-hidden="true" /></button>
      </header>

      <p v-if="busy" class="project-busy" role="status" aria-live="polite">
        <LoaderCircle :size="15" class="spinning" aria-hidden="true" />{{ busyLabel }}，请稍候…
      </p>
      <p v-else-if="discardConfirmationArmed" class="project-warning" role="alert">
        工程名称尚未建立。再次关闭将放弃这次输入。
      </p>

      <div class="project-list-toolbar">
        <label class="project-search">
          <Search :size="14" aria-hidden="true" />
          <input
            v-model="projectSearch"
            type="search"
            placeholder="搜索项目名称或文件夹"
            aria-label="搜索项目名称或文件夹" />
        </label>
        <span>{{ availableProjectCount }} 个可用</span>
        <button
          type="button"
          :disabled="busy || refreshing"
          data-testid="project-center-refresh-sources"
          @click="emit('refresh')">
          {{ refreshing ? "刷新中…" : "刷新清单" }}
        </button>
        <button
          v-if="unavailableProjectCount"
          type="button"
          :aria-expanded="showUnavailableProjects"
          @click="showUnavailableProjects = !showUnavailableProjects">
          {{ showUnavailableProjects || projectSearch.trim() ? "收起" : "显示" }} {{ unavailableProjectCount }} 个失效登记
        </button>
      </div>

      <div class="project-list">
        <div
          v-for="project in visibleProjects"
          :key="project.primaryRoot"
          class="project-row"
          :class="{ current: project.primaryRoot === currentRoot, unavailable: !project.available }">
          <button
            type="button"
            class="project-open"
            :disabled="busy || !project.available"
            :aria-current="project.primaryRoot === currentRoot ? 'true' : undefined"
            @click="requestOpen(project.primaryRoot)">
            <span class="project-symbol"><FolderKanban :size="18" aria-hidden="true" /></span>
            <span class="project-copy">
              <b>{{ project.name }}</b>
              <small>文件夹：{{ displayFolderName(project.primaryRoot) }}</small>
              <em v-if="project.localCreativeImport" class="local-import-summary">
                本机项目 · {{ project.localCreativeImport.indexedFiles }} 文件 ·
                锁记录 {{ project.localCreativeImport.approvedLocks }} / 候选记录 {{ project.localCreativeImport.candidateLocks }}
              </em>
              <em
                v-if="project.localCreativeImport"
                class="local-import-content-summary"
                :class="`status-${project.localCreativeImport.contentImport.status}`">
                {{ localContentImportStatusLabel(project.localCreativeImport.contentImport.status) }} ·
                媒体来源 {{ project.localCreativeImport.contentImport.processedMedia }}/{{ project.localCreativeImport.contentImport.eligibleMedia }} ·
                文档 {{ project.localCreativeImport.contentImport.importedDocuments }}/{{ project.localCreativeImport.contentImport.sourceDocuments || "?" }} ·
                pending 资产 {{ project.localCreativeImport.contentImport.pendingAssets }}
                <strong v-if="project.localCreativeImport.contentImport.sourceSnapshot === 'stale'">源目录已变化</strong>
                <strong
                  v-else-if="project.localCreativeImport.contentImport.sourceSnapshot === 'unknown'"
                  :title="project.localCreativeImport.contentImport.sourceVerificationError">
                  {{ project.localCreativeImport.contentImport.sourceVerificationError ? "来源核验失败" : "来源待核验" }}
                </strong>
              </em>
              <em v-if="!project.available">文件夹暂不可用，登记已保留</em>
            </span>
            <span v-if="project.primaryRoot === currentRoot" class="current-label">当前</span>
          </button>
          <button
            v-if="project.available && project.localCreativeImport"
            type="button"
            class="row-action"
            :disabled="busy || refreshing"
            :aria-label="`核验 ${project.name} 的来源`"
            @click="emit('verifySource', project.primaryRoot)">
            <ShieldCheck :size="15" aria-hidden="true" />
            <span>核验来源</span>
          </button>
          <button
            type="button"
            class="row-action"
            :class="{ confirming: removeConfirmationRoot === project.primaryRoot }"
            :disabled="busy"
            :aria-label="removeConfirmationRoot === project.primaryRoot ? `确认只移除 ${project.name} 的登记` : `移除 ${project.name} 的登记`"
            :aria-pressed="removeConfirmationRoot === project.primaryRoot"
            @click="requestRemove(project.primaryRoot)">
            <Trash2 :size="15" aria-hidden="true" />
            <span>{{ removeConfirmationRoot === project.primaryRoot ? "确认移除" : "移除" }}</span>
          </button>
        </div>
        <div v-if="!visibleProjects.length" class="project-empty">
          {{ projectSearch.trim() ? "没有匹配的项目" : "尚未登记项目" }}
        </div>
      </div>

      <section class="dudu-recovery" data-testid="dudu-readonly-recovery">
        <header>
          <div><span class="eyebrow">《嘟嘟》安全续作</span><h3>隔离工程只读恢复</h3></div>
          <button type="button" :disabled="busy || duduDiscoveryLoading || !defaultParentRoot" @click="refreshDuduDiscovery">
            <LoaderCircle v-if="duduDiscoveryLoading" :size="14" class="spinning" />
            <span>{{ duduDiscoveryLoading ? "核对中" : "重新核对" }}</span>
          </button>
        </header>
        <p>仅核对保存位置下一层的既有 bootstrap claim；不会创建工程、续跑导入、登记、激活或生成图片。</p>
        <p v-if="duduDiscoveryError" class="dudu-recovery-error" role="alert">{{ duduDiscoveryError }}</p>
        <div v-else-if="duduDiscovery?.status === 'none'" class="dudu-recovery-state">
          <b>未发现隔离续作工程</b><span>需由受授权 Core 编排开始新的 staging。</span>
        </div>
        <div v-else-if="duduDiscovery?.status === 'single'" class="dudu-recovery-state ready">
          <b>{{ duduStatusLabel(duduDiscovery.candidates[0]!.controlStatus) }}</b>
          <span>文件夹：{{ duduDiscovery.candidates[0]!.directoryName }} · {{ duduNextActionLabel(duduDiscovery.candidates[0]!.control?.nextAction) }}</span>
        </div>
        <div v-else-if="duduDiscovery?.status === 'conflict'" class="dudu-recovery-state blocked" role="alert">
          <b>发现 {{ duduDiscovery.candidateCount }} 个候选，已停止自动选择</b>
          <span>{{ duduDiscovery.blockers.map(duduBlockerLabel).join("；") }}</span>
        </div>
        <div v-else class="dudu-recovery-state"><b>等待只读核对</b><span>未取得状态前不会推断或继续导入。</span></div>
      </section>

      <form class="managed-create" data-testid="managed-project-create" @submit.prevent="submitManagedProject">
        <div class="create-heading">
          <div><span class="eyebrow">新建受管素材工程</span><h3>从空的故事工程开始</h3></div>
          <span class="mode-label">全新隔离工程</span>
        </div>
        <label class="project-name-field">
          <span>工程名称</span>
          <input v-model="createDraft.name" name="managed-project-name" maxlength="120" placeholder="例如：古蜀卷第三季" :disabled="busy" />
        </label>
        <div class="destination-row">
          <div><span>保存位置</span><b>{{ displayFolderName(createDraft.parentRoot || defaultParentRoot || "AI漫剧项目") }}</b></div>
          <button type="button" :disabled="busy" @click="requestChooseParent">更改位置</button>
        </div>
        <p class="isolation-contract"><ShieldCheck :size="15" /><span><b>固定隔离策略</b>只在所选位置新建独立工程；不会扫描、导入或接管任何既有工程。</span></p>
        <p v-if="createMessage" class="create-message" :class="{ error: !createValidation.valid }" role="status">{{ createMessage }}</p>
        <button class="create-button" type="submit" :disabled="busy || !createValidation.valid">
          <LoaderCircle v-if="creating" :size="15" class="spinning" />
          <FolderPlus v-else :size="15" />
          {{ creating ? "正在建立隔离工程" : switching ? "正在切换工程" : "建立并打开工程" }}
        </button>
      </form>

      <footer>
        <span>已有制作目录仍使用独立预检流程。</span>
        <button class="primary-button" type="button" :disabled="busy" @click="requestImport"><FolderPlus :size="16" /> 导入已有项目</button>
      </footer>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { FolderKanban, FolderPlus, LoaderCircle, Search, ShieldCheck, Trash2, X } from "lucide-vue-next";
import { validateManagedStudioCreateDraft } from "../managed-project-create";
import type { ListedProjectSummary, LocalCreativeImportProjectSummary } from "@core/service";
import type {
  DuduReadonlyImportControl,
  DuduReadonlyImportDiscovery,
} from "@core/dudu-readonly-import";

const props = defineProps<{
  projects: ListedProjectSummary[];
  currentRoot: string;
  creating?: boolean;
  switching?: boolean;
  removingRoot?: string;
  refreshing?: boolean;
  defaultParentRoot?: string;
}>();

const emit = defineEmits<{
  close: [];
  open: [projectRoot: string];
  import: [];
  remove: [projectRoot: string];
  chooseParent: [];
  createManaged: [input: { parentRoot: string; name: string }];
  refresh: [];
  verifySource: [projectRoot: string];
}>();

const createDraft = reactive({ parentRoot: props.defaultParentRoot || "", name: "" });
const submitted = ref(false);
const dialogElement = ref<HTMLElement | null>(null);
const removeConfirmationRoot = ref("");
const discardConfirmationArmed = ref(false);
const projectSearch = ref("");
const showUnavailableProjects = ref(false);
const duduDiscovery = ref<DuduReadonlyImportDiscovery | null>(null);
const duduDiscoveryLoading = ref(false);
const duduDiscoveryError = ref("");
let duduDiscoveryToken = 0;
let sourceRefreshTimer: ReturnType<typeof setInterval> | undefined;
const SOURCE_REFRESH_INTERVAL_MS = 60_000;
const busy = computed(() => Boolean(props.creating || props.switching || props.removingRoot));
const refreshing = computed(() => Boolean(props.refreshing));
const busyLabel = computed(() => props.removingRoot
  ? "正在移除项目登记"
  : props.creating
    ? "正在建立隔离工程"
    : "正在安全切换工程");
const createValidation = computed(() => validateManagedStudioCreateDraft(createDraft));
const createMessage = computed(() => submitted.value ? createValidation.value.message : "");
const normalizedProjectSearch = computed(() => projectSearch.value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN"));
const availableProjectCount = computed(() => props.projects.filter((project) => project.available).length);
const unavailableProjectCount = computed(() => props.projects.length - availableProjectCount.value);
const visibleProjects = computed(() => {
  const query = normalizedProjectSearch.value;
  return [...props.projects]
    .filter((project) => {
      const matches = !query || `${project.name}\n${project.primaryRoot}`.normalize("NFKC").toLocaleLowerCase("zh-CN").includes(query);
      return matches && (project.available || showUnavailableProjects.value || Boolean(query));
    })
    .sort((left, right) => {
      const leftCurrent = left.primaryRoot === props.currentRoot ? 1 : 0;
      const rightCurrent = right.primaryRoot === props.currentRoot ? 1 : 0;
      return rightCurrent - leftCurrent
        || Number(right.available) - Number(left.available)
        || left.name.localeCompare(right.name, "zh-CN");
    });
});

function submitManagedProject(): void {
  if (busy.value) return;
  submitted.value = true;
  const validated = createValidation.value;
  if (!validated.valid || !validated.input) return;
  emit("createManaged", validated.input);
}

function requestClose(): void {
  if (busy.value) return;
  if (createDraft.name.trim() && !discardConfirmationArmed.value) {
    discardConfirmationArmed.value = true;
    return;
  }
  emit("close");
}

function displayFolderName(value: string): string {
  const normalized = value.replace(/[\\/]+$/u, "");
  return normalized.split(/[\\/]/u).at(-1) || "AI漫剧项目";
}

function localContentImportStatusLabel(status: LocalCreativeImportProjectSummary["contentImport"]["status"]): string {
  return ({
    "not-imported": "未导入",
    importing: "导入中",
    "current-complete": "当前完整",
    partial: "按策略部分接入",
    stale: "来源已变化",
    "has-failures": "有失败",
    unverified: "待实时核验",
  } as const)[status];
}

function trapFocus(event: KeyboardEvent): void {
  const dialog = dialogElement.value;
  if (!dialog) return;
  const focusable = [...dialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  )].filter((element) => element.offsetParent !== null);
  if (!focusable.length) {
    event.preventDefault();
    dialog.focus({ preventScroll: true });
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && (document.activeElement === dialog || document.activeElement === first || !dialog.contains(document.activeElement))) {
    event.preventDefault();
    last?.focus({ preventScroll: true });
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus({ preventScroll: true });
  }
}

function requestOpen(root: string): void {
  if (busy.value) return;
  removeConfirmationRoot.value = "";
  emit("open", root);
}

function requestRemove(root: string): void {
  if (busy.value) return;
  if (removeConfirmationRoot.value !== root) {
    removeConfirmationRoot.value = root;
    return;
  }
  removeConfirmationRoot.value = "";
  emit("remove", root);
}

function requestChooseParent(): void {
  if (!busy.value) emit("chooseParent");
}

function requestImport(): void {
  if (!busy.value) emit("import");
}

function duduStatusLabel(status: DuduReadonlyImportDiscovery["candidates"][number]["controlStatus"]): string {
  return ({
    "staging-incomplete": "staging 尚未闭合",
    "staging-verified": "staging 已机械核验",
    "registration-incomplete": "登记收据未闭合",
    "registered-not-active": "已登记但不是活动工程",
    "activation-incomplete": "活动收据未闭合",
    active: "隔离工程已活动",
    unreadable: "候选身份不可读",
  } as const)[status];
}

function duduNextActionLabel(action?: DuduReadonlyImportControl["nextAction"]): string {
  if (action === "ready") return "可从已登记项目列表继续";
  if (action === "finalize-registration-and-activation-via-authorized-core-orchestration") return "等待受授权 Core 完成登记与激活";
  if (action === "resume-finalization-via-authorized-core-orchestration") return "等待受授权 Core 恢复收尾";
  return "等待受授权 Core 恢复 staging";
}

function duduBlockerLabel(blocker: DuduReadonlyImportDiscovery["blockers"][number]): string {
  return blocker === "multiple-dudu-staging-candidates" ? "存在多个隔离候选" : "至少一个候选身份不可读";
}

async function refreshDuduDiscovery(): Promise<void> {
  const projectsRoot = props.defaultParentRoot?.trim();
  const token = ++duduDiscoveryToken;
  duduDiscovery.value = null;
  duduDiscoveryError.value = "";
  if (!projectsRoot) return;
  duduDiscoveryLoading.value = true;
  try {
    const result = await window.canvasApi.discoverDuduReadonlyImportProjects(projectsRoot);
    // 切保存位置或连续重新核对时，迟到响应不得覆盖新状态。
    if (token !== duduDiscoveryToken || projectsRoot !== props.defaultParentRoot?.trim()) return;
    duduDiscovery.value = result;
  } catch (reason) {
    if (token !== duduDiscoveryToken || projectsRoot !== props.defaultParentRoot?.trim()) return;
    duduDiscoveryError.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    if (token === duduDiscoveryToken) duduDiscoveryLoading.value = false;
  }
}

onMounted(async () => {
  await nextTick();
  dialogElement.value?.focus({ preventScroll: true });
  // 定时动作只刷新落盘项目摘要，不遍历来源树；精确内容 SHA 只由单项目
  // “核验来源”按钮触发，避免后台轮询持续争抢磁盘。
  sourceRefreshTimer = setInterval(() => emit("refresh"), SOURCE_REFRESH_INTERVAL_MS);
});

onBeforeUnmount(() => {
  // 卸载后到达的 discovery 响应一律丢弃。
  duduDiscoveryToken += 1;
  if (sourceRefreshTimer) clearInterval(sourceRefreshTimer);
});

watch(() => props.defaultParentRoot, (value) => {
  if (value?.trim()) createDraft.parentRoot = value.trim();
  void refreshDuduDiscovery();
}, { immediate: true });

watch(() => createDraft.name, () => {
  discardConfirmationArmed.value = false;
});

watch(() => props.projects, () => {
  if (!props.projects.some((project) => project.primaryRoot === removeConfirmationRoot.value)) {
    removeConfirmationRoot.value = "";
  }
}, { deep: true });

watch(busy, (value) => {
  if (value) removeConfirmationRoot.value = "";
});
</script>

<style scoped>
.project-overlay { position: fixed; inset: 0; z-index: 200; display: grid; place-items: center; background: rgba(18, 19, 15, 0.48); backdrop-filter: blur(8px); }
.project-center { width: min(760px, calc(100vw - 80px)); max-height: min(880px, calc(100vh - 48px)); overflow: auto; border: 1px solid var(--ui-line); border-radius: var(--ui-radius-panel); outline: 0; background: var(--ui-surface); color: var(--ui-text); box-shadow: var(--ui-shadow-pop); }
header { display: flex; justify-content: space-between; gap: 20px; padding: 24px; border-bottom: 1px solid var(--ui-line); }
h2 { margin: 8px 0 4px; font-size: 19px; font-weight: 650; }
p { margin: 0; color: var(--ui-text-2); font-size: 12px; }
.project-busy,.project-warning{display:flex;align-items:center;gap:8px;margin:0;padding:10px 24px;border-bottom:1px solid var(--ui-line);background:var(--ui-accent-soft);color:var(--ui-accent-strong);font-size:12px}.project-warning{background:var(--ui-surface-2);color:var(--ui-danger)}
.project-list-toolbar{display:flex;align-items:center;gap:10px;padding:10px 24px;border-bottom:1px solid var(--ui-line);background:var(--ui-bg)}.project-list-toolbar>span{flex:0 0 auto;color:var(--ui-text-3);font-size:10px}.project-list-toolbar>button{flex:0 0 auto;min-height:30px;padding:0 9px;border:1px solid var(--ui-line);border-radius:var(--ui-radius-ctl);background:var(--ui-surface);color:var(--ui-text-2);font-size:10px;cursor:pointer}.project-list-toolbar>button:hover{border-color:var(--ui-accent);color:var(--ui-accent)}.project-search{min-width:0;flex:1;display:flex;align-items:center;gap:7px;height:32px;padding:0 10px;border:1px solid var(--ui-line);border-radius:var(--ui-radius-ctl);background:var(--ui-surface);color:var(--ui-text-3)}.project-search:focus-within{border-color:var(--ui-accent);box-shadow:var(--ui-focus-ring)}.project-search input{min-width:0;flex:1;border:0;outline:0;background:transparent;color:var(--ui-text);font-size:11px}
.project-list { max-height: 280px; overflow-y: auto; padding: 10px 24px; }
.project-row { width: 100%; display: flex; align-items: stretch; border-bottom: 1px solid var(--ui-line); background: transparent; }
.project-row:hover { background: var(--ui-surface-2); }
.project-row.current { color: var(--ui-accent); }
.project-row.unavailable .project-open{cursor:not-allowed;opacity:.58}.project-row.unavailable:hover{background:var(--ui-surface-2)}
.project-open{min-width:0;flex:1;display:flex;align-items:center;gap:13px;padding:13px 0;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer}.project-open:disabled{cursor:not-allowed}.project-open:focus-visible,.row-action:focus-visible{outline:0;box-shadow:var(--ui-focus-ring)}
.project-symbol { width: 36px; height: 36px; display: grid; place-items: center; border: 1px solid var(--ui-line); border-radius: var(--ui-radius-ctl); color: var(--ui-accent); }
.project-copy { min-width: 0; flex: 1; }
.project-copy b, .project-copy small { display: block; }
.project-copy b { font-size: 13px; color: var(--ui-text); }
.project-copy small { margin-top: 5px; color: var(--ui-text-3); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.project-copy em{display:block;margin-top:5px;color:var(--ui-accent-strong);font-size:10px;font-style:normal}.project-copy em.local-import-summary{color:var(--ui-ok)}.local-import-content-summary{color:var(--ui-text-3)}.local-import-content-summary.status-importing{color:var(--ui-accent-strong)}.local-import-content-summary.status-current-complete{color:var(--ui-ok)}.local-import-content-summary.status-partial,.local-import-content-summary.status-unverified{color:var(--ui-accent-strong)}.local-import-content-summary.status-stale,.local-import-content-summary.status-has-failures{color:var(--ui-danger)}.local-import-content-summary strong{display:inline-block;margin-left:5px;color:var(--ui-accent-strong);font-weight:650}
.current-label { color: var(--ui-accent); font-size: 10px; font-weight: 650; }
.row-action { flex:0 0 76px;display:flex;align-items:center;justify-content:center;gap:5px;margin:8px 0;padding:0 7px;border:0;border-left:1px solid var(--ui-line);background:transparent;color:var(--ui-text-3);font-size:11px;cursor:pointer }
.row-action:hover,.row-action.confirming { color: var(--ui-danger); background:var(--ui-surface-2) }
.row-action:disabled{cursor:not-allowed;opacity:.42}
.project-empty { padding: 70px 0; color: var(--ui-text-3); text-align: center; font-size: 12px; }
.dudu-recovery{margin:0 24px 18px;border:1px solid var(--ui-line);border-radius:var(--ui-radius-panel);background:var(--ui-surface-2)}.dudu-recovery>header{align-items:center;padding:13px 14px;border-bottom:1px solid var(--ui-line)}.dudu-recovery h3{margin:5px 0 0;font-size:13px}.dudu-recovery>header button{display:flex;align-items:center;gap:5px;min-height:30px;padding:0 9px;border:1px solid var(--ui-line);border-radius:var(--ui-radius-ctl);background:transparent;color:var(--ui-accent);cursor:pointer}.dudu-recovery>header button:disabled{opacity:.45;cursor:not-allowed}.dudu-recovery>p{padding:10px 14px;font-size:10px;line-height:1.5}.dudu-recovery-state{display:grid;gap:4px;padding:10px 14px;border-top:1px solid var(--ui-line)}.dudu-recovery-state b{font-size:11px}.dudu-recovery-state span{color:var(--ui-text-3);font-size:10px}.dudu-recovery-state.ready b{color:var(--ui-ok)}.dudu-recovery-state.blocked b,.dudu-recovery-error{color:var(--ui-danger)}.dudu-recovery-error{border-top:1px solid var(--ui-line)}
.managed-create{padding:18px 24px;border-top:1px solid var(--ui-line);background:var(--ui-bg)}.create-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.create-heading h3{margin:6px 0 0;font-size:15px;font-weight:650}.mode-label{padding:4px 7px;border:1px solid var(--ui-accent);border-radius:999px;color:var(--ui-accent);font:10px var(--ui-font-mono)}.managed-create>label{display:block;margin-top:13px}.managed-create label>span{display:block;margin-bottom:6px;color:var(--ui-text-2);font-size:12px}.managed-create input{width:100%;height:40px;box-sizing:border-box;padding:0 12px;border:1px solid var(--ui-line);border-radius:var(--ui-radius-ctl);outline:0;background:var(--ui-surface);color:var(--ui-text);font-size:13px}.managed-create input:focus{border-color:var(--ui-accent);box-shadow:var(--ui-focus-ring)}.destination-row{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:11px;padding:10px 12px;border:1px solid var(--ui-line);border-radius:var(--ui-radius-ctl);background:var(--ui-surface)}.destination-row div{min-width:0}.destination-row span,.destination-row b{display:block}.destination-row span{color:var(--ui-text-3);font-size:10px}.destination-row b{margin-top:4px;overflow:hidden;color:var(--ui-text-2);font:11px var(--ui-font-mono);text-overflow:ellipsis;white-space:nowrap}.destination-row button{flex:0 0 auto;min-height:30px;padding:0 10px;border:1px solid var(--ui-line);border-radius:var(--ui-radius-ctl);background:transparent;color:var(--ui-accent);font-size:11px;cursor:pointer}.destination-row button:hover{border-color:var(--ui-accent)}.isolation-contract{display:flex;gap:8px;margin-top:13px;padding:10px;border-left:2px solid var(--ui-accent);background:var(--ui-accent-soft);color:var(--ui-text-2);font-size:12px;line-height:1.55}.isolation-contract svg{flex:0 0 auto;color:var(--ui-accent)}.isolation-contract b{display:block;color:var(--ui-text);font-size:12px}.create-message{margin-top:10px;color:var(--ui-ok);font-size:12px}.create-message.error{color:var(--ui-danger)}.create-button{width:100%;height:40px;margin-top:12px;display:flex;align-items:center;justify-content:center;gap:7px;border:1px solid var(--ui-accent);border-radius:var(--ui-radius-ctl);background:var(--ui-accent);color:var(--ui-accent-contrast);font-size:13px;font-weight:650;cursor:pointer}.create-button:hover:not(:disabled){background:var(--ui-accent-strong);border-color:var(--ui-accent-strong)}.create-button:disabled{cursor:not-allowed;opacity:.45}.spinning{animation:project-spin .8s linear infinite}@keyframes project-spin{to{transform:rotate(360deg)}}
footer { display: flex; align-items:center; justify-content:space-between; gap:20px; padding: 14px 24px; border-top: 1px solid var(--ui-line); }footer>span{color:var(--ui-text-3);font-size:11px}
footer .primary-button{background:var(--ui-accent);border-color:var(--ui-accent);color:var(--ui-accent-contrast);border-radius:var(--ui-radius-ctl)}footer .primary-button:hover:not(:disabled){background:var(--ui-accent-strong);border-color:var(--ui-accent-strong)}
.icon-button{border-color:var(--ui-line);border-radius:var(--ui-radius-ctl);color:var(--ui-text-2)}.icon-button:hover{background:var(--ui-surface-2);color:var(--ui-text)}
</style>
