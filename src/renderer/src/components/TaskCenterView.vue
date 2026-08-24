<template>
  <section class="task-center-view">
    <header class="module-header">
      <div><span class="eyebrow">Codex 接续</span><h2>任务中心</h2><p>每个任务包都可在应用关闭后由本地 MCP 继续领取。</p></div>
      <div class="module-actions">
        <button class="ghost-button" type="button" data-testid="task-center-refresh" :disabled="loading || Boolean(busyId)" :title="(loading || busyId) ? '正在处理，不能再刷新' : undefined" @click="refresh"><RefreshCw :size="15" /> 刷新</button>
        <button class="primary-button" type="button" data-testid="task-center-create-image" :disabled="loading || Boolean(busyId)" :title="(loading || busyId) ? '正在处理，不能再创建图片批次' : undefined" @click="create('image')"><PackagePlus :size="15" /> 下一图片批次</button>
        <button class="ghost-button" type="button" data-testid="task-center-create-video" :disabled="loading || Boolean(busyId)" :title="(loading || busyId) ? '正在处理，不能再创建视频批次' : undefined" @click="create('video')"><Film :size="15" /> 下一视频批次</button>
      </div>
    </header>

    <div class="task-layout">
      <section class="task-column">
        <div class="section-title"><span>任务包</span><small>{{ tasks.length }}</small></div>
        <article v-for="task in tasks" :key="task.id" class="task-pack" :class="`task-${task.status}`">
          <header><span>{{ task.kind === 'video' ? '视频批次' : '图片批次' }}</span><b>{{ statusText(task.status) }}</b></header>
          <h3>EP{{ String(task.episode ?? 0).padStart(2, "0") }} · {{ task.itemIds.length }} 个{{ task.itemSnapshots.every((item) => item.type === 'shot') ? '原镜头' : '单元' }}</h3>
          <div v-if="task.boundary" class="task-boundary"><span>{{ task.boundary.parentId ? '锁定同一父单元' : '锁定同一集' }}</span><span>上限 {{ task.boundary.maxItems }}</span><span>{{ task.boundary.pauseAfterVisualReview ? '视觉验收后暂停' : '连续批次' }}</span></div>
          <div v-if="task.lease" class="task-lease"><span>{{ task.lease.owner }}</span><span>租约至 {{ formatTime(task.lease.leaseUntil) }}</span><span>r{{ task.revision }}</span></div>
          <div v-else-if="task.result" class="task-lease"><span>{{ task.result.status === 'awaiting_review' ? '等待导演确认' : '批次结果已归档' }}</span><span>扫描 {{ task.result.verifiedScanId.slice(0,8) }}</span><span>r{{ task.revision }}</span></div>
          <p>{{ task.id }}</p>
          <ul><li v-for="item in task.itemSnapshots" :key="item.id"><span>{{ item.type === 'shot' ? `镜${item.shot} · ` : '' }}{{ item.title }}</span><small>{{ item.nextAction }}<template v-if="item.referencePaths?.length"> · {{ item.referencePaths.length }} 份参考</template></small></li></ul>
          <footer>
            <time>{{ formatTime(task.createdAt) }}</time>
            <button v-if="task.status === 'ready'" type="button" :disabled="loading || Boolean(busyId)" :title="(loading || busyId) ? '正在处理，不能再领取' : undefined" @click="claim(task)">领取</button>
            <button v-if="task.status === 'claimed' && task.lease?.owner === DESKTOP_AGENT" type="button" :disabled="busyId===task.id" @click="finish(task)">提交视觉验收</button>
            <button v-if="task.status === 'claimed' && task.lease?.owner === DESKTOP_AGENT" type="button" :disabled="busyId===task.id" @click="release(task)">释放</button>
            <button type="button" @click="revealTask(task.id)">文件</button>
          </footer>
        </article>
        <div v-if="!tasks.length" class="empty">尚未创建任务包</div>
      </section>

      <section class="event-column">
        <div class="section-title"><span>审计时间线</span><small>{{ events.length }}</small></div>
        <ol class="event-list">
          <li v-for="event in events" :key="event.id"><i></i><div><b>{{ eventTitle(event.type) }}</b><span>{{ formatTime(event.at) }} · {{ event.actor }}</span><small v-if="event.itemId">{{ event.itemId }}</small><small v-if="event.taskId">{{ event.taskId }}</small></div></li>
        </ol>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Film, PackagePlus, RefreshCw } from "lucide-vue-next";
import type { ProjectEvent, TaskPack } from "@core/types";

const props = defineProps<{ projectRoot: string }>();
const emit = defineEmits<{ changed: [message: string]; failed: [message: string] }>();
const tasks = ref<TaskPack[]>([]);
const events = ref<ProjectEvent[]>([]);
const loading = ref(false);
const busyId = ref("");
const DESKTOP_AGENT = "desktop-app";
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

onMounted(() => { void refresh(); heartbeatTimer = setInterval(() => void heartbeatOwnedTasks(), 60_000); });
onBeforeUnmount(() => { if (heartbeatTimer) clearInterval(heartbeatTimer); });
watch(() => props.projectRoot, refresh);

async function loadCenter(): Promise<void> {
  const result = await window.canvasApi.getTaskCenter(props.projectRoot);
  tasks.value = result.tasks;
  events.value = result.events;
}
async function refresh() {
  if (loading.value || busyId.value) return;
  loading.value = true;
  try { await loadCenter(); }
  finally { loading.value = false; }
}
async function create(kind: "image" | "video") {
  if (loading.value || busyId.value) return;
  loading.value = true;
  try {
    const result = await window.canvasApi.createTaskPack(props.projectRoot, { kind, mode: "autopilot" });
    emit("changed", `已创建 ${result.task.itemIds.length} 项${kind === "video" ? "视频" : "图片"}任务包`);
    await loadCenter();
  } finally { loading.value = false; }
}
async function claim(task: TaskPack) {
  if (loading.value || busyId.value) return;
  busyId.value = task.id;
  try {
    await window.canvasApi.claimTask(props.projectRoot, task.id, { agentId: DESKTOP_AGENT, leaseSeconds: 900, expectedRevision: task.revision });
    emit("changed", "桌面端已领取 15 分钟任务租约");
    await loadCenter();
  } catch(error) { emit("failed", message(error)); } finally { busyId.value = ""; }
}
async function finish(task: TaskPack) {
  if (!task.lease || loading.value || busyId.value) return;
  busyId.value = task.id;
  try {
    await window.canvasApi.finishBatch(props.projectRoot, task.id, { leaseId: task.lease.id, agentId: DESKTOP_AGENT, expectedRevision: task.revision, status: "completed", completedItemIds: task.itemIds, failedItemIds: [], note: "机械门禁通过，桌面端提交导演视觉验收。" });
    emit("changed", "批次已进入导演视觉验收，尚未宣告完成");
    await loadCenter();
  } catch(error) { emit("failed", message(error)); } finally { busyId.value = ""; }
}
async function release(task: TaskPack) {
  if (!task.lease || loading.value || busyId.value) return;
  busyId.value = task.id;
  try {
    await window.canvasApi.releaseTask(props.projectRoot, task.id, { leaseId: task.lease.id, agentId: DESKTOP_AGENT, expectedRevision: task.revision, reason: "桌面端主动释放" });
    emit("changed", "任务租约已释放");
    await loadCenter();
  } catch(error) { emit("failed", message(error)); } finally { busyId.value = ""; }
}
async function heartbeatOwnedTasks() { for (const task of tasks.value.filter((entry) => entry.status === "claimed" && entry.lease?.owner === DESKTOP_AGENT)) { try { const updated = await window.canvasApi.heartbeatTask(props.projectRoot, task.id, { leaseId: task.lease!.id, agentId: DESKTOP_AGENT, leaseSeconds: 900, expectedRevision: task.revision }); tasks.value = tasks.value.map((entry) => entry.id === updated.id ? updated : entry); } catch(error) { emit("failed", message(error)); await refresh(); } } }
function revealTask(id: string) { void window.canvasApi.showInFolder(`${props.projectRoot}/.aicanvas/tasks/${id}.json`); }
function statusText(status: TaskPack["status"]) { return ({ ready: "待领取", claimed: "进行中", awaiting_review: "待视觉验收", completed: "已完成", blocked: "阻塞", cancelled: "已取消" })[status]; }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function formatTime(value: string) { return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }
function eventTitle(type: string) { return ({ "project.imported": "项目导入确认", "project.scanned": "项目扫描", "project.config_updated": "项目设置更新", "story.source_imported": "原文导入与拆章", "story.event_upserted": "故事事件更新", "task.created": "任务创建", "task.claimed": "任务领取", "task.heartbeat": "任务租约续期", "task.released": "任务租约释放", "task.lease-expired": "任务租约过期", "task.review-completed": "任务视觉验收完成", "task.review-blocked": "任务视觉验收返工", "batch.finished": "批次提交验收", "item.status_updated": "状态更新", "artifact.registered": "素材登记", "artifact.authority_selected": "权威版本选择", "item.verified": "机械验收", "review.submitted": "导演视觉验收", "context.upserted": "项目记忆更新", "context.deleted": "项目记忆删除", "skill.saved": "项目 Skill 更新", "skill.deleted": "项目 Skill 删除", "handoff.created": "Codex 接续文件生成", "canvas.entity_upserted": "画布批注或分组更新", "canvas.link_upserted": "画布关系更新", "canvas.undo": "撤销画布操作", "canvas.redo": "重做画布操作", "document.created": "制作文档创建", "document.saved": "制作文档保存", "generation.settings_updated": "生成配置更新", "generation.enqueued": "加入生成队列", "generation.succeeded": "生成结果落盘", "generation.cancelled": "生成任务取消" } as Record<string,string>)[type] ?? type; }
</script>

<style scoped>
.task-boundary { display: flex; gap: 5px; margin: 8px 14px 0; }
.task-boundary span { padding: 4px 6px; border: 1px solid #3b3d35; color: #8b8e83; font-size: 7px; }
.task-lease { display: flex; gap: 8px; margin: 8px 14px 0; color: #8f927f; font: 7px Menlo,monospace; }
.task-center-view { height: 100%; overflow: auto; background: #121310; }.module-header { position: sticky; top: 0; z-index: 6; height: 92px; display: flex; align-items: center; justify-content: space-between; padding: 0 26px; border-bottom: 1px solid #30322c; background: rgba(18,19,16,.96); backdrop-filter: blur(12px); }.module-header h2 { margin: 6px 0 3px; font-size: 19px; }.module-header p { margin: 0; color: #83867b; font-size: 10px; }.module-actions { display: flex; gap: 8px; }.task-layout { display: grid; grid-template-columns: minmax(480px,1.5fr) minmax(300px,1fr); min-height: calc(100% - 92px); }.task-column,.event-column { padding: 22px 26px 70px; }.event-column { border-left: 1px solid #30322c; background: #151613; }.section-title { display: flex; justify-content: space-between; padding-bottom: 12px; color: #a6a99e; font-size: 10px; border-bottom: 1px solid #30322c; }.section-title small { color: #666960; }.task-pack { margin-top: 12px; border: 1px solid #34362f; background: #191a17; }.task-pack > header { height: 32px; display: flex; justify-content: space-between; align-items: center; padding: 0 12px; border-bottom: 1px solid #2d2f29; color: #d7af55; font-size: 9px; }.task-pack header b { color: #9da097; }.task-claimed { border-color: #5d5132; }.task-awaiting_review { border-color: #526247; }.task-completed { opacity: .62; }.task-blocked { border-color: #6b3b32; }.task-pack h3 { margin: 14px 14px 0; font-size: 12px; }.task-pack > p { margin: 6px 14px 10px; color: #62655c; font: 8px/1.4 Menlo,monospace; }.task-pack ul { max-height: 190px; overflow: auto; list-style: none; margin: 0; padding: 0 14px; border-top: 1px solid #292b25; }.task-pack li { display: grid; grid-template-columns: minmax(130px,1fr) 1fr; gap: 10px; padding: 8px 0; border-bottom: 1px solid #292b25; content-visibility: auto; contain-intrinsic-size: auto 32px; }.task-pack li span { font-size: 9px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }.task-pack li small { color: #777a70; font-size: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }.task-pack footer { min-height: 42px; display: flex; align-items: center; gap: 7px; padding: 0 12px; }.task-pack footer time { margin-right: auto; color: #696c63; font-size: 8px; }.task-pack footer button { height: 26px; border: 1px solid #3b3d35; background: transparent; color: #b9bbb2; font-size: 8px; cursor: pointer; }.task-pack footer button:hover { border-color: #6b5b31; color: #d7af55; }.event-list { list-style: none; margin: 16px 0 0; padding: 0; }.event-list li { display: flex; gap: 11px; min-height: 54px; content-visibility: auto; contain-intrinsic-size: auto 54px; }.event-list i { flex: 0 0 auto; width: 7px; height: 7px; margin-top: 3px; border-radius: 50%; background: #666960; box-shadow: 0 0 0 4px #242620; }.event-list li:not(:last-child) i::after { content: ""; display: block; width: 1px; height: 48px; margin: 7px 0 0 3px; background: #30322c; }.event-list b,.event-list span,.event-list small { display: block; }.event-list b { font-size: 9px; }.event-list span { margin-top: 4px; color: #777a70; font-size: 8px; }.event-list small { margin-top: 4px; max-width: 270px; color: #5e6158; font: 7px/1.4 Menlo,monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }.empty { padding: 80px 0; color: #62655c; text-align: center; font-size: 10px; }
</style>
