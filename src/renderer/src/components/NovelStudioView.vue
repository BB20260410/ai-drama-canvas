<template>
  <section class="novel-studio" data-testid="novel-studio-view" :aria-busy="busy || loading">
    <header class="novel-header">
      <div class="project-identity">
        <span>AI 漫剧画布 · 小说</span>
        <h1>{{ project.projectName }}</h1>
        <p>{{ totalCharacters.toLocaleString("zh-CN") }} 字 · {{ totalChapterCount.toLocaleString("zh-CN") }} 章 · 本地文件</p>
      </div>

      <nav v-if="project.workspaceMode === 'hybrid'" class="workspace-switch" data-testid="novel-workspace-switch">
        <button type="button" class="active" aria-current="page" data-testid="novel-switch-novel">小说创作</button>
        <button type="button" data-testid="novel-switch-drama" @click="emit('switch-workspace', 'drama')">短剧制作</button>
      </nav>

      <div class="header-actions">
        <button type="button" :disabled="busy" data-testid="novel-import-file" @click="importNovel('file')">
          <FileInput :size="15" />导入文件
        </button>
        <button type="button" :disabled="busy" data-testid="novel-import-directory" @click="importNovel('directory')">
          <FolderInput :size="15" />导入目录
        </button>
        <button type="button" :disabled="busy" data-testid="novel-backup" @click="backupProject">
          <Archive :size="15" />备份
        </button>
        <button type="button" :disabled="busy" data-testid="novel-restore" @click="restoreProject">
          <History :size="15" />恢复
        </button>
        <button type="button" data-testid="novel-open-project-center" @click="emit('open-project-center')">
          <FolderKanban :size="15" />项目
        </button>
      </div>
    </header>

    <div v-if="notice || error" class="notice" :class="{ error: Boolean(error) }" role="status" data-testid="novel-notice">
      <CircleAlert v-if="error" :size="16" />
      <CheckCircle2 v-else :size="16" />
      <span>{{ error || notice }}</span>
      <button type="button" aria-label="关闭提示" @click="clearNotice">×</button>
    </div>

    <div class="workspace-body">
      <aside class="chapter-rail" data-testid="novel-chapter-rail">
        <label class="search-box">
          <Search :size="15" />
          <input v-model="searchQuery" data-testid="novel-search-input" aria-label="搜索小说全部正文" placeholder="搜索全部正文" @keyup.enter="searchAllChapters" />
          <button type="button" :disabled="searching || searchQuery.trim().length < 2" data-testid="novel-search-submit" @click="searchAllChapters">
            {{ searching ? "…" : "搜索" }}
          </button>
        </label>

        <div v-if="searchResults.length || searchCompleted" class="search-results" data-testid="novel-search-results">
          <header><b>搜索结果</b><button type="button" @click="clearSearch">关闭</button></header>
          <button
            v-for="result in searchResults"
            :key="`${result.chapter.chapterId}:${result.start}`"
            type="button"
            @click="openSearchResult(result)">
            <strong>{{ result.chapter.title }}</strong>
            <span>{{ result.snippet }}</span>
          </button>
          <p v-if="searchCompleted && !searchResults.length">没有找到“{{ searchQuery.trim() }}”</p>
        </div>

        <div class="rail-heading">
          <span>卷章</span>
          <small>{{ totalChapterCount.toLocaleString("zh-CN") }}</small>
        </div>

        <div v-if="uninitialized" class="empty-rail">
          <p>正文库尚未初始化。</p>
          <button type="button" class="primary" data-testid="novel-initialize" :disabled="busy" @click="initializeManuscript">初始化正文库</button>
        </div>

        <div v-else class="volume-list">
          <section v-for="volume in sortedVolumes" :key="volume.volumeId" class="volume-section">
            <header>
              <button
                type="button"
                class="volume-toggle"
                :class="{ active: activeVolumeId === volume.volumeId }"
                :disabled="busy"
                @click="selectVolume(volume.volumeId)">
                <span>{{ volume.title }}</span>
                <small>{{ volume.chapterCount.toLocaleString("zh-CN") }} 章</small>
              </button>
            </header>
            <template v-if="activeVolumeId === volume.volumeId">
              <button
                v-for="chapter in chapters"
                :key="chapter.chapterId"
                type="button"
                :disabled="busy"
                :class="{ active: activeChapter?.chapterId === chapter.chapterId }"
                :data-chapter-id="chapter.chapterId"
                @click="openChapter(chapter)">
                <span>{{ chapter.title }}</span>
                <small>{{ chapter.charCount.toLocaleString("zh-CN") }}</small>
              </button>
              <div v-if="chapterPageTotal > chapterPageLimit" class="rail-pagination" data-testid="novel-chapter-pagination">
                <button type="button" :disabled="busy || chapterPageOffset === 0" @click="changeChapterPage(-1)">上一页</button>
                <small>{{ chapterPageStart }}–{{ chapterPageEnd }} / {{ chapterPageTotal }}</small>
                <button type="button" :disabled="busy || chapterPageEnd >= chapterPageTotal" @click="changeChapterPage(1)">下一页</button>
              </div>
              <form class="inline-create" @submit.prevent="createChapter(volume.volumeId)">
                <input v-model="newChapterTitles[volume.volumeId]" :placeholder="`在${volume.title}新建章节`" maxlength="200" />
                <button type="submit" :disabled="busy || !newChapterTitles[volume.volumeId]?.trim()" title="新建章节">+</button>
              </form>
            </template>
          </section>
          <div v-if="volumePageTotal > volumePageLimit" class="rail-pagination volume-pagination" data-testid="novel-volume-pagination">
            <button type="button" :disabled="busy || volumePageOffset === 0" @click="changeVolumePage(-1)">上一批卷</button>
            <small>{{ volumePageStart }}–{{ volumePageEnd }} / {{ volumePageTotal }}</small>
            <button type="button" :disabled="busy || volumePageEnd >= volumePageTotal" @click="changeVolumePage(1)">下一批卷</button>
          </div>
        </div>

        <form v-if="!uninitialized" class="new-volume" @submit.prevent="createVolume">
          <input v-model="newVolumeTitle" placeholder="新建卷" maxlength="200" />
          <button type="submit" :disabled="busy || !newVolumeTitle.trim()">添加</button>
        </form>
      </aside>

      <main class="editor-workspace" data-testid="novel-editor-workspace">
        <div v-if="uninitialized" class="editor-empty">
          <BookOpenText :size="38" />
          <h2>先初始化正文库，或从上方导入现有小说</h2>
          <p>导入会创建受管副本，原始 TXT、Markdown、DOCX 和目录保持不变。</p>
        </div>
        <div v-else-if="!activeChapter" class="editor-empty">
          <BookOpenText :size="38" />
          <h2>选择或新建一个章节</h2>
          <p>正文按章保存，不会把百万字一次塞进同一个编辑器。</p>
        </div>
        <template v-else>
          <header class="editor-toolbar">
            <div>
              <span>{{ activeVolumeTitle }}</span>
              <h2>{{ activeChapter.title }}</h2>
              <small>修订 r{{ activeChapter.revision }} · 每次保存自动保留历史快照</small>
            </div>
            <div class="editor-actions">
              <button type="button" :disabled="busy" @click="renameActiveChapter"><PencilLine :size="14" />改名</button>
              <button type="button" class="primary" data-testid="novel-save-chapter" :disabled="busy || !dirty" @click="saveActiveChapter">
                <Save :size="15" />{{ busy ? "处理中" : dirty ? "保存" : "已保存" }}
              </button>
            </div>
          </header>
          <textarea
            ref="editorRef"
            v-model="editorContent"
            data-testid="novel-chapter-editor"
            spellcheck="false"
            @select="captureSelection"
            @keyup="captureSelection"
            @mouseup="captureSelection" />
          <footer class="editor-footer">
            <span>{{ editorContent.length.toLocaleString("zh-CN") }} 字符</span>
            <span :class="{ changed: dirty }">{{ dirty ? "有未保存修改" : "已写入本地文件" }}</span>
            <span>正文事实需经 Story Bible 候选与人工裁决后进入写作上下文</span>
          </footer>
        </template>
      </main>

      <aside class="memory-rail writing-os-rail" data-testid="novel-memory-rail">
        <header class="writing-os-header">
          <div>
            <span>Writing OS 控制台</span>
            <button type="button" title="刷新 Writing OS" data-testid="novel-writing-dashboard-refresh" :disabled="dashboardLoading" @click="refreshWritingDashboard">
              <RefreshCw :size="13" :class="{ spinning: dashboardLoading }" />
            </button>
          </div>
          <p>正典、章末状态与写后探针共用同一受管真相。</p>
          <nav class="writing-os-tabs" aria-label="Writing OS 面板">
            <button type="button" :class="{ active: railTab === 'status' }" data-testid="novel-writing-tab-status" @click="railTab = 'status'">总控</button>
            <button type="button" :class="{ active: railTab === 'candidates' }" data-testid="novel-writing-tab-candidates" @click="railTab = 'candidates'">
              候选 <b v-if="pendingCandidates.length">{{ pendingCandidates.length }}</b>
            </button>
            <button type="button" :class="{ active: railTab === 'memory' }" data-testid="novel-writing-tab-memory" @click="railTab = 'memory'">记忆</button>
          </nav>
        </header>

        <section v-if="railTab === 'status'" class="writing-dashboard" data-testid="novel-writing-dashboard">
          <p v-if="dashboardLoading && !writingDashboard" class="dashboard-placeholder">正在复验 Writing OS…</p>
          <p v-else-if="dashboardError" class="dashboard-error">{{ dashboardError }}</p>
          <template v-else-if="writingDashboard">
            <article
              class="readiness-card"
              :class="readinessPresentation.tone"
              data-testid="novel-writing-readiness">
              <div>
                <ShieldCheck v-if="readinessPresentation.tone === 'is-ready'" :size="17" />
                <CheckCircle2 v-else-if="readinessPresentation.tone === 'is-idle'" :size="17" />
                <ShieldAlert v-else :size="17" />
                <span>{{ readinessPresentation.label }}</span>
              </div>
              <strong>{{ readinessPresentation.title }}</strong>
              <small>
                基线 {{ baselineLabel(writingDashboard.writeReadiness.baselineStatus) }} ·
                状态推进至 {{ chapterTitle(writingDashboard.writeReadiness.currentThroughChapterId) }}
              </small>
            </article>

            <div class="dashboard-kpis">
              <div><span>模式</span><strong>{{ writingDashboard.workflowMode === "formal" ? "正式" : "演练" }}</strong></div>
              <div><span>状态版本</span><strong>{{ writingDashboard.writingState ? `r${writingDashboard.writingState.revision}` : "未初始化" }}</strong></div>
              <div><span>待裁决</span><strong>{{ writingDashboard.pendingCandidateCount }}</strong></div>
            </div>

            <section v-if="actionableBlockers.length" class="dashboard-section blockers">
              <h3>阻断项</h3>
              <article v-for="blocker in actionableBlockers" :key="blocker.code">
                <b>{{ blocker.code }}</b>
                <p>{{ blocker.message }}</p>
              </article>
            </section>

            <section v-if="writingDashboard.writeReadiness.lease.held" class="dashboard-section lease-card">
              <h3>活动写租约</h3>
              <p>Fence {{ writingDashboard.writeReadiness.lease.fence }} · 到期 {{ formatTime(writingDashboard.writeReadiness.lease.expiresAt) }}</p>
              <details
                v-if="writingDashboard.writeReadiness.lease.contextPackReceipt"
                class="context-pack-receipt"
                data-testid="novel-context-pack-receipt"
                open>
                <summary>Context Pack 选择回执</summary>
                <p>
                  目标 {{ writingDashboard.writeReadiness.lease.contextPackReceipt.targetChapter.chapterId }} ·
                  截止 {{ writingDashboard.writeReadiness.lease.contextPackReceipt.cutoffChapterId ?? "首章前" }} ·
                  Preflight 已通过
                </p>
                <div class="receipt-identities">
                  <code>pack {{ writingDashboard.writeReadiness.lease.contextPackReceipt.contextPackFingerprint.slice(0, 12) }}</code>
                  <code>preflight {{ writingDashboard.writeReadiness.lease.contextPackReceipt.preflightId }}</code>
                </div>
                <ul class="receipt-partitions">
                  <li
                    v-for="partition in writingDashboard.writeReadiness.lease.contextPackReceipt.selectionTrace.budget.partitions"
                    :key="partition.partitionId">
                    <b>{{ partition.partitionId }}</b>
                    <span>{{ partition.protection }} · 纳入 {{ partition.includedItems }} · 省略 {{ partition.omittedItems }} · {{ partition.usedCharacters }} 字符</span>
                  </li>
                </ul>
                <details class="receipt-trace">
                  <summary>逐项轨迹（{{ writingDashboard.writeReadiness.lease.contextPackReceipt.selectionTrace.entries.length }}）</summary>
                  <ol>
                    <li
                      v-for="(entry, index) in writingDashboard.writeReadiness.lease.contextPackReceipt.selectionTrace.entries"
                      :key="`${entry.section}:${entry.itemId}:${index}`"
                      :class="`trace-${entry.disposition}`">
                      <b>{{ entry.section }} · {{ entry.itemId }}</b>
                      <span>{{ entry.disposition }} · {{ entry.protection }} · {{ entry.reason }}</span>
                    </li>
                  </ol>
                </details>
              </details>
            </section>

            <section v-if="writingDashboard.selectedChapter" class="dashboard-section selected-state" data-testid="novel-state-debt">
              <header>
                <div><span>当前章闭环</span><strong>{{ writingDashboard.selectedChapter.title }}</strong></div>
                <em :class="`status-${writingDashboard.selectedChapter.completion.status}`">
                  {{ completionLabel(writingDashboard.selectedChapter.completion.status) }}
                </em>
              </header>
              <p>{{ writingDashboard.selectedChapter.completion.message }}</p>
              <button
                v-if="writingDashboard.selectedChapter.completion.stateDebt && pendingCandidates.length"
                type="button"
                @click="railTab = 'candidates'">
                打开状态候选 Diff
              </button>
            </section>

            <section v-if="writingDashboard.selectedChapter" class="dashboard-section probe-card" data-testid="novel-consistency-probe">
              <header>
                <h3>写后一致性探针</h3>
                <em :class="`probe-${writingDashboard.selectedChapter.probe?.status ?? 'unavailable'}`">
                  {{ probeLabel(writingDashboard.selectedChapter.probe?.status) }}
                </em>
              </header>
              <p v-if="writingDashboard.selectedChapter.probeError">{{ writingDashboard.selectedChapter.probeError.message }}</p>
              <template v-else-if="writingDashboard.selectedChapter.probe">
                <p>
                  机械冲突 {{ writingDashboard.selectedChapter.probe.machineConflicts.length }} ·
                  人工复核 {{ writingDashboard.selectedChapter.probe.reviewRequired.length }}
                </p>
                <ul v-if="probeFindings.length">
                  <li v-for="finding in probeFindings" :key="`${finding.code}:${finding.message}`">
                    <b>{{ finding.severity }} · {{ finding.code }}</b>
                    <span>{{ finding.message }}</span>
                  </li>
                </ul>
              </template>
            </section>

            <section v-if="writingDashboard.writeReadiness.nextActions.length" class="dashboard-section next-actions">
              <h3>下一步</h3>
              <p v-for="action in writingDashboard.writeReadiness.nextActions.slice(0, 3)" :key="`${action.tool}:${action.purpose}`">
                <b>{{ action.requiresHumanOwner ? "需人类" : "可执行" }}</b>{{ action.purpose }}
              </p>
            </section>

            <p class="dashboard-limitation">{{ writingDashboard.limitations[0] }}</p>
          </template>
        </section>

        <section v-else-if="railTab === 'candidates'" class="candidate-board" data-testid="novel-state-candidate-board">
          <header>
            <div><strong>章末状态候选</strong><small>{{ writingDashboard?.pendingCandidateCount ?? 0 }} 条未裁决</small></div>
            <p>模型只能提交候选；接受后才进入下一章的时态正典。</p>
          </header>
          <p v-if="!pendingCandidates.length" class="dashboard-placeholder">当前没有待裁决状态候选。</p>
          <div v-else class="candidate-list">
            <button
              v-for="candidate in pendingCandidates"
              :key="candidate.candidateId"
              type="button"
              :class="{ active: selectedCandidate?.candidateId === candidate.candidateId }"
              @click="selectCandidate(candidate.candidateId)">
              <span>{{ candidate.chapter.title }}</span>
              <small>{{ candidate.changeKind === "no_state_change" ? "无变化声明" : `${candidate.changes.length} 组变化` }}</small>
            </button>
          </div>

          <article v-if="selectedCandidate" class="candidate-detail" data-testid="novel-state-candidate-diff">
            <header>
              <div>
                <span>{{ selectedCandidate.chapter.title }} · 正文 r{{ selectedCandidate.chapter.revision }}</span>
                <strong>{{ selectedCandidate.summary }}</strong>
              </div>
              <em :class="`candidate-${selectedCandidate.reviewStatus}`">{{ candidateStatusLabel(selectedCandidate.reviewStatus) }}</em>
            </header>
            <p class="candidate-status-message">{{ selectedCandidate.reviewStatusMessage }}</p>
            <dl class="candidate-audit">
              <div><dt>检查角色</dt><dd>{{ selectedCandidate.audit.checkedCharacterLabels.join("、") || "旧版未声明" }}</dd></div>
              <div><dt>状态范围</dt><dd>{{ selectedCandidate.audit.checkedStateKinds.map(stateKindLabel).join("、") || "旧版未声明" }}</dd></div>
            </dl>

            <section v-if="selectedCandidate.noStateChange" class="no-change-declaration">
              <h3>明确无状态变化</h3>
              <p>{{ selectedCandidate.noStateChange.reason }}</p>
              <blockquote v-for="evidence in selectedCandidate.noStateChange.evidence" :key="evidence.evidenceId">
                {{ evidence.excerpt }}
              </blockquote>
            </section>

            <section v-for="change in selectedCandidate.changes" :key="`${change.kind}:${change.recordId}`" class="diff-change">
              <header><span>{{ stateKindLabel(change.kind) }}</span><strong>{{ change.title }}</strong></header>
              <p>{{ change.reason }}</p>
              <div class="diff-table">
                <div class="diff-head"><b>字段</b><b>裁决前</b><b>候选后</b></div>
                <div v-for="row in change.rows" :key="row.field" :class="{ changed: row.changed }">
                  <b>{{ row.label }}</b><span>{{ row.before }}</span><span>{{ row.after }}</span>
                </div>
              </div>
              <blockquote v-for="evidence in change.evidence" :key="evidence.evidenceId">
                <small>证据 {{ evidence.startOffset }}–{{ evidence.endOffset }}</small>{{ evidence.excerpt }}
              </blockquote>
            </section>

            <label class="review-note">
              <span>裁决备注（可选）</span>
              <textarea v-model="reviewNote" maxlength="2000" placeholder="记录接受或拒绝理由" />
            </label>
            <div class="candidate-actions">
              <button
                type="button"
                data-testid="novel-reject-state-candidate"
                :disabled="dirty || reviewingCandidate || !selectedCandidate.allowedDecisions.includes('rejected')"
                @click="reviewCandidate('rejected')">
                拒绝
              </button>
              <button
                type="button"
                class="primary"
                data-testid="novel-accept-state-candidate"
                :disabled="dirty || reviewingCandidate || !selectedCandidate.allowedDecisions.includes('accepted')"
                @click="reviewCandidate('accepted')">
                {{ reviewingCandidate ? "裁决中…" : "接受并推进状态" }}
              </button>
            </div>
            <p v-if="dirty" class="candidate-warning">请先保存或放弃编辑器中的未保存修改，再裁决候选。</p>
          </article>
        </section>

        <section v-else class="memory-panel">
          <div class="memory-compose" data-testid="novel-memory-authority">
            <strong>Writing OS 记忆 · 受管只读投影 · {{ facts.length }} 条</strong>
            <p>新增或修改事实请走 <code>novel_stage_story_bible_candidate</code>，再由 human owner 裁决。</p>
            <p v-if="memoryProjection?.legacyAdaptation.factCount">
              检测到 {{ memoryProjection.legacyAdaptation.factCount }} 条 legacy adaptation 事实；它们只读保留，不会混入正式写章上下文。
            </p>
          </div>

          <div class="memory-list" data-testid="novel-memory-list">
            <button v-for="fact in visibleFacts" :key="fact.id" type="button" @click="openMemoryItem(fact)">
              <span>{{ memoryKindLabel(fact.kind) }} · r{{ fact.revision }}</span>
              <strong>{{ fact.statement }}</strong>
              <small>{{ memorySourceLabel(fact) }}</small>
            </button>
            <p v-if="!visibleFacts.length">尚无 Writing OS 正典投影；请先初始化并锁定写作状态。</p>
          </div>
        </section>
      </aside>
    </div>

    <div v-if="leaveDialogReason" class="leave-dialog-backdrop" data-testid="novel-unsaved-dialog" role="presentation">
      <section class="leave-dialog" role="dialog" aria-modal="true" aria-labelledby="novel-leave-title">
        <span>未保存正文保护</span>
        <h2 id="novel-leave-title">当前章节还有未保存修改</h2>
        <p>{{ leaveDialogCopy }}</p>
        <div class="leave-dialog-actions">
          <button type="button" :disabled="leaveSaving" data-testid="novel-leave-cancel" @click="resolveLeaveDialog('cancel')">留在此处</button>
          <button type="button" :disabled="leaveSaving" data-testid="novel-leave-discard" @click="resolveLeaveDialog('discard')">放弃修改</button>
          <button type="button" class="primary" :disabled="leaveSaving" data-testid="novel-leave-save" @click="resolveLeaveDialog('save')">
            {{ leaveSaving ? "正在保存" : "保存并继续" }}
          </button>
        </div>
      </section>
    </div>
  </section>
</template>

<script lang="ts">
export type NovelStudioWorkspaceMode = "novel" | "hybrid";

export interface NovelStudioProject {
  projectId?: string;
  projectName: string;
  projectRoot: string;
  workspaceMode: NovelStudioWorkspaceMode;
}

export type NovelLeaveReason = "chapter_switch" | "workspace_switch" | "project_switch" | "window_close";
export type NovelLeaveResult = "proceed" | "cancelled" | "save_failed";

export interface NovelStudioExpose {
  requestLeave: (reason: NovelLeaveReason) => Promise<NovelLeaveResult>;
}
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import {
  Archive,
  BookOpenText,
  CheckCircle2,
  CircleAlert,
  FileInput,
  FolderInput,
  FolderKanban,
  History,
  PencilLine,
  RefreshCw,
  Save,
  Search,
  ShieldAlert,
  ShieldCheck,
} from "lucide-vue-next";
import type {
  NovelDesktopPendingStateCandidate,
  NovelDesktopWritingDashboard,
} from "../../../core/novel-desktop-writing-os";
import type {
  NovelMemoryAuthorityProjection,
  NovelMemoryProjectionItem,
  NovelMemoryProjectionKind,
} from "../../../core/novel-memory-authority";
import type {
  NovelChapterRecord,
  NovelWritingWorkflowMode,
} from "../../../core/novel-types";
import type {
  NovelVolumeNavigationItem,
  NovelWorkspaceNavigation,
} from "../../../core/novel-manuscript";
import {
  createNovelProjectLoadGate,
  type NovelProjectLoadToken,
} from "../novel-project-load-gate";

const props = defineProps<{
  project: NovelStudioProject;
  loading?: boolean;
}>();

const emit = defineEmits<{
  "switch-workspace": [workspace: "novel" | "drama"];
  "open-project-center": [];
  refresh: [];
  imported: [projectId: string];
  restored: [projectRoot: string];
}>();

type NovelCommandRequest = Parameters<typeof window.canvasApi.novel.executeNovelCommand>[1]["request"];
type SearchResult = { chapter: NovelChapterRecord; start: number; end: number; snippet: string };
type WritingRailTab = "status" | "candidates" | "memory";
type ProbeFinding = NonNullable<NonNullable<NovelDesktopWritingDashboard["selectedChapter"]>["probe"]>["machineConflicts"][number];

const VOLUME_PAGE_LIMIT = 50;
const CHAPTER_PAGE_LIMIT = 100;

const workspace = ref<NovelWorkspaceNavigation | null>(null);
const chapters = ref<NovelChapterRecord[]>([]);
const activeVolumeId = ref("");
const chapterPageOffset = ref(0);
const chapterPageLimit = ref(CHAPTER_PAGE_LIMIT);
const chapterPageTotal = ref(0);
const memoryProjection = ref<NovelMemoryAuthorityProjection | null>(null);
const activeChapter = ref<NovelChapterRecord | null>(null);
const editorContent = ref("");
const savedContent = ref("");
const editorRef = ref<HTMLTextAreaElement | null>(null);
const selectedStart = ref(0);
const selectedEnd = ref(0);
const busy = ref(false);
const uninitialized = ref(false);
const error = ref("");
const notice = ref("");
const newVolumeTitle = ref("");
const newChapterTitles = reactive<Record<string, string>>({});
const searchQuery = ref("");
const searchResults = ref<SearchResult[]>([]);
const searchCompleted = ref(false);
const searching = ref(false);
const writingDashboard = ref<NovelDesktopWritingDashboard | null>(null);
const dashboardLoading = ref(false);
const dashboardError = ref("");
const railTab = ref<WritingRailTab>("status");
const workflowMode = ref<NovelWritingWorkflowMode>("formal");
const selectedCandidateId = ref("");
const reviewNote = ref("");
const reviewingCandidate = ref(false);
const leaveDialogReason = ref<NovelLeaveReason | null>(null);
const leaveSaving = ref(false);
let pendingLeavePromise: Promise<NovelLeaveResult> | null = null;
let resolvePendingLeave: ((result: NovelLeaveResult) => void) | null = null;
const novelLoadGate = createNovelProjectLoadGate();
let loadedRoot = "";
let dashboardLoadSequence = 0;

type NovelLoadScope = NovelProjectLoadToken;

const sortedVolumes = computed<NovelVolumeNavigationItem[]>(() => [...(workspace.value?.volumes.items ?? [])]
  .sort((left, right) => left.order - right.order || left.volumeId.localeCompare(right.volumeId)));
const totalCharacters = computed(() => workspace.value?.totals.charCount ?? 0);
const totalChapterCount = computed(() => workspace.value?.totals.chapterCount ?? 0);
const volumePageOffset = computed(() => workspace.value?.volumes.offset ?? 0);
const volumePageLimit = computed(() => workspace.value?.volumes.limit ?? VOLUME_PAGE_LIMIT);
const volumePageTotal = computed(() => workspace.value?.volumes.total ?? 0);
const volumePageStart = computed(() => volumePageTotal.value ? volumePageOffset.value + 1 : 0);
const volumePageEnd = computed(() => Math.min(volumePageOffset.value + sortedVolumes.value.length, volumePageTotal.value));
const chapterPageStart = computed(() => chapterPageTotal.value ? chapterPageOffset.value + 1 : 0);
const chapterPageEnd = computed(() => Math.min(chapterPageOffset.value + chapters.value.length, chapterPageTotal.value));
const dirty = computed(() => Boolean(activeChapter.value) && editorContent.value !== savedContent.value);
const activeVolumeTitle = computed(() => sortedVolumes.value.find((entry) => entry.volumeId === activeChapter.value?.volumeId)?.title ?? "正文");
const leaveDialogCopy = computed(() => ({
  chapter_switch: "切换章节前，请选择保存当前修改、明确放弃，或留在当前章节。",
  workspace_switch: "切换到短剧工作区前，请先处理当前章节修改。",
  project_switch: "切换或移除项目会卸载当前编辑器，请先处理当前章节修改。",
  window_close: "关闭应用前，请先处理当前章节修改。",
} as const)[leaveDialogReason.value ?? "chapter_switch"]);
const facts = computed(() => memoryProjection.value?.items ?? []);
const visibleFacts = computed(() => [...facts.value].sort((left, right) => left.kind.localeCompare(right.kind, "en") || left.id.localeCompare(right.id, "en")).slice(0, 100));
const pendingCandidates = computed(() => writingDashboard.value?.pendingCandidates ?? []);
const selectedCandidate = computed<NovelDesktopPendingStateCandidate | null>(() => pendingCandidates.value.find((entry) => entry.candidateId === selectedCandidateId.value)
  ?? pendingCandidates.value[0]
  ?? null);
const probeFindings = computed<ProbeFinding[]>(() => {
  const probe = writingDashboard.value?.selectedChapter?.probe;
  return probe ? [...probe.machineConflicts, ...probe.reviewRequired].slice(0, 6) : [];
});
const readinessPresentation = computed(() => {
  const dashboard = writingDashboard.value;
  if (!dashboard) return { tone: "is-blocked", label: "状态不可用", title: "请刷新 Writing OS" } as const;
  const selected = dashboard.selectedChapter;
  const target = dashboard.writeReadiness.targetChapter;
  if (selected?.completion.stateDebt && target?.chapterId === selected.chapterId && savedContent.value.length > 0) {
    return { tone: "is-debt", label: "正文待收口", title: "先裁决本章状态" } as const;
  }
  if (dashboard.writeReadiness.readyForPrepare && target) {
    return { tone: "is-ready", label: "写前条件就绪", title: target.title } as const;
  }
  if (!target && dashboard.writeReadiness.blockers.every((entry) => entry.code === "target_chapter_missing")) {
    return { tone: "is-idle", label: "当前无待写章", title: "已推进至最后一章" } as const;
  }
  return { tone: "is-blocked", label: "写前门禁阻断", title: target?.title ?? "需要先处理阻断项" } as const;
});
const actionableBlockers = computed(() => {
  const dashboard = writingDashboard.value;
  if (!dashboard) return [];
  if (!dashboard.writeReadiness.targetChapter
    && dashboard.writeReadiness.blockers.every((entry) => entry.code === "target_chapter_missing")) return [];
  return dashboard.writeReadiness.blockers;
});

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function clearNotice(): void {
  error.value = "";
  notice.value = "";
}

function beginLoadScope(root = props.project.projectRoot): NovelLoadScope {
  dashboardLoadSequence += 1;
  return novelLoadGate.begin(root);
}

function currentLoadScope(root = props.project.projectRoot): NovelLoadScope {
  return novelLoadGate.capture(root);
}

function isCurrentLoadScope(scope: NovelLoadScope): boolean {
  return novelLoadGate.isCurrent(scope, props.project.projectRoot);
}

function invalidateNovelLoads(): void {
  novelLoadGate.invalidate();
  dashboardLoadSequence += 1;
}

function finishLeaveDialog(result: NovelLeaveResult): void {
  const resolve = resolvePendingLeave;
  leaveDialogReason.value = null;
  leaveSaving.value = false;
  pendingLeavePromise = null;
  resolvePendingLeave = null;
  resolve?.(result);
}

async function requestLeave(reason: NovelLeaveReason): Promise<NovelLeaveResult> {
  invalidateNovelLoads();
  if (!dirty.value) return "proceed";
  if (pendingLeavePromise) return pendingLeavePromise;
  leaveDialogReason.value = reason;
  pendingLeavePromise = new Promise<NovelLeaveResult>((resolve) => {
    resolvePendingLeave = resolve;
  });
  return pendingLeavePromise;
}

async function resolveLeaveDialog(action: "save" | "discard" | "cancel"): Promise<void> {
  if (!leaveDialogReason.value || leaveSaving.value) return;
  if (action === "cancel") {
    finishLeaveDialog("cancelled");
    return;
  }
  if (action === "discard") {
    editorContent.value = savedContent.value;
    finishLeaveDialog("proceed");
    return;
  }
  const root = props.project.projectRoot;
  const chapter = activeChapter.value;
  const content = editorContent.value;
  if (!chapter) {
    finishLeaveDialog("proceed");
    return;
  }
  leaveSaving.value = true;
  clearNotice();
  try {
    const result = await runCommand<{ chapter?: NovelChapterRecord }>({
      command: "novel_save_chapter",
      payload: {
        chapterId: chapter.chapterId,
        content,
        expectedRevision: chapter.revision,
        expectedSha256: chapter.sha256,
      },
    }, root);
    if (props.project.projectRoot === root && activeChapter.value?.chapterId === chapter.chapterId) {
      if (result.chapter) activeChapter.value = result.chapter;
      savedContent.value = content;
    }
    finishLeaveDialog("proceed");
  } catch (reason) {
    error.value = `保存失败，已留在当前章节：${messageOf(reason)}`;
    finishLeaveDialog("save_failed");
  }
}

defineExpose<NovelStudioExpose>({ requestLeave });

function chapterTitle(chapterId: string | null | undefined): string {
  if (!chapterId) return "未建立";
  return chapters.value.find((entry) => entry.chapterId === chapterId)?.title ?? chapterId;
}

function baselineLabel(status: "provisional" | "locked" | "missing"): string {
  return ({ locked: "已锁定", provisional: "临时", missing: "未初始化" } as const)[status];
}

function completionLabel(status: NonNullable<NovelDesktopWritingDashboard["selectedChapter"]>["completion"]["status"]): string {
  return ({
    committed: "状态已提交",
    missing: "欠状态提交",
    stale: "状态已过期",
    writing_state_missing: "未初始化",
  } as const)[status];
}

function probeLabel(status: "pass" | "review_required" | "machine_conflict" | undefined): string {
  return ({ pass: "机械通过", review_required: "需人工复核", machine_conflict: "机械冲突", unavailable: "不可用" } as const)[status ?? "unavailable"];
}

function candidateStatusLabel(status: NovelDesktopPendingStateCandidate["reviewStatus"]): string {
  return ({
    ready: "可裁决",
    applied_recovery: "补记回执",
    legacy: "旧版失效",
    stale_state: "状态过期",
    stale_chapter: "正文过期",
    out_of_order: "顺序阻断",
  } as const)[status];
}

function stateKindLabel(kind: string): string {
  return ({
    character_state: "人物动态",
    knowledge: "知情边界",
    relationship: "关系状态",
    timeline: "时间线",
    foreshadowing: "伏笔",
  } as Record<string, string>)[kind] ?? kind;
}

function formatTime(value: string | undefined): string {
  if (!value) return "未知";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString("zh-CN") : value;
}

function selectCandidate(candidateId: string): void {
  selectedCandidateId.value = candidateId;
  reviewNote.value = "";
}

async function loadWritingDashboard(
  selectedChapterId = activeChapter.value?.chapterId,
  scope: NovelLoadScope = currentLoadScope(),
): Promise<void> {
  const requestSequence = ++dashboardLoadSequence;
  if (!isCurrentLoadScope(scope)) return;
  if (uninitialized.value) {
    writingDashboard.value = null;
    return;
  }
  dashboardLoading.value = true;
  dashboardError.value = "";
  try {
    const result = await window.canvasApi.novel.getWritingDashboard(scope.root, {
      ...(selectedChapterId ? { selectedChapterId } : {}),
      workflowMode: workflowMode.value,
    });
    if (requestSequence !== dashboardLoadSequence || !isCurrentLoadScope(scope)) return;
    writingDashboard.value = result;
    if (!result.pendingCandidates.some((entry) => entry.candidateId === selectedCandidateId.value)) {
      selectedCandidateId.value = result.pendingCandidates[0]?.candidateId ?? "";
      reviewNote.value = "";
    }
  } catch (reason) {
    if (requestSequence !== dashboardLoadSequence || !isCurrentLoadScope(scope)) return;
    writingDashboard.value = null;
    dashboardError.value = messageOf(reason);
  } finally {
    if (requestSequence === dashboardLoadSequence && isCurrentLoadScope(scope)) dashboardLoading.value = false;
  }
}

async function refreshWritingDashboard(): Promise<void> {
  await loadWritingDashboard();
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

async function createCommandEnvelope(request: NovelCommandRequest) {
  const requestBytes = new TextEncoder().encode(JSON.stringify(stableValue(request)));
  const digest = await crypto.subtle.digest("SHA-256", requestBytes);
  const fingerprint = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return {
    requestId: `ui-novel-${crypto.randomUUID()}`,
    idempotencyKey: `ui-novel-${request.command}-${fingerprint.slice(0, 48)}`,
    request,
  };
}

async function runCommand<T>(request: NovelCommandRequest, root: string | null = props.project.projectRoot): Promise<T> {
  const result = await window.canvasApi.novel.executeNovelCommand(root, await createCommandEnvelope(request));
  if (result.status !== "succeeded") {
    throw new Error(result.error?.message || `小说命令未成功：${result.status}`);
  }
  return result.result as T;
}

async function loadFacts(scope: NovelLoadScope = currentLoadScope()): Promise<void> {
  const result = await window.canvasApi.novel.listFacts(scope.root);
  if (isCurrentLoadScope(scope)) memoryProjection.value = result;
}

async function loadChapterPage(
  scope: NovelLoadScope,
  volumeId: string,
  offset = 0,
  anchorChapterId?: string,
): Promise<Awaited<ReturnType<typeof window.canvasApi.novel.listChapters>>> {
  const page = await window.canvasApi.novel.listChapters(scope.root, {
    volumeId,
    offset,
    limit: CHAPTER_PAGE_LIMIT,
    ...(anchorChapterId ? { anchorChapterId } : {}),
  });
  if (!isCurrentLoadScope(scope)) return page;
  if (workspace.value?.manifestRevision !== null
    && page.manifestRevision !== workspace.value?.manifestRevision) {
    throw new Error("小说章节清单在分页读取期间发生变化，请重新载入。");
  }
  activeVolumeId.value = volumeId;
  chapters.value = page.items;
  chapterPageOffset.value = page.offset;
  chapterPageLimit.value = page.limit;
  chapterPageTotal.value = page.total;
  return page;
}

async function loadWorkspace(
  preferredChapterId?: string,
  suppliedScope?: NovelLoadScope,
): Promise<void> {
  const scope = suppliedScope ?? beginLoadScope();
  clearNotice();
  busy.value = true;
  try {
    const reusableChapterId = loadedRoot === scope.root ? activeChapter.value?.chapterId : undefined;
    const targetChapterId = preferredChapterId ?? reusableChapterId;
    const preferredRead = targetChapterId
      ? await window.canvasApi.novel.readChapter(scope.root, targetChapterId)
      : null;
    if (!isCurrentLoadScope(scope)) return;
    if (preferredRead && preferredRead.status !== "healthy") {
      throw new Error("章节文件已被外部修改，请先备份并重新载入。 ");
    }
    const navigation = await window.canvasApi.novel.getNavigation(scope.root, {
      offset: 0,
      limit: VOLUME_PAGE_LIMIT,
      ...(preferredRead ? { anchorVolumeId: preferredRead.chapter.volumeId } : {}),
    });
    if (!isCurrentLoadScope(scope)) return;
    workspace.value = navigation;
    loadedRoot = scope.root;
    uninitialized.value = false;
    await loadFacts(scope);
    if (!isCurrentLoadScope(scope)) return;
    const volumeId = preferredRead?.chapter.volumeId ?? navigation.volumes.items[0]?.volumeId;
    const page = volumeId
      ? await loadChapterPage(scope, volumeId, 0, preferredRead?.chapter.chapterId)
      : null;
    if (!isCurrentLoadScope(scope)) return;
    const target = page?.items.find((chapter) => chapter.chapterId === preferredRead?.chapter.chapterId)
      ?? page?.items[0];
    if (target) await openChapter(target, true, scope);
    else {
      activeChapter.value = null;
      activeVolumeId.value = volumeId ?? "";
      chapters.value = [];
      chapterPageOffset.value = 0;
      chapterPageTotal.value = 0;
      editorContent.value = "";
      savedContent.value = "";
      await loadWritingDashboard(undefined, scope);
    }
  } catch (reason) {
    if (!isCurrentLoadScope(scope)) return;
    workspace.value = null;
    chapters.value = [];
    activeChapter.value = null;
    activeVolumeId.value = "";
    chapterPageOffset.value = 0;
    chapterPageTotal.value = 0;
    writingDashboard.value = null;
    dashboardError.value = "";
    uninitialized.value = true;
    error.value = `正文库尚未初始化或无法读取：${messageOf(reason)}`;
  } finally {
    if (isCurrentLoadScope(scope)) busy.value = false;
  }
}

async function initializeManuscript(): Promise<void> {
  busy.value = true;
  clearNotice();
  try {
    await runCommand({ command: "novel_initialize_manuscript", payload: { sourceMode: "managed_markdown" } });
    await loadWorkspace();
    notice.value = "正文库已初始化，可以开始新建章节。";
  } catch (reason) {
    error.value = messageOf(reason);
  } finally {
    busy.value = false;
  }
}

async function openChapter(
  chapter: NovelChapterRecord,
  force = false,
  suppliedScope?: NovelLoadScope,
): Promise<void> {
  if (!force && dirty.value && await requestLeave("chapter_switch") !== "proceed") return;
  const scope = suppliedScope ?? beginLoadScope();
  busy.value = true;
  clearNotice();
  try {
    const result = await window.canvasApi.novel.readChapter(scope.root, chapter.chapterId);
    if (!isCurrentLoadScope(scope)) return;
    if (result.status !== "healthy") throw new Error("章节文件已被外部修改，请先备份并重新载入。 ");
    activeChapter.value = result.chapter;
    editorContent.value = result.content;
    savedContent.value = result.content;
    selectedStart.value = 0;
    selectedEnd.value = 0;
    await loadWritingDashboard(result.chapter.chapterId, scope);
  } catch (reason) {
    if (!isCurrentLoadScope(scope)) return;
    error.value = messageOf(reason);
  } finally {
    if (isCurrentLoadScope(scope)) busy.value = false;
  }
}

async function saveActiveChapter(): Promise<void> {
  const chapter = activeChapter.value;
  if (!chapter || !dirty.value) return;
  const root = props.project.projectRoot;
  const content = editorContent.value;
  const scope = beginLoadScope(root);
  busy.value = true;
  clearNotice();
  try {
    const result = await runCommand<{ chapter?: NovelChapterRecord }>({
      command: "novel_save_chapter",
      payload: {
        chapterId: chapter.chapterId,
        content,
        expectedRevision: chapter.revision,
        expectedSha256: chapter.sha256,
      },
    }, root);
    if (isCurrentLoadScope(scope) && activeChapter.value?.chapterId === chapter.chapterId) {
      if (result.chapter) activeChapter.value = result.chapter;
      savedContent.value = content;
    }
    if (!isCurrentLoadScope(scope)) return;
    await loadWorkspace(chapter.chapterId, scope);
    if (!isCurrentLoadScope(scope)) return;
    notice.value = writingDashboard.value?.selectedChapter?.completion.stateDebt
      ? "章节正文已保存；Writing OS 已标记状态债，仍需提交并人工裁决章末状态候选。"
      : "章节已保存，旧版本已进入本地历史快照。";
  } catch (reason) {
    if (!isCurrentLoadScope(scope)) return;
    error.value = messageOf(reason);
  } finally {
    if (isCurrentLoadScope(scope)) busy.value = false;
  }
}

async function activateChapterPage(
  scope: NovelLoadScope,
  volumeId: string,
  offset: number,
  anchorChapterId?: string,
): Promise<void> {
  const page = await loadChapterPage(scope, volumeId, offset, anchorChapterId);
  if (!isCurrentLoadScope(scope)) return;
  const target = page.items.find((chapter) => chapter.chapterId === anchorChapterId) ?? page.items[0];
  if (target) {
    await openChapter(target, true, scope);
    return;
  }
  activeChapter.value = null;
  editorContent.value = "";
  savedContent.value = "";
  await loadWritingDashboard(undefined, scope);
}

async function selectVolume(volumeId: string): Promise<void> {
  if (volumeId === activeVolumeId.value) return;
  if (await requestLeave("chapter_switch") !== "proceed") return;
  const scope = beginLoadScope();
  busy.value = true;
  clearNotice();
  try {
    await activateChapterPage(scope, volumeId, 0);
  } catch (reason) {
    if (isCurrentLoadScope(scope)) error.value = messageOf(reason);
  } finally {
    if (isCurrentLoadScope(scope)) busy.value = false;
  }
}

async function changeChapterPage(direction: -1 | 1): Promise<void> {
  const volumeId = activeVolumeId.value;
  if (!volumeId || await requestLeave("chapter_switch") !== "proceed") return;
  const nextOffset = Math.max(0, chapterPageOffset.value + direction * chapterPageLimit.value);
  const scope = beginLoadScope();
  busy.value = true;
  clearNotice();
  try {
    await activateChapterPage(scope, volumeId, nextOffset);
  } catch (reason) {
    if (isCurrentLoadScope(scope)) error.value = messageOf(reason);
  } finally {
    if (isCurrentLoadScope(scope)) busy.value = false;
  }
}

async function changeVolumePage(direction: -1 | 1): Promise<void> {
  if (await requestLeave("chapter_switch") !== "proceed") return;
  const nextOffset = Math.max(0, volumePageOffset.value + direction * volumePageLimit.value);
  const scope = beginLoadScope();
  busy.value = true;
  clearNotice();
  try {
    const navigation = await window.canvasApi.novel.getNavigation(scope.root, {
      offset: nextOffset,
      limit: VOLUME_PAGE_LIMIT,
    });
    if (!isCurrentLoadScope(scope)) return;
    workspace.value = navigation;
    const volumeId = navigation.volumes.items[0]?.volumeId;
    if (volumeId) await activateChapterPage(scope, volumeId, 0);
    else {
      activeVolumeId.value = "";
      chapters.value = [];
      chapterPageOffset.value = 0;
      chapterPageTotal.value = 0;
      activeChapter.value = null;
      editorContent.value = "";
      savedContent.value = "";
    }
  } catch (reason) {
    if (isCurrentLoadScope(scope)) error.value = messageOf(reason);
  } finally {
    if (isCurrentLoadScope(scope)) busy.value = false;
  }
}

async function reviewCandidate(decision: "accepted" | "rejected"): Promise<void> {
  const candidate = selectedCandidate.value;
  const state = writingDashboard.value?.writingState;
  if (!candidate || !state || reviewingCandidate.value) return;
  if (dirty.value) {
    error.value = "请先保存或放弃当前正文修改，再裁决状态候选。";
    return;
  }
  const decisionLabel = decision === "accepted" ? "接受并推进 Writing State" : "拒绝且不写入正典";
  if (!window.confirm(`${decisionLabel}？\n\n${candidate.chapter.title}\n${candidate.summary}`)) return;
  const scope = currentLoadScope();
  reviewingCandidate.value = true;
  clearNotice();
  try {
    await window.canvasApi.novel.reviewStateCandidate(scope.root, {
      candidateId: candidate.candidateId,
      expectedCandidateFingerprint: candidate.fingerprint,
      expectedWritingStateRevision: state.revision,
      expectedWritingStateFingerprint: state.fingerprint,
      decision,
      ...(reviewNote.value.trim() ? { note: reviewNote.value.trim() } : {}),
    });
    if (!isCurrentLoadScope(scope)) return;
    await Promise.all([loadFacts(scope), loadWritingDashboard(activeChapter.value?.chapterId, scope)]);
    if (!isCurrentLoadScope(scope)) return;
    notice.value = decision === "accepted"
      ? "状态候选已由人类界面接受，Writing State 已推进；仪表盘和探针已刷新。"
      : "状态候选已拒绝，未进入时态正典。";
    if (decision === "accepted") railTab.value = "status";
  } catch (reason) {
    if (!isCurrentLoadScope(scope)) return;
    error.value = messageOf(reason);
    await loadWritingDashboard(activeChapter.value?.chapterId, scope);
  } finally {
    reviewingCandidate.value = false;
  }
}

async function createVolume(): Promise<void> {
  const title = newVolumeTitle.value.trim();
  const revision = workspace.value?.manifestRevision;
  if (!title || !revision) return;
  busy.value = true;
  clearNotice();
  try {
    await runCommand({ command: "novel_create_volume", payload: { title, expectedManifestRevision: revision } });
    newVolumeTitle.value = "";
    await loadWorkspace(activeChapter.value?.chapterId);
    notice.value = `已新建卷：${title}`;
  } catch (reason) {
    error.value = messageOf(reason);
  } finally {
    busy.value = false;
  }
}

async function createChapter(volumeId: string): Promise<void> {
  const title = newChapterTitles[volumeId]?.trim();
  const revision = workspace.value?.manifestRevision;
  if (!title || !revision) return;
  busy.value = true;
  clearNotice();
  try {
    const result = await runCommand<{ chapter?: NovelChapterRecord }>({
      command: "novel_create_chapter",
      payload: { volumeId, title, content: "", expectedManifestRevision: revision },
    });
    newChapterTitles[volumeId] = "";
    await loadWorkspace(result.chapter?.chapterId);
    notice.value = `已新建章节：${title}`;
  } catch (reason) {
    error.value = messageOf(reason);
  } finally {
    busy.value = false;
  }
}

async function renameActiveChapter(): Promise<void> {
  const chapter = activeChapter.value;
  const manifestRevision = workspace.value?.manifestRevision;
  if (!chapter || !manifestRevision) return;
  const title = window.prompt("章节新名称", chapter.title)?.trim();
  if (!title || title === chapter.title) return;
  busy.value = true;
  clearNotice();
  try {
    await runCommand({
      command: "novel_rename_chapter",
      payload: {
        chapterId: chapter.chapterId,
        title,
        expectedRevision: chapter.revision,
        expectedManifestRevision: manifestRevision,
      },
    });
    await loadWorkspace(chapter.chapterId);
    notice.value = `章节已改名为：${title}`;
  } catch (reason) {
    error.value = messageOf(reason);
  } finally {
    busy.value = false;
  }
}

async function searchAllChapters(): Promise<void> {
  const query = searchQuery.value.trim();
  if (query.length < 2) return;
  searching.value = true;
  searchCompleted.value = false;
  searchResults.value = [];
  clearNotice();
  const scope = currentLoadScope();
  try {
    const result = await window.canvasApi.novel.searchChapters(scope.root, {
      query,
      limit: 200,
      maxHitsPerChapter: 5,
    });
    if (!isCurrentLoadScope(scope)) return;
    searchResults.value = result.hits.map((hit) => ({
      chapter: hit.chapter,
      start: hit.startOffset,
      end: hit.endOffset,
      snippet: hit.snippet,
    }));
    searchCompleted.value = true;
    notice.value = `全文搜索完成：${result.hits.length} 条结果${result.skippedExternalChanges ? `，跳过 ${result.skippedExternalChanges} 个外部变化章节` : ""}。`;
  } catch (reason) {
    if (!isCurrentLoadScope(scope)) return;
    error.value = messageOf(reason);
  } finally {
    if (isCurrentLoadScope(scope)) searching.value = false;
  }
}

function clearSearch(): void {
  searchResults.value = [];
  searchCompleted.value = false;
}

async function openSearchResult(result: SearchResult): Promise<void> {
  if (dirty.value && await requestLeave("chapter_switch") !== "proceed") return;
  const scope = beginLoadScope();
  await loadWorkspace(result.chapter.chapterId, scope);
  if (!isCurrentLoadScope(scope) || activeChapter.value?.chapterId !== result.chapter.chapterId) return;
  await nextTick();
  editorRef.value?.focus();
  editorRef.value?.setSelectionRange(result.start, result.end);
  selectedStart.value = result.start;
  selectedEnd.value = result.end;
}

function captureSelection(): void {
  selectedStart.value = editorRef.value?.selectionStart ?? 0;
  selectedEnd.value = editorRef.value?.selectionEnd ?? 0;
}

async function openMemoryItem(fact: NovelMemoryProjectionItem): Promise<void> {
  const chapterId = fact.chapterIds[0];
  if (!chapterId) return;
  if (dirty.value && await requestLeave("chapter_switch") !== "proceed") return;
  const scope = beginLoadScope();
  await loadWorkspace(chapterId, scope);
}

function memoryKindLabel(kind: NovelMemoryProjectionKind): string {
  return ({
    entity: "人物基础卡",
    hard_canon: "硬正典",
    character_state: "人物动态",
    knowledge: "知情边界",
    relationship: "关系状态",
    timeline: "时间线",
    foreshadowing: "伏笔",
    character_profile: "人物声口",
    character_appearance: "人物外形",
    continuity_issue: "连续性问题",
    chapter_brief: "章节任务",
  } as Record<NovelMemoryProjectionKind, string>)[kind];
}

function memorySourceLabel(fact: NovelMemoryProjectionItem): string {
  const chapterLabels = fact.chapterIds.map((chapterId) => chapters.value.find((entry) => entry.chapterId === chapterId)?.title ?? chapterId);
  if (chapterLabels.length) return chapterLabels.join("、");
  if (fact.sourceIds.length) return `来源：${fact.sourceIds.join("、")}`;
  return "全局正典";
}

async function backupProject(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  clearNotice();
  try {
    const result = await window.canvasApi.backupManagedProject(props.project.projectRoot);
    if (result.canceled) notice.value = "已取消备份。";
    else notice.value = `备份完成：${result.fileCount} 个文件。`;
  } catch (reason) {
    error.value = messageOf(reason);
  } finally {
    busy.value = false;
  }
}

async function restoreProject(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  clearNotice();
  try {
    const result = await window.canvasApi.restoreManagedProject();
    if (result.canceled) notice.value = "已取消恢复。";
    else emit("restored", result.projectRoot);
  } catch (reason) {
    error.value = messageOf(reason);
  } finally {
    busy.value = false;
  }
}

async function importNovel(kind: "file" | "directory"): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  clearNotice();
  try {
    const source = await window.canvasApi.novel.pickSource(kind);
    if (!source) return;
    const destination = await window.canvasApi.novel.pickDestination();
    if (!destination) return;
    const preflight = await window.canvasApi.novel.preflightSource(destination.destinationId, source.selectionId);
    if (!preflight.eligible || !preflight.authorization) {
      throw new Error(preflight.warnings.join("；") || "所选来源未通过小说导入预检。 ");
    }
    const approved = window.confirm(
      `准备导入“${source.sourceName}”\n${preflight.summary.chapterCount} 章，${preflight.summary.charCount.toLocaleString("zh-CN")} 字符。\n\n将创建受管副本，原始来源不会被修改。继续吗？`,
    );
    if (!approved) return;
    const projectName = source.sourceName.replace(/\.(txt|md|markdown|docx)$/iu, "").slice(0, 120) || "导入小说";
    const result = await runCommand<{ receipt?: { projectId?: string } }>({
      command: "novel_import_external_snapshot",
      payload: {
        projectName,
        preflightId: preflight.preflightId,
        preflightFingerprint: preflight.fingerprint,
        sourceTreeAggregateSha256: preflight.sourceTreeAggregateSha256,
        duplicateResolution: "skip_later_exact_duplicates",
        convertToManagedMarkdown: true,
        preflightAuthorization: preflight.authorization.authorizationId,
      },
    }, null);
    const projectId = result.receipt?.projectId;
    if (!projectId) throw new Error("导入已执行，但返回结果缺少新工程 ID。 ");
    notice.value = `导入完成：${preflight.summary.chapterCount} 章。`;
    emit("imported", projectId);
  } catch (reason) {
    error.value = messageOf(reason);
  } finally {
    busy.value = false;
  }
}

watch(() => props.project.projectRoot, (root) => {
  const scope = beginLoadScope(root);
  void loadWorkspace(undefined, scope);
}, { flush: "sync" });
onMounted(() => {
  const scope = beginLoadScope();
  void loadWorkspace(undefined, scope);
});
onBeforeUnmount(() => {
  invalidateNovelLoads();
  if (pendingLeavePromise) finishLeaveDialog("cancelled");
});
</script>

<style scoped>
.novel-studio {
  --ink: #17211f;
  --muted: #6e7c78;
  --line: #d9e0dc;
  --paper: #fbfaf6;
  --surface: #f0f3ef;
  --accent: #147d70;
  height: 100vh;
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  overflow: hidden;
  color: var(--ink);
  background: var(--surface);
  font-family: Inter, "PingFang SC", "Microsoft YaHei", sans-serif;
}

button, input, textarea, select { font: inherit; }
button { color: inherit; }

.novel-header {
  min-height: 68px;
  display: grid;
  grid-template-columns: minmax(220px, 1fr) auto auto;
  align-items: center;
  gap: 18px;
  padding: 10px 18px;
  border-bottom: 1px solid var(--line);
  background: rgba(251, 250, 246, .96);
}

.project-identity span, .editor-toolbar span, .memory-rail > header span { color: var(--accent); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.project-identity h1 { margin: 2px 0 0; font: 700 20px/1.15 "Songti SC", STSong, serif; }
.project-identity p { margin: 3px 0 0; color: var(--muted); font-size: 12px; }
.workspace-switch, .header-actions, .editor-actions { display: flex; align-items: center; gap: 6px; }
.workspace-switch { padding: 3px; border-radius: 8px; background: #e8ece8; }
.workspace-switch button, .header-actions button, .editor-actions button {
  display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 0 10px; border: 1px solid transparent; border-radius: 7px; background: transparent; cursor: pointer;
}
.workspace-switch button.active, .header-actions button:hover, .editor-actions button:hover { border-color: var(--line); background: white; }
button.primary { border-color: var(--accent) !important; color: white !important; background: var(--accent) !important; }
button:disabled { cursor: not-allowed; opacity: .48; }

.notice { display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 6px 18px; color: #175f55; background: #e0f1eb; border-bottom: 1px solid #c4e3d9; font-size: 12px; }
.notice.error { color: #8a3028; background: #fae8e5; border-color: #efcbc5; }
.notice button { margin-left: auto; border: 0; background: transparent; cursor: pointer; font-size: 18px; }

.workspace-body { min-height: 0; display: grid; grid-template-columns: 270px minmax(420px, 1fr) 410px; }
.chapter-rail, .memory-rail { min-height: 0; overflow: auto; background: #f6f7f4; }
.chapter-rail { border-right: 1px solid var(--line); }
.memory-rail { border-left: 1px solid var(--line); }

.search-box { position: sticky; top: 0; z-index: 2; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 7px; padding: 10px; background: #f6f7f4; border-bottom: 1px solid var(--line); }
.search-box input, .inline-create input, .new-volume input, .memory-compose textarea, .memory-compose select {
  min-width: 0; border: 1px solid var(--line); border-radius: 6px; outline: 0; background: white;
}
.search-box input { height: 32px; padding: 0 8px; }
.search-box input:focus, .inline-create input:focus, .new-volume input:focus, .memory-compose textarea:focus, .memory-compose select:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(20, 125, 112, .1); }
.search-box button, .search-results header button { border: 0; color: var(--accent); background: transparent; cursor: pointer; font-size: 12px; font-weight: 700; }
.search-results { border-bottom: 1px solid var(--line); background: white; }
.search-results header { display: flex; justify-content: space-between; padding: 9px 10px; }
.search-results > button { width: 100%; display: grid; gap: 3px; padding: 8px 10px; border: 0; border-top: 1px solid #edf0ed; text-align: left; background: white; cursor: pointer; }
.search-results > button:hover { background: #edf6f2; }
.search-results strong { font-size: 12px; }
.search-results span, .search-results p { color: var(--muted); font-size: 11px; }
.search-results p { padding: 10px; margin: 0; }

.rail-heading, .volume-section > header { display: flex; align-items: center; justify-content: space-between; }
.rail-heading { padding: 13px 12px 7px; font-size: 12px; font-weight: 800; }
.rail-heading small, .volume-section > header small { color: var(--muted); font-weight: 500; }
.volume-section { padding: 0 8px 10px; }
.volume-section > header { padding: 7px 6px; color: var(--muted); font-size: 11px; font-weight: 700; }
.volume-toggle { width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; padding: 7px 5px; border: 0; border-radius: 6px; color: inherit; text-align: left; background: transparent; cursor: pointer; }
.volume-toggle:hover, .volume-toggle.active { color: #0d5f55; background: #e3eee9; }
.volume-section > button { width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; padding: 8px; border: 0; border-radius: 6px; text-align: left; background: transparent; cursor: pointer; }
.volume-section > button:hover { background: #e9eeea; }
.volume-section > button.active { color: #0d5f55; background: #dcece6; }
.volume-section > button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.volume-section > button small { color: var(--muted); font-size: 10px; }
.inline-create, .new-volume { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px; padding: 5px; }
.inline-create input, .new-volume input { height: 30px; padding: 0 8px; font-size: 11px; }
.inline-create button, .new-volume button { border: 1px solid var(--line); border-radius: 6px; background: white; cursor: pointer; }
.new-volume { position: sticky; bottom: 0; padding: 9px; border-top: 1px solid var(--line); background: #f6f7f4; }
.rail-pagination { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 6px; padding: 7px 5px; color: var(--muted); font-size: 10px; }
.rail-pagination small { text-align: center; }
.rail-pagination button { min-height: 26px; padding: 0 7px; border: 1px solid var(--line); border-radius: 6px; background: white; cursor: pointer; font-size: 10px; }
.volume-pagination { margin: 0 8px 8px; border-top: 1px solid var(--line); }

.leave-dialog-backdrop { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 24px; background: rgba(13, 20, 18, .55); backdrop-filter: blur(3px); }
.leave-dialog { width: min(460px, 100%); padding: 24px; border: 1px solid #cfd8d3; border-radius: 14px; color: var(--ink); background: var(--paper); box-shadow: 0 24px 80px rgba(0, 0, 0, .24); }
.leave-dialog > span { color: var(--accent); font-size: 11px; font-weight: 800; letter-spacing: .08em; }
.leave-dialog h2 { margin: 7px 0 8px; font: 700 21px/1.25 "Songti SC", STSong, serif; }
.leave-dialog p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.65; }
.leave-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
.leave-dialog-actions button { min-height: 34px; padding: 0 12px; border: 1px solid var(--line); border-radius: 7px; background: white; cursor: pointer; }
.empty-rail { padding: 16px 12px; color: var(--muted); font-size: 12px; }
.empty-rail button { min-height: 34px; padding: 0 10px; border-radius: 7px; cursor: pointer; }

.editor-workspace { min-width: 0; min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; background: var(--paper); }
.editor-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 16px 22px 12px; border-bottom: 1px solid #e8e5dc; }
.editor-toolbar h2 { margin: 2px 0; font: 700 21px/1.25 "Songti SC", STSong, serif; }
.editor-toolbar small { color: var(--muted); font-size: 11px; }
.editor-workspace > textarea { width: 100%; height: 100%; resize: none; box-sizing: border-box; padding: 28px clamp(28px, 7vw, 96px); border: 0; outline: 0; color: #222824; background: var(--paper); font: 17px/1.95 "Songti SC", STSong, serif; letter-spacing: .015em; }
.editor-footer { display: flex; gap: 18px; padding: 7px 18px; border-top: 1px solid #e8e5dc; color: var(--muted); background: #f7f5ef; font-size: 11px; }
.editor-footer .changed { color: #a35b20; }
.editor-empty { align-self: center; justify-self: center; max-width: 460px; padding: 36px; text-align: center; color: var(--muted); }
.editor-empty svg { color: var(--accent); }
.editor-empty h2 { color: var(--ink); font: 700 23px/1.35 "Songti SC", STSong, serif; }
.editor-empty p { line-height: 1.7; }

.memory-rail > header { padding: 15px 14px 10px; border-bottom: 1px solid var(--line); }
.memory-rail > header > div { display: flex; justify-content: space-between; }
.memory-rail > header p { margin: 6px 0 0; color: var(--muted); font-size: 11px; }
.memory-compose { display: grid; gap: 7px; padding: 12px; border-bottom: 1px solid var(--line); }
.memory-compose select { height: 32px; padding: 0 8px; }
.memory-compose textarea { min-height: 72px; resize: vertical; padding: 8px; line-height: 1.5; }
.memory-compose blockquote { margin: 0; padding: 8px 10px; border-left: 2px solid var(--accent); color: var(--muted); background: #edf3ef; font: 12px/1.6 "Songti SC", STSong, serif; }
.memory-compose button { min-height: 34px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; border-radius: 7px; cursor: pointer; }
.memory-list { padding: 5px 8px 18px; }
.memory-list > button { width: 100%; display: grid; gap: 4px; padding: 10px 7px; border: 0; border-bottom: 1px solid #e5e9e5; text-align: left; background: transparent; cursor: pointer; }
.memory-list > button:hover { background: #ebf1ed; }
.memory-list span { color: var(--accent); font-size: 10px; font-weight: 700; }
.memory-list strong { font: 600 13px/1.45 "Songti SC", STSong, serif; }
.memory-list small, .memory-list > p { color: var(--muted); font-size: 10px; }
.memory-list > p { padding: 12px 6px; line-height: 1.6; }

.writing-os-header { position: sticky; top: 0; z-index: 3; padding-bottom: 0 !important; background: rgba(246, 247, 244, .98); }
.writing-os-header > div { align-items: center; }
.writing-os-header > div > button { display: inline-grid; place-items: center; width: 27px; height: 27px; border: 1px solid var(--line); border-radius: 6px; background: white; cursor: pointer; }
.writing-os-header svg.spinning { animation: writing-os-spin .8s linear infinite; }
@keyframes writing-os-spin { to { transform: rotate(360deg); } }
.writing-os-tabs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin-top: 10px; padding: 3px; border-radius: 8px 8px 0 0; background: #e7ebe7; }
.writing-os-tabs button { min-height: 31px; border: 0; border-radius: 6px; color: var(--muted); background: transparent; cursor: pointer; font-size: 11px; font-weight: 700; }
.writing-os-tabs button.active { color: #0e665b; background: white; box-shadow: 0 1px 3px rgba(25, 46, 40, .1); }
.writing-os-tabs b { min-width: 17px; display: inline-block; margin-left: 3px; padding: 1px 4px; border-radius: 10px; color: white; background: #aa542b; font-size: 9px; }

.writing-dashboard, .candidate-board { display: grid; gap: 10px; padding: 11px; }
.dashboard-placeholder, .dashboard-error { margin: 0; padding: 18px 8px; color: var(--muted); text-align: center; font-size: 11px; line-height: 1.6; }
.dashboard-error { color: #8a3028; }
.readiness-card { display: grid; gap: 7px; padding: 13px; border: 1px solid; border-radius: 10px; }
.readiness-card.is-ready { border-color: #b8ddd1; background: linear-gradient(135deg, #e4f4ee, #f5faf7); }
.readiness-card.is-blocked { border-color: #efd0bd; background: linear-gradient(135deg, #fae9de, #fdf8f4); }
.readiness-card.is-debt { border-color: #ead49c; background: linear-gradient(135deg, #fbf1d6, #fdfaf2); }
.readiness-card.is-idle { border-color: #cddbd7; background: linear-gradient(135deg, #eaf1ef, #f7f9f8); }
.readiness-card > div { display: flex; align-items: center; gap: 7px; color: var(--accent); font-size: 11px; font-weight: 800; }
.readiness-card.is-blocked > div { color: #a04d2b; }
.readiness-card.is-debt > div { color: #8e6917; }
.readiness-card.is-idle > div { color: #526c66; }
.readiness-card > strong { font: 700 17px/1.35 "Songti SC", STSong, serif; }
.readiness-card > small { color: var(--muted); font-size: 10px; }
.dashboard-kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.dashboard-kpis > div { display: grid; gap: 3px; padding: 8px; border: 1px solid var(--line); border-radius: 7px; background: white; }
.dashboard-kpis span { color: var(--muted); font-size: 9px; }
.dashboard-kpis strong { font-size: 11px; }
.dashboard-section { padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: rgba(255, 255, 255, .72); }
.dashboard-section h3 { margin: 0 0 7px; font-size: 11px; }
.dashboard-section p { margin: 5px 0 0; color: var(--muted); font-size: 10px; line-height: 1.55; }
.dashboard-section header { display: flex; align-items: flex-start; justify-content: space-between; gap: 9px; }
.dashboard-section header > div { display: grid; gap: 3px; }
.dashboard-section header span { color: var(--muted); font-size: 9px; }
.dashboard-section header strong { font: 700 13px/1.35 "Songti SC", STSong, serif; }
.dashboard-section em, .candidate-detail > header em { flex: 0 0 auto; padding: 3px 6px; border-radius: 99px; font-size: 9px; font-style: normal; font-weight: 800; }
.status-committed, .probe-pass, .candidate-ready, .candidate-applied_recovery { color: #0d695c; background: #dcefe8; }
.status-missing, .status-stale, .status-writing_state_missing, .probe-machine_conflict, .candidate-stale_state, .candidate-stale_chapter, .candidate-out_of_order, .candidate-legacy { color: #934423; background: #f6e1d5; }
.probe-review_required { color: #856315; background: #f6edca; }
.probe-unavailable { color: #66716e; background: #e8ecea; }
.selected-state > button { width: 100%; min-height: 31px; margin-top: 8px; border: 1px solid #b8d8cf; border-radius: 6px; color: #0d695c; background: #edf7f3; cursor: pointer; font-size: 10px; font-weight: 700; }
.blockers article + article { margin-top: 7px; padding-top: 7px; border-top: 1px solid #eee5df; }
.blockers b { color: #9a4729; font: 700 9px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; }
.context-pack-receipt { margin-top: 9px; padding-top: 8px; border-top: 1px solid #e5ded8; }
.context-pack-receipt > summary, .receipt-trace > summary { color: var(--accent); cursor: pointer; font-size: 10px; font-weight: 800; }
.receipt-identities { display: grid; gap: 3px; margin-top: 7px; }
.receipt-identities code { overflow-wrap: anywhere; color: #52605c; font-size: 8px; }
.receipt-partitions, .receipt-trace ol { display: grid; gap: 5px; margin: 7px 0 0; padding: 0; list-style: none; }
.receipt-partitions li, .receipt-trace li { display: grid; gap: 2px; padding: 6px; border-radius: 6px; background: #f3f3ef; }
.receipt-partitions b, .receipt-trace b { font-size: 9px; }
.receipt-partitions span, .receipt-trace span { color: var(--muted); font-size: 8px; overflow-wrap: anywhere; }
.receipt-trace { margin-top: 8px; }
.receipt-trace .trace-omitted { background: #fbebe2; }
.probe-card ul { display: grid; gap: 6px; margin: 8px 0 0; padding: 0; list-style: none; }
.probe-card li { display: grid; gap: 2px; padding: 7px; border-radius: 6px; background: #f3f3ef; }
.probe-card li b { color: #9a4729; font-size: 9px; }
.probe-card li span { font-size: 10px; line-height: 1.45; }
.next-actions p { display: flex; gap: 5px; }
.next-actions p b { flex: 0 0 auto; color: var(--accent); }
.dashboard-limitation { margin: 0; padding: 2px 4px 12px; color: var(--muted); font-size: 9px; line-height: 1.55; }

.candidate-board > header { display: grid; gap: 4px; }
.candidate-board > header > div { display: flex; align-items: baseline; justify-content: space-between; }
.candidate-board > header strong { font-size: 12px; }
.candidate-board > header small, .candidate-board > header p { color: var(--muted); font-size: 10px; }
.candidate-board > header p { margin: 0; line-height: 1.5; }
.candidate-list { display: flex; gap: 5px; overflow-x: auto; padding-bottom: 2px; }
.candidate-list button { min-width: 120px; display: grid; gap: 3px; padding: 8px; border: 1px solid var(--line); border-radius: 7px; text-align: left; background: white; cursor: pointer; }
.candidate-list button.active { border-color: var(--accent); background: #e7f2ee; }
.candidate-list span { font-size: 10px; font-weight: 700; }
.candidate-list small { color: var(--muted); font-size: 9px; }
.candidate-detail { display: grid; gap: 10px; }
.candidate-detail > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 9px; padding: 11px; border-radius: 8px; color: #f4f5ef; background: #263c37; }
.candidate-detail > header > div { display: grid; gap: 5px; }
.candidate-detail > header span { color: #a9c7be; font-size: 9px; }
.candidate-detail > header strong { font: 600 13px/1.5 "Songti SC", STSong, serif; }
.candidate-status-message { margin: -3px 2px 0; color: var(--muted); font-size: 10px; line-height: 1.5; }
.candidate-audit { display: grid; gap: 6px; margin: 0; }
.candidate-audit > div { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 7px; padding: 7px; border: 1px solid var(--line); border-radius: 6px; background: white; }
.candidate-audit dt { color: var(--muted); font-size: 9px; }
.candidate-audit dd { margin: 0; font-size: 10px; line-height: 1.45; }
.no-change-declaration, .diff-change { padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: white; }
.no-change-declaration h3 { margin: 0 0 5px; color: var(--accent); font-size: 11px; }
.no-change-declaration p, .diff-change > p { margin: 0 0 8px; color: var(--muted); font-size: 10px; line-height: 1.55; }
.diff-change > header { display: grid; gap: 2px; margin-bottom: 6px; }
.diff-change > header span { color: var(--accent); font-size: 9px; font-weight: 800; }
.diff-change > header strong { font-size: 11px; }
.diff-table { overflow: hidden; border: 1px solid #e3e7e4; border-radius: 6px; }
.diff-table > div { display: grid; grid-template-columns: 62px minmax(0, 1fr) minmax(0, 1fr); }
.diff-table > div > * { min-width: 0; padding: 6px; border-right: 1px solid #e8ece9; overflow-wrap: anywhere; font-size: 9px; line-height: 1.45; }
.diff-table > div > *:last-child { border-right: 0; }
.diff-table > div + div { border-top: 1px solid #e8ece9; }
.diff-table .diff-head { color: var(--muted); background: #f1f3f0; }
.diff-table > div.changed { background: #fff9e7; }
.diff-table > div.changed > span:last-child { color: #0d695c; font-weight: 700; }
.diff-change blockquote, .no-change-declaration blockquote { display: grid; gap: 3px; margin: 8px 0 0; padding: 8px; border-left: 2px solid #cca04e; color: #5f625c; background: #faf5e8; font: 10px/1.55 "Songti SC", STSong, serif; }
.diff-change blockquote small { color: #987229; font: 8px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; }
.review-note { display: grid; gap: 5px; color: var(--muted); font-size: 9px; }
.review-note textarea { min-height: 58px; resize: vertical; padding: 8px; border: 1px solid var(--line); border-radius: 7px; outline: 0; background: white; font-size: 10px; line-height: 1.5; }
.review-note textarea:focus { border-color: var(--accent); }
.candidate-actions { display: grid; grid-template-columns: 1fr 1.6fr; gap: 7px; }
.candidate-actions button { min-height: 34px; border: 1px solid var(--line); border-radius: 7px; background: white; cursor: pointer; font-size: 10px; font-weight: 700; }
.candidate-warning { margin: -3px 0 0; color: #9b4a27; font-size: 9px; }
.memory-panel { min-height: 0; }

@media (max-width: 1050px) {
  .workspace-body { grid-template-columns: 230px minmax(400px, 1fr); }
  .memory-rail { display: none; }
  .novel-header { grid-template-columns: minmax(200px, 1fr) auto; }
  .workspace-switch { display: none; }
}
</style>
