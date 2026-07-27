<template>
  <section class="desktop-support" data-testid="desktop-support-view" :aria-busy="busy">
    <header>
      <div><span>桌面生产支持</span><h2>{{ section === "agent" ? "Agent 连接" : "帮助与安全" }}</h2></div>
      <button type="button" data-testid="desktop-support-refresh" :disabled="busy" @click="refreshStatus"><RefreshCw :size="14" :class="{ spinning: busy }" />{{ busyOperation === "refresh" ? "检查中" : "刷新状态" }}</button>
    </header>

    <div v-if="notice" class="notice" :class="{ error }" role="status">{{ notice }}</div>
    <div v-if="projectOperation" class="operation-state" :class="projectOperation.phase" role="status" data-testid="managed-project-operation-state">
      <LoaderCircle v-if="projectOperation.phase === 'running'" :size="15" class="spinning" aria-hidden="true" />
      <ShieldCheck v-else :size="15" aria-hidden="true" />
      <div><strong>{{ projectOperation.stage }}</strong><span>{{ projectOperation.targetPath }}</span></div>
    </div>

    <main v-if="section === 'agent'" class="support-grid">
      <article class="connection-card wide agent-next-strip" data-testid="agent-connection-next-strip">
        <ShieldCheck :size="24" />
        <div>
          <span>唯一下一步（本机）</span>
          <strong>{{ agentNextTitle }}</strong>
          <p>{{ agentNextBody }}</p>
          <ol class="agent-steps">
            <li>确认 Codex 已连接当前工程</li>
            <li>在画布/驾驶舱按系统「唯一下一步」冻结或派发</li>
            <li>Agent 回写后到「5 审片」人工判定</li>
          </ol>
        </div>
      </article>
      <article class="connection-card">
        <Bot :size="24" />
        <div><span>CODEX</span><strong>{{ connectionLabel(status?.codex) }}</strong><p>通过同一个 ai-drama-canvas MCP 读取当前活动工程。</p></div>
      </article>
      <article class="connection-card">
        <Bot :size="24" />
        <div><span>GROK（可选）</span><strong>{{ connectionLabel(status?.grok) }}</strong><p>未安装 Grok 不影响 Codex 读取、生成或写回当前工程。</p></div>
      </article>
      <article class="connection-card wide" :class="status?.packaged && status?.serverAvailable ? 'ready' : 'blocked'">
        <Cable :size="24" />
        <div><span>画布连接服务</span><strong>{{ !status ? "检查中…" : status.packaged && status.serverAvailable ? "已就绪" : status.packaged ? "当前构建不可用" : "仅诊断（开发环境）" }}</strong><p>{{ status?.message || "正在读取本机连接状态…" }}</p></div>
      </article>
      <div class="explicit-action">
        <ShieldCheck :size="18" />
        <p><b>只在你明确点击后才修复配置</b><span>原配置只在本机以 0600 权限备份用于失败回滚；软件不解析、不显示、不上传其中的 API 密钥。切换项目后无需重新配置。</span></p>
        <button type="button" data-testid="desktop-support-repair" :disabled="busy || !status?.repairAvailable || !status?.repairNeeded" @click="repairConnections">{{ busyOperation === "repair" ? "修复中" : status?.repairAvailable && !status?.repairNeeded ? "无需修复" : "备份并修复 Codex 连接" }}</button>
      </div>
    </main>

    <main v-else class="help-layout">
      <section>
        <article><span>1</span><div><h3>剧本</h3><p>导入剧本和提示词，正文以不可变修订保存。</p></div></article>
        <article><span>2</span><div><h3>资产</h3><p>建立角色、场景、道具，审核参考图后提升为权威版本。</p></div></article>
        <article><span>3</span><div><h3>绑定</h3><p>把剧本中的人物、场景、道具绑到已锁定资产；歧义必须人工确认。</p></div></article>
        <article><span>4</span><div><h3>生成</h3><p>Codex 只使用冻结包中允许的锁定资产；结果回写 raw/labeled。Grok 可选。</p></div></article>
        <article><span>5</span><div><h3>审片</h3><p>对照 raw 和中文 labeled，由你明确判定通过或返工。</p></div></article>
      </section>

      <aside>
        <h3>工程安全</h3>
        <p>备份会在写入屏障内建立一致快照。恢复始终落到新目录，不会覆盖原工程。</p>
        <div class="backup-actions">
          <button type="button" data-testid="desktop-support-backup" :disabled="busy" @click="backupProject"><Archive :size="15" />{{ busyOperation === "backup" ? "备份中" : "备份当前工程" }}</button>
          <button type="button" data-testid="desktop-support-restore" :disabled="busy" @click="restoreProject"><FolderInput :size="15" />{{ busyOperation === "restore" ? "恢复中" : "恢复到新目录" }}</button>
        </div>
        <details>
          <summary>诊断详情（高级）</summary>
          <dl>
            <dt>当前工程</dt><dd>{{ projectRoot }}</dd>
            <dt>运行形态</dt><dd>{{ status?.packaged ? "安装版" : "开发版" }}</dd>
            <dt>MCP Server</dt><dd>{{ status?.serverAvailable ? "available" : "unavailable" }}</dd>
          </dl>
        </details>
      </aside>
    </main>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { Archive, Bot, Cable, FolderInput, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-vue-next";

const props = defineProps<{ projectRoot: string; section: "help" | "agent" }>();
const emit = defineEmits<{ restored: [projectRoot: string]; failed: [message: string] }>();
type ConnectionStatus = Awaited<ReturnType<typeof window.canvasApi.getAgentConnectionStatus>>;
type BusyOperation = "refresh" | "repair" | "backup" | "restore";
type ProjectOperation = {
  operationId: string;
  kind: "backup" | "restore";
  phase: "running" | "succeeded" | "failed" | "canceled";
  stage: string;
  sourceRoot: string;
  targetPath: string;
};
const status = ref<ConnectionStatus | null>(null);
const busyOperation = ref<BusyOperation | null>(null);
const busy = computed(() => busyOperation.value !== null);
const projectOperation = ref<ProjectOperation | null>(null);
const notice = ref("");
const error = ref(false);
let actionSequence = 0;
let statusSequence = 0;

function connectionLabel(client?: { installed: boolean; configured: boolean; current: boolean }): string {
  if (!client) return "检查中…";
  if (!client.installed) return "未找到 CLI";
  if (client.current) return "已连接当前版本";
  return client.configured ? "需要更新连接" : "尚未配置";
}

const agentNextTitle = computed(() => {
  const codex = status.value?.codex;
  if (!status.value) return "正在检查本机连接…";
  if (!codex?.installed) return "先安装或配置 Codex CLI";
  if (!codex.current) return codex.configured ? "更新 Codex 连接到当前版本" : "配置 Codex 连接到本画布";
  if (status.value.packaged && !status.value.serverAvailable) return "修复画布连接服务";
  return "Codex 已就绪 · 去驾驶舱或画布执行唯一下一步";
});

const agentNextBody = computed(() => {
  if (!status.value) return "刷新后查看 Codex / 画布 MCP 状态。";
  if (status.value.codex?.current) {
    return "不必在本页生图。连接只保证 Agent 与桌面读同一活动工程；生成与审片仍走冻结包与 Review。";
  }
  return status.value.message || "按下方卡片状态处理连接后，再回到生产步骤。";
});

function currentAction(sequence: number, projectRoot: string): boolean {
  return sequence === actionSequence && props.projectRoot === projectRoot;
}

function publishProjectOperation(next: ProjectOperation): void {
  projectOperation.value = next;
}

async function withBusy(kind: BusyOperation, operation: (context: { sequence: number; projectRoot: string }) => Promise<void>): Promise<void> {
  if (busy.value) return;
  const sequence = ++actionSequence;
  const projectRoot = props.projectRoot;
  busyOperation.value = kind;
  notice.value = "";
  error.value = false;
  try { await operation({ sequence, projectRoot }); }
  catch (reason) {
    if (currentAction(sequence, projectRoot)) {
      notice.value = reason instanceof Error ? reason.message : String(reason);
      error.value = true;
      emit("failed", notice.value);
    }
    throw reason;
  } finally {
    if (sequence === actionSequence) busyOperation.value = null;
    if (props.projectRoot !== projectRoot && !busy.value) void refreshStatus();
  }
}

async function refreshStatus(): Promise<void> {
  if (busy.value) return;
  const requestSequence = ++statusSequence;
  await withBusy("refresh", async ({ projectRoot }) => {
    const next = await window.canvasApi.getAgentConnectionStatus(projectRoot);
    if (requestSequence === statusSequence && props.projectRoot === projectRoot) status.value = next;
  }).catch(() => undefined);
}

async function repairConnections(): Promise<void> {
  await withBusy("repair", async ({ sequence, projectRoot }) => {
    await window.canvasApi.repairAgentConnections(projectRoot);
    const next = await window.canvasApi.getAgentConnectionStatus(projectRoot);
    if (!currentAction(sequence, projectRoot)) return;
    status.value = next;
    notice.value = "Agent 连接已备份并修复。";
  }).catch(() => undefined);
}

async function backupProject(): Promise<void> {
  const operationId = `backup-${Date.now()}-${actionSequence + 1}`;
  const sourceRoot = props.projectRoot;
  await withBusy("backup", async ({ sequence, projectRoot }) => {
    publishProjectOperation({ operationId, kind: "backup", phase: "running", stage: "正在选择备份目标并建立一致快照", sourceRoot: projectRoot, targetPath: "等待选择备份保存目录" });
    const result = await window.canvasApi.backupManagedProject(projectRoot);
    if (result.canceled) {
      publishProjectOperation({ operationId, kind: "backup", phase: "canceled", stage: "备份已取消", sourceRoot: projectRoot, targetPath: "未写入任何备份" });
      return;
    }
    publishProjectOperation({ operationId, kind: "backup", phase: "succeeded", stage: "一致备份已完成", sourceRoot: projectRoot, targetPath: result.backupRoot });
    if (currentAction(sequence, projectRoot)) notice.value = `备份已完成：${result.fileCount} 个文件。`;
  }).catch((reason) => {
    publishProjectOperation({ operationId, kind: "backup", phase: "failed", stage: `备份失败：${reason instanceof Error ? reason.message : String(reason)}`, sourceRoot, targetPath: projectOperation.value?.targetPath ?? "目标目录不可用" });
  });
}

async function restoreProject(): Promise<void> {
  const operationId = `restore-${Date.now()}-${actionSequence + 1}`;
  const sourceRoot = props.projectRoot;
  await withBusy("restore", async ({ sequence, projectRoot }) => {
    publishProjectOperation({ operationId, kind: "restore", phase: "running", stage: "正在选择备份并校验恢复副本", sourceRoot: projectRoot, targetPath: "等待选择恢复后的新目录" });
    const result = await window.canvasApi.restoreManagedProject();
    if (result.canceled) {
      publishProjectOperation({ operationId, kind: "restore", phase: "canceled", stage: "恢复已取消", sourceRoot: projectRoot, targetPath: "未激活任何新工程" });
      return;
    }
    publishProjectOperation({ operationId, kind: "restore", phase: "succeeded", stage: "恢复副本已校验，等待桌面打开后激活", sourceRoot: projectRoot, targetPath: result.projectRoot });
    if (!currentAction(sequence, projectRoot)) return;
    notice.value = `恢复副本已校验：${result.projectName}；正在打开新工程。`;
    emit("restored", result.projectRoot);
  }).catch((reason) => {
    publishProjectOperation({ operationId, kind: "restore", phase: "failed", stage: `恢复失败，活动工程保持不变：${reason instanceof Error ? reason.message : String(reason)}`, sourceRoot, targetPath: projectOperation.value?.targetPath ?? "恢复目标不可用" });
  });
}

watch(() => props.projectRoot, () => {
  statusSequence += 1;
  if (!busy.value) void refreshStatus();
});
onMounted(() => void refreshStatus());
</script>

<style scoped>
.desktop-support{height:100%;min-height:560px;overflow:auto;background:var(--ui-bg);color:var(--ui-text)}.desktop-support>header{display:flex;align-items:center;justify-content:space-between;padding:22px 26px;border-bottom:1px solid var(--ui-line);background:var(--ui-bg)}.desktop-support>header span{color:var(--ui-accent);font:8px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em}.desktop-support h2{margin:6px 0 0;font-size:21px}.desktop-support>header button,.backup-actions button,.explicit-action button{display:flex;align-items:center;justify-content:center;gap:7px;border:1px solid var(--ui-accent);background:var(--ui-surface-2);color:var(--ui-accent-strong);cursor:pointer}.desktop-support>header button{height:31px;padding:0 10px}.desktop-support button:disabled{cursor:not-allowed;opacity:.45}.notice{padding:10px 26px;border-bottom:1px solid var(--ui-ok);background:var(--ui-surface-2);color:var(--ui-ok);font-size:9px}.notice.error{border-color:var(--ui-danger);background:color-mix(in srgb, var(--ui-danger) 10%, var(--ui-surface));color:var(--ui-danger)}.operation-state{display:flex;align-items:center;gap:10px;padding:10px 26px;border-bottom:1px solid var(--ui-accent);background:var(--ui-accent-soft);color:var(--ui-accent-strong)}.operation-state.succeeded{border-color:var(--ui-ok);background:var(--ui-surface-2);color:var(--ui-ok)}.operation-state.failed{border-color:var(--ui-danger);background:color-mix(in srgb, var(--ui-danger) 10%, var(--ui-surface));color:var(--ui-danger)}.operation-state.canceled{border-color:var(--ui-line);color:var(--ui-text-2)}.operation-state strong,.operation-state span{display:block}.operation-state strong{font-size:9px}.operation-state span{max-width:100%;margin-top:4px;overflow:hidden;font:8px ui-monospace,SFMono-Regular,Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}.support-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:24px}.connection-card{display:flex;gap:13px;padding:18px;border:1px solid var(--ui-line);background:var(--ui-surface)}.connection-card.wide,.explicit-action{grid-column:1/-1}.agent-next-strip{border-color:var(--ui-accent);background:var(--ui-accent-soft)}.agent-steps{margin:8px 0 0;padding-left:18px;color:var(--ui-text-2);font-size:9px;line-height:1.55}.agent-steps li{margin:2px 0}.connection-card>svg{color:var(--ui-accent)}.connection-card span,.connection-card strong{display:block}.connection-card span{color:var(--ui-text-3);font-size:8px}.connection-card strong{margin-top:5px;font-size:14px}.connection-card p{margin:7px 0 0;color:var(--ui-text-3);font-size:9px;line-height:1.6}.connection-card.ready{border-color:var(--ui-ok)}.connection-card.blocked{border-color:var(--ui-danger)}.explicit-action{display:flex;align-items:center;gap:13px;padding:16px;border-left:3px solid var(--ui-accent);background:var(--ui-surface)}.explicit-action>svg{flex:0 0 auto;color:var(--ui-accent)}.explicit-action p{min-width:0;flex:1;margin:0}.explicit-action b,.explicit-action span{display:block}.explicit-action b{font-size:10px}.explicit-action span{margin-top:5px;color:var(--ui-text-3);font-size:8px;line-height:1.55}.explicit-action button{min-height:34px;padding:0 12px}.help-layout{display:grid;grid-template-columns:minmax(440px,1.25fr) minmax(300px,.75fr);gap:20px;padding:24px}.help-layout>section{display:grid;gap:1px;background:var(--ui-line);border:1px solid var(--ui-line)}.help-layout article{display:flex;gap:13px;padding:14px;background:var(--ui-bg)}.help-layout article>span{width:26px;height:26px;display:grid;place-items:center;border:1px solid var(--ui-accent);color:var(--ui-accent);font:10px ui-monospace,SFMono-Regular,Menlo,monospace}.help-layout h3{margin:0;font-size:12px}.help-layout p{margin:5px 0 0;color:var(--ui-text-3);font-size:9px;line-height:1.6}.help-layout aside{align-self:start;padding:18px;border:1px solid var(--ui-line);background:var(--ui-surface)}.backup-actions{display:grid;gap:8px;margin-top:15px}.backup-actions button{min-height:36px}.help-layout details{margin-top:18px;padding-top:14px;border-top:1px solid var(--ui-line)}.help-layout summary{color:var(--ui-text-2);font-size:9px;cursor:pointer}.help-layout dl{display:grid;grid-template-columns:80px minmax(0,1fr);gap:7px;margin:12px 0 0}.help-layout dt{color:var(--ui-text-3);font-size:8px}.help-layout dd{margin:0;overflow:hidden;color:var(--ui-text-2);font:8px ui-monospace,SFMono-Regular,Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}.spinning{animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:900px){.support-grid,.help-layout{grid-template-columns:1fr}.connection-card.wide,.explicit-action{grid-column:auto}}
</style>
