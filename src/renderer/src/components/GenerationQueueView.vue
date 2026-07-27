<template>
  <section class="generation-view">
    <header class="module-header">
      <div><span class="eyebrow">生成调度</span><h2>可恢复生成队列</h2><p>网页付费提交先持久化意图；回执不明只对账、不重提。结果始终落到新路径。</p></div>
      <div class="module-actions"><button class="ghost-button" type="button" @click="settingsOpen = !settingsOpen"><SlidersHorizontal :size="15" /> 供应商</button><button class="primary-button" type="button" :disabled="busy" @click="refresh"><RefreshCw :size="15" :class="{ spinning: busy }" /> 只读刷新</button></div>
    </header>

    <div class="queue-toolbar">
      <select v-model="kind"><option value="image">图片队列</option><option value="video">视频队列</option></select>
      <select v-model="providerId"><option v-for="provider in availableProviders" :key="provider.id" :value="provider.id">{{ provider.name }}</option></select>
      <select v-model="episode"><option value="all">自动选择最高优先级</option><option v-for="value in episodes" :key="value" :value="String(value)">EP{{ String(value).padStart(2,'0') }}</option></select>
      <div class="queue-tabs" data-testid="generation-queue-lumen-tabs" role="tablist">
        <button type="button" role="tab" :class="{ active: queueTab === 'active' }" data-queue-tab="active" @click="queueTab = 'active'">进行中 {{ queueView.totals.active }}</button>
        <button type="button" role="tab" :class="{ active: queueTab === 'done' }" data-queue-tab="done" @click="queueTab = 'done'">已完成 {{ queueView.totals.done }}</button>
        <button type="button" role="tab" :class="{ active: queueTab === 'failed' }" data-queue-tab="failed" @click="queueTab = 'failed'">失败 {{ queueView.totals.failed }}</button>
      </div>
      <button
        v-if="!isManagedEmbed"
        type="button"
        data-testid="generation-queue-enqueue"
        :disabled="busy || !index"
        @click="enqueueNext"><Plus :size="14" /> 加入下一批</button>
      <span v-if="isManagedEmbed" class="managed-queue-hint" data-testid="generation-queue-managed-hint">受管壳：观察/取消/跳转/预览 · 派发走画布工作流或 MCP</span>
      <span data-testid="generation-queue-inflight">进行中 {{ queueView.inFlightCount }} · 并发 {{ settings?.concurrency ?? 1 }} · 本类 {{ kindScopedJobs.length }}</span>
    </div>

    <div class="queue-body" :class="{ 'with-settings': settingsOpen }">
      <section class="job-list">
        <article v-for="job in filteredJobs" :key="job.id" class="job-row" :class="`job-${job.status}`">
          <span class="job-state"><i></i>{{ statusLabel(job.status, job.subagentCheckpoint?.stage ?? job.browserCheckpoint?.stage) }}</span>
          <div class="job-main"><b>{{ itemTitle(job.itemId) }}</b><small>{{ job.id }}</small><p>{{ job.prompt }}</p></div>
          <div class="job-route"><span>{{ providerName(job.providerId) }}<template v-if="job.externalTaskId"> · {{ job.externalTaskId }}</template></span><small v-if="job.executionSnapshot">快照 {{ job.executionSnapshot.snapshotHash.slice(0,12) }}<template v-if="job.executionSnapshot.workflowHash"> · 工作流 {{ job.executionSnapshot.workflowHash.slice(0,12) }}</template></small><small v-if="job.comfyUiCheckpoint" class="comfy-checkpoint">ComfyUI {{ job.comfyUiCheckpoint.stage }} · R{{ job.comfyUiCheckpoint.revision }} · prompt {{ job.comfyUiCheckpoint.promptId.slice(0,8) }}<template v-if="job.comfyUiCheckpoint.output"> · {{ job.comfyUiCheckpoint.output.nodeId }}[{{ job.comfyUiCheckpoint.output.index }}] / {{ job.comfyUiCheckpoint.output.filename }}</template></small><small v-if="job.comfyUiCheckpoint?.stage === 'submission_unknown'" class="submit-intent">稳定 promptId 已保存 · 只查 queue/history · 禁止重 POST</small><small v-if="job.subagentCheckpoint" class="subagent-checkpoint">一图一代理 {{ job.subagentCheckpoint.stage }} · R{{ job.subagentCheckpoint.revision }}<template v-if="job.subagentCheckpoint.lease"> · {{ job.subagentCheckpoint.lease.agentTaskName }}</template></small><small v-if="job.subagentCheckpoint?.lease" class="subagent-lease">租约 {{ job.subagentCheckpoint.lease.leaseId.slice(0,18) }}… · owner {{ job.subagentCheckpoint.lease.owner ?? 'legacy-unknown' }} · fence {{ job.subagentCheckpoint.lease.fence ?? '—' }}</small><small v-if="job.subagentCheckpoint?.lease" class="subagent-lease">心跳 {{ job.subagentCheckpoint.lease.heartbeatAt ?? '无' }} · 到期 {{ job.subagentCheckpoint.lease.leaseUntil ?? '无 TTL' }} · {{ leaseState(job) }}</small><small v-if="job.subagentCheckpoint?.callIntent" class="submit-intent">调用意图 {{ job.subagentCheckpoint.callIntent.callId }} · run {{ job.subagentCheckpoint.callIntent.runId }} · 最多 1 次</small><small v-if="job.subagentCheckpoint?.unknown" class="generation-unknown">调用归因不明：{{ job.subagentCheckpoint.unknown.code }} · 禁止取消、接管、重生</small><small v-if="job.subagentCheckpoint?.output" class="subagent-output">隔离 SHA {{ job.subagentCheckpoint.output.isolatedSha256.slice(0,16) }} · {{ job.subagentCheckpoint.output.bytes }} bytes</small><small v-if="job.subagentCheckpoint?.publicationBundle" class="subagent-output">事务 {{ job.subagentCheckpoint.publicationBundle.bundleId }} · {{ job.subagentCheckpoint.publicationBundle.stage }}</small><small v-if="job.browserCheckpoint" class="browser-checkpoint">网页{{ job.subagentCheckpoint?.migratedFrom ? '历史' : ''}} {{ job.browserCheckpoint.stage }} · R{{ job.browserCheckpoint.revision || 1 }}<template v-if="job.browserCheckpoint.executionSurface"> · {{ job.browserCheckpoint.executionSurface.id }}@{{ job.browserCheckpoint.executionSurface.version }}</template><template v-if="job.browserCheckpoint.uploadEvidence"> · {{ job.browserCheckpoint.uploadEvidence.files.length ? `已核 ${job.browserCheckpoint.uploadEvidence.files.length} 个槽位` : 'text-only · 已确认零上传' }}</template></small><small v-if="job.browserCheckpoint?.stage === 'preflight_blocked' && !job.subagentCheckpoint" class="preflight-blocked">点击前已停止 · {{ preflightBlockers(job) }}</small><small v-if="job.browserCheckpoint?.submissionIntent" class="submit-intent">提交意图已保存 · 第 {{ job.browserCheckpoint.submissionIntent.attempt }} 次 · 禁止自动重提</small><small v-if="job.browserCheckpoint?.uploadEvidence?.files.length" class="upload-slots">{{ job.browserCheckpoint.uploadEvidence.files.map(file=>`${file.role}→${file.slot}`).join(' · ') }}</small><small>{{ job.expectedOutputPath }}</small><small v-if="job.expectedCompanionPath">配对：{{ job.expectedCompanionPath }}</small></div>
          <div class="job-actions">
            <button
              v-if="queueMeta(job).canPreview"
              type="button"
              data-testid="generation-queue-preview"
              @click="previewJob(job)">预览</button>
            <button
              v-if="queueMeta(job).canJump"
              type="button"
              data-testid="generation-queue-jump"
              @click="jumpJob(job)">跳转</button>
            <button v-if="job.requestPath" type="button" @click="reveal(job.requestPath)">请求单</button>
            <button v-if="job.subagentCheckpoint?.output?.isolatedPath" type="button" @click="reveal(job.subagentCheckpoint.output.isolatedPath)">候选</button>
            <button v-if="job.resultPath" type="button" @click="reveal(job.resultPath)">raw</button>
            <button v-if="job.companionPath" type="button" @click="reveal(job.companionPath)">labeled</button>
            <button v-if="canProcess(job)" type="button" @click="processJob(job.id)">定向处理</button>
            <button v-if="canReviewCandidate(job)" type="button" @click="reviewCandidate(job, 'visual_accept')">视觉通过</button>
            <button v-if="canReviewCandidate(job)" type="button" @click="reviewCandidate(job, 'visual_rejected')">视觉返工</button>
            <button
              v-if="canCancel(job)"
              type="button"
              data-testid="generation-queue-cancel"
              @click="cancel(job.id)">取消</button>
          </div>
          <div
            v-if="previewJobId === job.id && queueMeta(job).previewPath"
            class="job-preview"
            data-testid="generation-queue-preview-panel">
            <span>预览 · {{ queueMeta(job).previewKind }}</span>
            <code>{{ queueMeta(job).previewPath }}</code>
          </div>
        </article>
        <div v-if="!filteredJobs.length" class="queue-empty"><Workflow :size="28" /><span>队列中暂无{{ kind === 'image' ? '图片' : '视频' }}任务</span></div>
      </section>

      <aside v-if="settingsOpen" class="provider-settings">
        <header><div><span class="eyebrow">适配器</span><h3>供应商与桥接</h3></div><button type="button" @click="addProvider"><Plus :size="15" /></button></header>
        <div class="settings-scroll">
          <section v-for="provider in settings?.providers" :key="provider.id" class="provider-editor">
            <div class="provider-head"><input v-model="provider.name" /><label><input v-model="provider.enabled" type="checkbox" /> 启用</label></div>
            <label><span>ID</span><input v-model="provider.id" /></label>
            <label><span>适配器</span><select v-model="provider.adapter" @change="configureAdapter(provider)"><option value="folder-bridge">落盘桥接</option><option value="comfyui-local">ComfyUI 本机</option><option value="codex-browser">Codex 浏览器</option><option value="codex-subagent-imagegen">Codex 一图一子代理</option><option value="http-json">HTTP JSON</option><option value="mock">Mock 验证</option></select></label>
            <label><span>能力</span><select :value="provider.kinds.join(',')" @change="provider.kinds = ($event.target as HTMLSelectElement).value.split(',') as GenerationKind[]"><option value="image">图片</option><option value="video">视频</option><option value="image,video">图片 + 视频</option></select></label>
            <label><span>模型</span><input v-model="provider.model" placeholder="可选模型标识" /></label>
            <section v-if="provider.adapter !== 'codex-subagent-imagegen'" class="workflow-editor">
              <header><div><b>可复现工作流</b><small v-if="provider.workflowHash">SHA-256 {{ provider.workflowHash.slice(0,16) }}</small></div><button type="button" @click="toggleWorkflow(provider)">{{ provider.workflow ? '移除' : '添加' }}</button></header>
              <template v-if="provider.workflow">
                <label><span>名称</span><input v-model="provider.workflow.name" placeholder="例如：ComfyUI 角色一致性生图" /></label>
                <label><span>版本</span><input v-model="provider.workflow.version" placeholder="例如：2026.07.13" /></label>
                <label><span>格式</span><select v-model="provider.workflow.format"><option value="generic-json">通用 JSON</option><option value="comfyui-api">ComfyUI API</option><option value="browser-recipe">网页操作配方</option></select></label>
                <label class="workflow-json"><span>定义 JSON</span><textarea :value="workflowDraft(provider)" rows="9" spellcheck="false" placeholder="粘贴真实工作流 JSON；凭据请使用 apiKeyEnv，不得写进这里。" @input="setWorkflowDraft(provider, ($event.target as HTMLTextAreaElement).value)"></textarea></label>
                <template v-if="provider.adapter === 'comfyui-local' && provider.workflow.comfyUi">
                  <label><span>提示词绑定</span><input :value="promptBindings(provider)" @change="setPromptBindings(provider, ($event.target as HTMLInputElement).value)" placeholder="6.text, 7.text" /></label>
                  <label><span>输出节点</span><input v-model="provider.workflow.comfyUi.outputNodeId" placeholder="例如 9" /></label>
                  <label><span>输出索引</span><input v-model.number="provider.workflow.comfyUi.outputIndex" type="number" min="0" max="99" /></label>
                </template>
                <p>保存时检查结构、深度、体积与凭据字段；任务入队后冻结版本，旧任务不会跟随配置漂移。</p>
              </template>
            </section>
            <template v-if="provider.adapter === 'comfyui-local'">
              <label><span>本机地址</span><input v-model="provider.endpoint" placeholder="http://127.0.0.1:8188" /></label>
              <p class="comfy-boundary">仅允许 localhost / 127.0.0.1 / [::1]，首版只生成图片。成功以绑定 official prompt tuple 的 history 输出为准；取消只用原子 jobs 接口，running 必须等 exact execution_interrupted，未确认时保持锁定。</p>
            </template>
            <template v-if="provider.adapter === 'http-json'">
              <label><span>提交地址</span><input v-model="provider.endpoint" placeholder="https://.../tasks" /></label>
              <label><span>轮询地址</span><input v-model="provider.pollEndpoint" placeholder="https://.../tasks/{taskId}" /></label>
              <label><span>取消地址</span><input v-model="provider.cancelEndpoint" placeholder="https://.../tasks/{taskId}/cancel" /></label>
              <label><span>取消方法</span><select v-model="provider.cancelMethod"><option value="POST">POST</option><option value="DELETE">DELETE</option></select></label>
              <label><span>支持取消</span><input v-model="provider.capabilities!.supportsCancel" type="checkbox" /></label>
              <label><span>密钥环境变量</span><input v-model="provider.apiKeyEnv" placeholder="PROVIDER_API_KEY" /></label>
              <label><span>任务 ID 路径</span><input v-model="provider.taskIdPath" placeholder="data.id" /></label>
              <label><span>状态路径</span><input v-model="provider.statusPath" placeholder="data.status" /></label>
              <label><span>结果 URL 路径</span><input v-model="provider.resultUrlPath" placeholder="data.url" /></label>
              <label><span>结果域名</span><input :value="provider.allowedResultHosts?.join(',')" @change="provider.allowedResultHosts = ($event.target as HTMLInputElement).value.split(',').map(v=>v.trim()).filter(Boolean)" placeholder="cdn.example.com" /></label>
              <label><span>本机 / 私网</span><input v-model="provider.allowPrivateNetwork" type="checkbox" /></label>
              <label><span>发送本机路径</span><input v-model="provider.sendLocalPaths" type="checkbox" /></label>
            </template>
            <template v-if="provider.adapter === 'codex-browser'">
              <label><span>网站地址</span><input v-model="provider.siteUrl" placeholder="https://生成网站/..." /></label>
              <label class="browser-notes"><span>操作说明</span><textarea v-model="provider.browserInstructions" rows="5" placeholder="例如：使用 Seedance 2.0、9:16、10 秒；首帧放槽位 1，尾帧放槽位 2。"></textarea></label>
              <label><span>参考模式</span><input :value="provider.capabilities?.referenceModes.join(',')" @change="provider.capabilities!.referenceModes = ($event.target as HTMLInputElement).value.split(',').map(v=>v.trim()).filter(Boolean) as GenerationReferenceMode[]" placeholder="first_last_frame,multi_image" /></label>
              <label><span>参考图片上限</span><input v-model.number="provider.capabilities!.maxReferenceImages" type="number" min="0" max="100" /></label>
              <label><span>参考视频上限</span><input v-model.number="provider.capabilities!.maxReferenceVideos" type="number" min="0" max="10" /></label>
              <label><span>视频时长</span><input :value="provider.capabilities?.supportedDurations.join(',')" @change="provider.capabilities!.supportedDurations = ($event.target as HTMLInputElement).value.split(',').map(Number).filter(v=>Number.isFinite(v)&&v>0)" placeholder="5,10,15" /></label>
              <label><span>画幅</span><input :value="provider.capabilities?.supportedAspectRatios.join(',')" @change="provider.capabilities!.supportedAspectRatios = ($event.target as HTMLInputElement).value.split(',').map(v=>v.trim()).filter(Boolean)" placeholder="9:16,16:9" /></label>
              <label><span>分辨率</span><input :value="provider.capabilities?.supportedResolutions.join(',')" @change="provider.capabilities!.supportedResolutions = ($event.target as HTMLInputElement).value.split(',').map(v=>v.trim()).filter(Boolean)" placeholder="720p,1080p" /></label>
              <label><span>站点并发</span><input v-model.number="provider.capabilities!.maxConcurrency" type="number" min="1" max="20" /></label>
              <label><span>支持取消</span><input v-model="provider.capabilities!.supportsCancel" type="checkbox" /></label>
            </template>
            <template v-if="provider.adapter === 'codex-subagent-imagegen'">
              <label class="subagent-notes"><span>冻结约束</span><textarea v-model="provider.subagentInstructions" rows="9" placeholder="逐项写明人物脸型与服装、场景布局、道具结构、时代与写实风格、禁项；每个图片代理必须收到同一份冻结约束。"></textarea></label>
              <label><span>参考模式</span><input :value="provider.capabilities?.referenceModes.join(',')" @change="provider.capabilities!.referenceModes = ($event.target as HTMLInputElement).value.split(',').map(v=>v.trim()).filter(Boolean) as GenerationReferenceMode[]" placeholder="text,multi_image" /></label>
              <label><span>参考图上限</span><input v-model.number="provider.capabilities!.maxReferenceImages" type="number" min="0" max="6" /></label>
              <label><span>画幅</span><input :value="provider.capabilities?.supportedAspectRatios.join(',')" @change="provider.capabilities!.supportedAspectRatios = ($event.target as HTMLInputElement).value.split(',').map(v=>v.trim()).filter(Boolean)" placeholder="9:16" /></label>
              <label><span>分辨率</span><input :value="provider.capabilities?.supportedResolutions.join(',')" @change="provider.capabilities!.supportedResolutions = ($event.target as HTMLInputElement).value.split(',').map(v=>v.trim()).filter(Boolean)" placeholder="Medium" /></label>
              <label><span>固定并发</span><input :value="1" type="number" disabled /></label>
              <p class="subagent-boundary">严格串行：一张图只领取一个唯一租约，只调用一次生图；代理只写隔离候选文件，主代理统一做视觉验收、Publication 与硬锁决策。</p>
            </template>
            <label><span>输出根</span><input v-model="provider.outputRoot" /></label>
          </section>
          <section class="defaults" v-if="settings"><label><span>图片默认</span><select v-model="settings.defaultImageProviderId"><option v-for="provider in imageProviders" :key="provider.id" :value="provider.id">{{ provider.name }}</option></select></label><label><span>视频默认</span><select v-model="settings.defaultVideoProviderId"><option v-for="provider in videoProviders" :key="provider.id" :value="provider.id">{{ provider.name }}</option></select></label><label><span>并发</span><input v-if="!strictSequential" v-model.number="settings.concurrency" type="number" min="1" max="8" /><input v-else :value="1" type="number" disabled /></label><p v-if="strictSequential" class="subagent-boundary">一图一代理项目固定项目并发 1；UI 不允许放宽，避免未知调用与新任务重叠。</p></section>
        </div>
        <footer><button class="primary-button" type="button" @click="saveSettings"><Save :size="14" /> 保存配置</button></footer>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { Plus, RefreshCw, Save, SlidersHorizontal, Workflow } from "lucide-vue-next";
import type { GenerationJob, GenerationJobStatus, GenerationKind, GenerationProvider, GenerationReferenceMode, GenerationSettings, GenerationWorkflowJsonValue, ProjectIndex } from "@core/types";
import {
  buildStudioGenerationQueueView,
  resolveStudioGenerationQueueJumpTarget,
  type StudioGenerationQueueBucket,
} from "@core/studio-generation-queue-view";

const props = defineProps<{
  projectRoot: string;
  /** 遗留扫描工程索引；受管 Studio 可省略（队列只读 + cancel/jump/preview） */
  index?: ProjectIndex | null;
  /** 受管壳嵌入时隐藏依赖 legacy 批次入队的控件 */
  managedEmbed?: boolean;
}>();
const emit = defineEmits<{
  changed: [message: string];
  failed: [message: string];
  jump: [payload: { kind: string; targetId: string; jobId: string; unitId?: string; panelId?: string }];
}>();
const jobs = ref<GenerationJob[]>([]); const settings = ref<GenerationSettings | null>(null); const kind = ref<GenerationKind>("image"); const providerId = ref(""); const episode = ref("all"); const busy = ref(false); const settingsOpen = ref(false); const workflowDrafts = ref<Record<string,string>>({});
const queueTab = ref<StudioGenerationQueueBucket>("active");
const previewJobId = ref<string | null>(null);
const isManagedEmbed = computed(() => Boolean(props.managedEmbed || !props.index));
const episodes = computed(() => {
  const items = props.index?.items ?? [];
  return [...new Set(items.filter((item) => item.type === "unit" && item.episode).map((item) => item.episode as number))].sort((a,b)=>a-b);
});
const availableProviders = computed(() => settings.value?.providers.filter((provider) => provider.enabled && provider.kinds.includes(kind.value)) ?? []);
const imageProviders = computed(() => settings.value?.providers.filter((provider) => provider.kinds.includes("image")) ?? []); const videoProviders = computed(() => settings.value?.providers.filter((provider) => provider.kinds.includes("video")) ?? []);
const strictSequential = computed(() => settings.value?.providers.some((provider) => provider.enabled && provider.adapter === "codex-subagent-imagegen") ?? false);
const kindScopedJobs = computed(() => jobs.value.filter((job) => job.kind === kind.value));
const queueView = computed(() => buildStudioGenerationQueueView(
  kindScopedJobs.value.map((job) => {
    const previewPath = job.resultPath
      || job.companionPath
      || job.subagentCheckpoint?.output?.isolatedPath
      || undefined;
    const panelId = job.fusionStoryboardPanel?.panelId;
    // 受管壳：无 panel 时把 itemId 当作 unit 跳转目标；遗留壳保留 item 语义
    const unitIdForJump = isManagedEmbed.value && !panelId ? job.itemId : undefined;
    return {
      id: job.id,
      status: job.status,
      label: itemTitle(job.itemId),
      itemId: job.itemId,
      ...(panelId ? { panelId } : {}),
      ...(unitIdForJump ? { unitId: unitIdForJump } : {}),
      createdAt: job.createdAt,
      provider: job.providerId,
      previewPath,
      previewKind: job.kind === "video" ? "video" as const : previewPath ? "image" as const : "none" as const,
      canCancel: canCancel(job),
    };
  }),
  { activeTab: queueTab.value },
));
const filteredJobs = computed(() => {
  const ids = new Set(queueView.value.visible.map((task) => task.id));
  return kindScopedJobs.value.filter((job) => ids.has(job.id));
});
function queueMeta(job: GenerationJob) {
  return queueView.value.visible.find((t) => t.id === job.id)
    ?? queueView.value.tabs.active.find((t) => t.id === job.id)
    ?? queueView.value.tabs.done.find((t) => t.id === job.id)
    ?? queueView.value.tabs.failed.find((t) => t.id === job.id)
    ?? {
      canPreview: false,
      canJump: Boolean(job.itemId),
      canCancel: canCancel(job),
      previewPath: undefined,
      previewKind: "none" as const,
      unitId: undefined as string | undefined,
      panelId: undefined as string | undefined,
    };
}
function previewJob(job: GenerationJob) {
  previewJobId.value = previewJobId.value === job.id ? null : job.id;
  const path = job.resultPath || job.companionPath || job.subagentCheckpoint?.output?.isolatedPath;
  if (path) emit("changed", `队列预览：${path}`);
}
function jumpJob(job: GenerationJob) {
  const meta = queueMeta(job);
  const fusionPanelId = job.fusionStoryboardPanel?.panelId;
  const target = resolveStudioGenerationQueueJumpTarget({
    id: job.id,
    itemId: job.itemId,
    unitId: "unitId" in meta ? meta.unitId : undefined,
    panelId: ("panelId" in meta ? meta.panelId : undefined) ?? fusionPanelId,
  });
  emit("jump", {
    kind: target.kind,
    targetId: target.targetId,
    jobId: job.id,
    ...(target.unitId ? { unitId: target.unitId } : {}),
    ...(target.panelId ? { panelId: target.panelId } : {}),
  });
  emit("changed", `跳转到 ${target.kind}:${target.targetId}`);
}
watch(kind, () => providerId.value = kind.value === "image" ? settings.value?.defaultImageProviderId ?? availableProviders.value[0]?.id ?? "" : settings.value?.defaultVideoProviderId ?? availableProviders.value[0]?.id ?? "");
watch(() => props.projectRoot, load);
onMounted(load);
async function load() { settings.value = clone(await window.canvasApi.getGenerationSettings(props.projectRoot)); resetWorkflowDrafts(); jobs.value = await window.canvasApi.listGenerationJobs(props.projectRoot); providerId.value = settings.value.defaultImageProviderId ?? availableProviders.value[0]?.id ?? ""; }
async function refresh(){ busy.value=true; try{ await load(); emit("changed","生成队列已只读刷新；未提交、未轮询、未取消任何任务"); }catch(error){ emit("failed",message(error)); }finally{ busy.value=false; } }
async function enqueueNext() {
  if (!props.index?.items?.length) {
    emit("failed", "受管工程请从画布工作流 / MCP freeze-dispatch 派发；本队列仅观察与取消/跳转/预览。");
    return;
  }
  busy.value = true;
  try {
    const candidates = props.index.items.filter((item) => item.type === "unit" && !["已完成","弃用","阻塞"].includes(item.status) && (episode.value === "all" || item.episode === Number(episode.value)) && (kind.value === "video" ? ["待视频","待视频验收"].includes(item.status) : !["待视频","待视频验收","视频生成中"].includes(item.status))).sort((a,b)=>a.priority-b.priority || (a.episode??0)-(b.episode??0) || (a.unit??0)-(b.unit??0));
    const firstEpisode = candidates[0]?.episode;
    const limit = kind.value === "video" ? props.index.project.automation.videoBatchSize : props.index.project.automation.imageBatchSize;
    const itemIds = candidates.filter((item)=>item.episode===firstEpisode).slice(0,limit).map((item)=>item.id);
    const created = await window.canvasApi.enqueueGeneration(props.projectRoot,{ itemIds,kind:kind.value,providerId:providerId.value });
    jobs.value = await window.canvasApi.listGenerationJobs(props.projectRoot);
    emit("changed", `已加入 ${created.length} 个${kind.value === 'image' ? '图片' : '视频'}生成任务`);
  } catch(error){ emit("failed", message(error)); } finally { busy.value=false; }
}
async function processJob(id:string){ busy.value=true; try { jobs.value=await window.canvasApi.processGenerationQueue(props.projectRoot,id); emit("changed",`仅处理指定生成任务 ${id}`); } catch(error){ emit("failed",message(error)); } finally { busy.value=false; } }
async function cancel(id:string){ try { await window.canvasApi.cancelGenerationJob(props.projectRoot,id); jobs.value=await window.canvasApi.listGenerationJobs(props.projectRoot); emit("changed","生成任务已取消"); } catch(error){ emit("failed",message(error)); } }
async function reviewCandidate(job:GenerationJob,status:"visual_accept"|"visual_rejected"){ const checkpoint=job.subagentCheckpoint; const lease=checkpoint?.lease; const call=checkpoint?.callIntent; if(!checkpoint||!lease?.owner||!lease.fence||!call)return; const promptText=status==="visual_accept"?"请填写人物、场景、道具、风格一致性通过说明：":"请填写具体视觉返工原因："; const note=window.prompt(promptText,"")?.trim(); if(!note)return; busy.value=true; try{ await window.canvasApi.updateSubagentImageGenerationJob(props.projectRoot,job.id,{expectedRevision:checkpoint.revision,status,agentTaskName:lease.agentTaskName,owner:lease.owner,leaseId:lease.leaseId,fence:lease.fence,runId:call.runId,callId:call.callId,reviewer:"/root/ui_visual_reviewer",note}); jobs.value=await window.canvasApi.listGenerationJobs(props.projectRoot); emit("changed",status==="visual_accept"?"候选已通过视觉验收并完成 raw/labeled 事务发布":"候选已登记视觉返工，隔离证据已保留"); }catch(error){emit("failed",message(error));}finally{busy.value=false;} }
async function saveSettings(){ if(!settings.value)return; try { if(strictSequential.value)settings.value.concurrency=1; for(const provider of settings.value.providers){ if(provider.adapter==="codex-subagent-imagegen"&&provider.capabilities)provider.capabilities.maxConcurrency=1; if(!provider.workflow)continue; let parsed:unknown; try{ parsed=JSON.parse(workflowDraft(provider)); }catch{ throw new Error(`${provider.name} 的工作流不是有效 JSON`); } if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw new Error(`${provider.name} 的工作流必须是 JSON 对象`); provider.workflow.definition=parsed as Record<string,GenerationWorkflowJsonValue>; } settings.value=clone(await window.canvasApi.saveGenerationSettings(props.projectRoot,clone(settings.value))); resetWorkflowDrafts(); emit("changed","生成供应商配置与工作流快照已保存"); } catch(error){ emit("failed",message(error)); } }
function addProvider(){ if(!settings.value)return; const now=new Date().toISOString(); settings.value.providers.push({id:`provider-${crypto.randomUUID().slice(0,8)}`,name:"新落盘桥接",adapter:"folder-bridge",kinds:[kind.value],enabled:true,capabilities:{referenceModes:["text","first_frame","last_frame","first_last_frame","multi_image","video_reference"],maxReferenceImages:12,maxReferenceVideos:1,supportedDurations:[5,10,15],supportedAspectRatios:["9:16","16:9","1:1"],supportedResolutions:["720p","1080p"],models:[],maxConcurrency:2,supportsCancel:false},outputRoot:props.projectRoot,createdAt:now,updatedAt:now}); }
function configureAdapter(provider:GenerationProvider){
  if(provider.adapter==="codex-subagent-imagegen"){
    provider.kinds=["image"];
    provider.endpoint=undefined; provider.pollEndpoint=undefined; provider.cancelEndpoint=undefined; provider.apiKeyEnv=undefined; provider.siteUrl=undefined; provider.browserInstructions=undefined; provider.sendLocalPaths=undefined; provider.allowedResultHosts=undefined; provider.allowPrivateNetwork=undefined; provider.workflow=undefined; provider.workflowHash=undefined;
    provider.subagentInstructions ||= "每次只启动一个图片代理且只生成一张图；完整传入已冻结的人物、场景、道具、时代与风格约束。代理只产出隔离候选图，不得自行验收、硬锁或写正式输出。";
    if(provider.capabilities){ provider.capabilities.referenceModes=["text","multi_image"]; provider.capabilities.maxReferenceImages=Math.min(6,provider.capabilities.maxReferenceImages||6); provider.capabilities.maxReferenceVideos=0; provider.capabilities.supportedDurations=[]; provider.capabilities.supportedAspectRatios=["9:16"]; provider.capabilities.supportedResolutions=["Medium"]; provider.capabilities.maxConcurrency=1; provider.capabilities.supportsCancel=false; }
    resetWorkflowDrafts(); return;
  }
  provider.subagentInstructions=undefined;
  if(provider.adapter!=="comfyui-local")return;
  provider.kinds=["image"]; provider.endpoint ||= "http://127.0.0.1:8188"; provider.pollEndpoint=undefined; provider.cancelEndpoint=undefined; provider.apiKeyEnv=undefined; provider.siteUrl=undefined; provider.sendLocalPaths=undefined; provider.allowedResultHosts=undefined; provider.allowPrivateNetwork=true; if(provider.capabilities){provider.capabilities.supportsCancel=true;provider.capabilities.maxReferenceVideos=0;} if(!provider.workflow||provider.workflow.format!=="comfyui-api")provider.workflow={schemaVersion:1,name:`${provider.name} 工作流`,version:"1",format:"comfyui-api",definition:{},comfyUi:{promptInputs:[{nodeId:"6",inputName:"text"}],outputNodeId:"9",outputIndex:0}}; else provider.workflow.comfyUi ??={promptInputs:[{nodeId:"6",inputName:"text"}],outputNodeId:"9",outputIndex:0}; resetWorkflowDrafts();
}
function toggleWorkflow(provider:GenerationProvider){ if(provider.workflow){ provider.workflow=undefined; provider.workflowHash=undefined; delete workflowDrafts.value[provider.id]; return; } provider.workflow={schemaVersion:1,name:`${provider.name} 工作流`,version:"1",format:provider.adapter==="codex-browser"?"browser-recipe":provider.adapter==="comfyui-local"?"comfyui-api":"generic-json",definition:{},comfyUi:provider.adapter==="comfyui-local"?{promptInputs:[{nodeId:"6",inputName:"text"}],outputNodeId:"9",outputIndex:0}:undefined}; workflowDrafts.value[provider.id]="{}"; }
function promptBindings(provider:GenerationProvider){ return provider.workflow?.comfyUi?.promptInputs.map(binding=>`${binding.nodeId}.${binding.inputName}`).join(", ")??""; }
function setPromptBindings(provider:GenerationProvider,value:string){ if(!provider.workflow?.comfyUi)return; provider.workflow.comfyUi.promptInputs=value.split(",").map(entry=>entry.trim()).filter(Boolean).map(entry=>{const separator=entry.indexOf(".");return {nodeId:separator<1?entry:entry.slice(0,separator),inputName:separator<1?"":entry.slice(separator+1)}}); }
function workflowDraft(provider:GenerationProvider){ return workflowDrafts.value[provider.id] ?? JSON.stringify(provider.workflow?.definition ?? {},null,2); }
function setWorkflowDraft(provider:GenerationProvider,value:string){ workflowDrafts.value[provider.id]=value; }
function resetWorkflowDrafts(){ const next:Record<string,string>={}; for(const provider of settings.value?.providers??[])if(provider.workflow)next[provider.id]=JSON.stringify(provider.workflow.definition,null,2); workflowDrafts.value=next; }
function statusLabel(status:GenerationJobStatus,stage?:string){ if(stage==="preflight_blocked")return "预检阻塞"; if(stage==="plan_ready")return "等待代理领取"; if(stage==="leased")return "代理租约已领取"; if(stage==="generating")return "模型调用中"; if(stage==="generation_unknown")return "调用结果不明"; if(stage==="candidate_generated"||stage==="generated")return "候选图待视觉验收"; if(stage==="visual_rejected")return "候选图需返工"; if(stage==="verified")return "机械验收通过"; return ({queued:"排队中",submitting:"提交中",submission_unknown:"提交结果待对账",waiting_external:"等待外部落盘",waiting_remote:"等待远端",generating:"模型调用中",generation_unknown:"调用结果不明",candidate_generated:"候选图待视觉验收",visual_rejected:"视觉返工",succeeded:"已完成",failed:"失败",cancelled:"已取消"})[status]; }
function leaseState(job:GenerationJob){const lease=job.subagentCheckpoint?.lease;if(!lease?.leaseUntil)return "旧协议 / 无法安全接管";const remaining=Date.parse(lease.leaseUntil)-Date.now();return remaining>0?`有效，剩余 ${Math.ceil(remaining/1000)} 秒`:"已过期；先核调用 intent";}
function canProcess(job:GenerationJob){return !job.subagentCheckpoint&&!["succeeded","failed","cancelled","visual_rejected"].includes(job.status);}
function canReviewCandidate(job:GenerationJob){const checkpoint=job.subagentCheckpoint;return Boolean(checkpoint&&["candidate_generated","generated"].includes(checkpoint.stage)&&checkpoint.lease?.owner&&checkpoint.lease.fence&&checkpoint.callIntent&&checkpoint.output&&!checkpoint.publicationBundle?.rawReceiptId);}
function canCancel(job:GenerationJob){if(["succeeded","failed","cancelled","visual_rejected","generation_unknown","candidate_generated","generating"].includes(job.status))return false;if(job.subagentCheckpoint)return job.subagentCheckpoint.stage==="plan_ready"&&!job.subagentCheckpoint.lease&&!job.subagentCheckpoint.callIntent&&!job.subagentCheckpoint.output;return job.status!=="submission_unknown"||Boolean(job.comfyUiCheckpoint);}
function preflightBlockers(job:GenerationJob){ const labels:Record<string,string>={login_required:"需要登录",page_not_ready:"页面未就绪",generation_mode_mismatch:"生成参数不匹配",insufficient_credits:"额度不足",paid_action_unauthorized:"付费未授权",provider_error:"供应商异常",other:"其他阻塞"}; const blockers=job.browserCheckpoint?.preflightEvidence?.blockers??[]; return blockers.length?blockers.map(code=>labels[code]??code).join(" / "):job.browserCheckpoint?.note??"等待恢复"; }
function providerName(id:string){ return settings.value?.providers.find((provider)=>provider.id===id)?.name ?? id; }
function itemTitle(id:string){ return props.index?.items?.find((item)=>item.id===id)?.title ?? id; }
function reveal(filePath:string){ void window.canvasApi.showInFolder(filePath); }
function message(error:unknown){ return error instanceof Error?error.message:String(error); }
function clone<T>(value:T):T { return JSON.parse(JSON.stringify(value)) as T; }
</script>

<style scoped>
.generation-view { height:100%; display:flex; flex-direction:column; overflow:hidden; background:#121310; }.module-header { flex:0 0 92px; display:flex; align-items:center; justify-content:space-between; padding:0 26px; border-bottom:1px solid #30322c; }.module-header h2{margin:6px 0 3px;font-size:19px}.module-header p{margin:0;color:#83867b;font-size:10px}.module-actions{display:flex;gap:8px}.queue-toolbar{flex:0 0 52px;display:flex;align-items:center;gap:8px;padding:0 26px;border-bottom:1px solid #30322c;background:#151613;flex-wrap:wrap}.queue-toolbar select,.queue-toolbar button{height:31px;border:1px solid #35372f;background:#1b1c18;color:#bbb;padding:0 9px}.queue-toolbar button{display:flex;align-items:center;gap:6px;color:#d7af55;cursor:pointer}.queue-toolbar span{margin-left:auto;color:#686b62;font-size:8px}.queue-tabs{display:flex;gap:4px}.queue-tabs button{color:#9a9d93}.queue-tabs button.active{border-color:#d7af55;color:#e8c56a;background:#221f16}.queue-body{min-height:0;flex:1;display:grid;grid-template-columns:1fr;overflow:hidden}.queue-body.with-settings{grid-template-columns:minmax(0,1fr) 380px}.job-list{min-height:0;overflow:auto;padding:0 26px 70px}.job-row{min-width:760px;display:grid;grid-template-columns:110px minmax(260px,1.4fr) minmax(260px,1fr) 150px;gap:14px;align-items:center;min-height:92px;border-bottom:1px solid #2b2d27}.job-state{color:#aaa;font-size:9px}.job-state i{display:inline-block;width:7px;height:7px;margin-right:7px;border-radius:50%;background:#d7af55}.job-succeeded .job-state i{background:#83aa72}.job-failed .job-state i{background:#d36b59}.job-waiting_external .job-state i{background:#70a7c5}.job-cancelled{opacity:.5}.job-main{min-width:0}.job-main b,.job-main small{display:block}.job-main b{font-size:10px}.job-main small{margin-top:4px;color:#60635a;font:7px Menlo,monospace}.job-main p{margin:8px 0 0;color:#85887e;font-size:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.job-route{min-width:0}.job-route span,.job-route small{display:block}.job-route span{color:#d7af55;font-size:8px}.job-route small{margin-top:6px;color:#64675e;font-size:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.job-actions{display:flex;justify-content:flex-end;gap:5px}.job-actions button{height:25px;border:1px solid #383a33;background:transparent;color:#999c92;font-size:8px;cursor:pointer}.queue-empty{height:100%;display:grid;place-content:center;justify-items:center;gap:10px;color:#61645b;font-size:9px}.provider-settings{min-width:0;min-height:0;height:100%;display:flex;flex-direction:column;overflow:hidden;border-left:1px solid #30322c;background:#171815}.provider-settings>header{flex:0 0 64px;display:flex;align-items:center;justify-content:space-between;padding:0 18px;border-bottom:1px solid #30322c}.provider-settings h3{margin:6px 0 0;font-size:13px}.provider-settings header button{width:29px;height:29px;border:1px solid #3a3c34;background:transparent;color:#d7af55}.settings-scroll{min-height:0;flex:1;overflow:auto}.provider-editor{padding:16px 18px;border-bottom:1px solid #30322c}.provider-head{display:flex;align-items:center;gap:10px;margin-bottom:10px}.provider-head>input{flex:1;color:#eee;font-weight:600}.provider-head label{display:flex;align-items:center;gap:4px;color:#888b80;font-size:8px}.provider-editor>label,.defaults label{display:grid;grid-template-columns:64px 1fr;align-items:center;gap:8px;margin-top:7px;color:#777a70;font-size:8px}.provider-editor input,.provider-editor select,.defaults input,.defaults select{min-width:0;width:100%;height:29px;border:1px solid #34362f;background:#121310;color:#bbb;padding:0 7px}.defaults{padding:16px 18px}.provider-settings>footer{flex:0 0 auto;padding:12px 18px;border-top:1px solid #30322c}.provider-settings>footer button{width:100%}
.job-waiting_remote .job-state i { background: #70a7c5; }
.job-submission_unknown .job-state i { background: #d58a49; }
.job-generation_unknown .job-state i { background: #e07845; }
.job-candidate_generated .job-state i { background: #8b78c6; }
.job-visual_rejected .job-state i { background: #d36b59; }
.job-route .browser-checkpoint,.job-route .comfy-checkpoint,.job-route .subagent-checkpoint{color:#d7af55}.job-route .preflight-blocked{color:#e28c58}.job-route .submit-intent{color:#d58a49}.job-route .upload-slots,.job-route .subagent-lease,.job-route .subagent-output{color:#788d9a}
.job-route .generation-unknown{color:#e07845}
.provider-editor textarea{min-width:0;width:100%;height:auto;border:1px solid #34362f;background:#121310;color:#bbb;padding:7px;resize:vertical;line-height:1.45}.provider-editor .browser-notes,.provider-editor .subagent-notes{align-items:start}
.workflow-editor{margin:12px 0 4px;padding:10px;border:1px solid #35372f;background:#131410}.workflow-editor>header{display:flex;align-items:center;justify-content:space-between}.workflow-editor>header div{min-width:0}.workflow-editor>header b,.workflow-editor>header small{display:block}.workflow-editor>header b{color:#c9cbbb;font-size:9px}.workflow-editor>header small{margin-top:4px;color:#787b70;font:7px Menlo,monospace}.workflow-editor>header button{height:24px;border:1px solid #45473e;background:transparent;color:#d7af55;font-size:8px}.workflow-editor>label{display:grid;grid-template-columns:64px 1fr;align-items:center;gap:8px;margin-top:7px;color:#777a70;font-size:8px}.workflow-editor .workflow-json{align-items:start}.workflow-editor textarea{font:8px/1.45 Menlo,monospace}.workflow-editor>p{margin:8px 0 0;color:#676a61;font-size:7px;line-height:1.55}.comfy-boundary{margin:9px 0 0;color:#8c815e;font-size:7px;line-height:1.5}
.subagent-boundary{margin:9px 0 0;color:#8c815e;font-size:7px;line-height:1.5}
</style>
