#!/usr/bin/env tsx
/**
 * WORKQUEUE 台账状态机（无人干预开发闭环 · 工作项真相源）
 *
 * 真相源：根目录 WORKQUEUE.json；运行证据：.workqueue/（巡检日志、指纹、领取租约）。
 * 合同权威：docs/GOAL_无人干预开发闭环与工作队列协议_20260812.md
 *
 * 状态机：open → claimed → verifying → closed | waived | parked
 *   - claim 需 --who + --repro；repro 必须真实可执行，验证通过是销项唯一依据
 *   - verify 重跑 repro；PASS 才允许 close；失败退回 claimed 并 attempts+1
 *   - anti_loop：同一 id 的 verify 连续失败 ≥4 次自动 park，禁止原样重跑
 *   - 租约：claim 超过 leaseHours 未 verify/close 视为 stale，可被 reap 回 open
 *
 * 用法：
 *   tsx scripts/workqueue-ops.ts next
 *   tsx scripts/workqueue-ops.ts list [--all]
 *   tsx scripts/workqueue-ops.ts claim <id> --who=<agent> --repro=<command>
 *   tsx scripts/workqueue-ops.ts note <id> --note=<text>
 *   tsx scripts/workqueue-ops.ts verify <id> [--skip-run]
 *   tsx scripts/workqueue-ops.ts close <id> --evidence=<path>
 *   tsx scripts/workqueue-ops.ts waive <id> --why=<reason>
 *   tsx scripts/workqueue-ops.ts park <id> --why=<reason>
 *   tsx scripts/workqueue-ops.ts reopen <id> --why=<reason>
 *   tsx scripts/workqueue-ops.ts reap
 *   tsx scripts/workqueue-ops.ts stats
 *   tsx scripts/workqueue-ops.ts patrol-health [--stale-min=90]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type WorkItemStatus = 'open' | 'claimed' | 'verifying' | 'closed' | 'waived' | 'parked';
export type WorkItemSeverity = 'P0' | 'P1' | 'P2' | 'P3';

export interface WorkItemHistoryEntry {
  at: string;
  event: string;
  detail: string;
}

export interface WorkItem {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: WorkItemStatus;
  severity: WorkItemSeverity;
  source: string; // patrol:<probe> | user-report | retro | consistency-drift | manual
  probe?: string;
  fingerprint: string; // probe + 归一化失败签名，巡检去重用
  title: string;
  repro: string; // 可复现命令；销项验证会原样重跑
  owner?: string;
  claimedAt?: string;
  leaseUntil?: string;
  attempts: number;
  history: WorkItemHistoryEntry[];
  closedAt?: string;
  evidence?: string[];
  closeReason?: string;
}

export interface WorkQueueFile {
  version: 1;
  updatedAt: string;
  items: WorkItem[];
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const QUEUE_PATH = join(REPO_ROOT, 'WORKQUEUE.json');
export const RUNTIME_DIR = join(REPO_ROOT, '.workqueue');
const QUEUE_MUTEX_PATH = join(RUNTIME_DIR, 'workqueue.lock');

const SEVERITY_RANK: Record<WorkItemSeverity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const DEFAULT_LEASE_HOURS = 24;
const MAX_VERIFY_ATTEMPTS = 4;

function nowIso(): string {
  return new Date().toISOString();
}

export function ensureRuntimeDir(): void {
  mkdirSync(RUNTIME_DIR, { recursive: true });
}

function queueMtimeMs(): number {
  try {
    return statSync(QUEUE_PATH).mtimeMs;
  } catch {
    return 0;
  }
}
void queueMtimeMs; // 保留供后续 mtime 对账探针使用

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 队列写互斥锁：wx 独占 + 5s 轮询等待 + 60s 死锁接管，覆盖所有 load→save 窗口。 */
function acquireQueueLock(): void {
  ensureRuntimeDir();
  const startedAt = Date.now();
  for (;;) {
    try {
      writeFileSync(QUEUE_MUTEX_PATH, JSON.stringify({ pid: process.pid, at: nowIso() }), { flag: 'wx' });
      return;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let holderPid: number | undefined;
      try {
        holderPid = (JSON.parse(readFileSync(QUEUE_MUTEX_PATH, 'utf8')) as { pid?: number }).pid;
      } catch {
        holderPid = undefined;
      }
      const holderAlive = holderPid !== undefined && processAlive(holderPid);
      const waited = Date.now() - startedAt;
      if (!holderAlive && waited >= 5_000) {
        // 持有者已死：接管（unlink+wx 重试；输掉竞争则继续轮询）
        try {
          unlinkSync(QUEUE_MUTEX_PATH);
        } catch {
          // 已被他人接管
        }
        continue;
      }
      if (waited > 60_000) {
        throw new Error('WORKQUEUE 写锁等待超时（>60s），可能有会话卡死；请稍后重试或人工检查 .workqueue/workqueue.lock。');
      }
      const until = Date.now() + 500;
      while (Date.now() < until) {
        // 忙等待（同步上下文，无法 await）
      }
    }
  }
}

function releaseQueueLock(): void {
  try {
    unlinkSync(QUEUE_MUTEX_PATH);
  } catch {
    // 锁已不存在或被接管
  }
}

/**
 * 队列原子更新：锁内重读（不信任锁外旧快照）→ mutate → 写回。
 * 所有写路径必须经此入口，消灭读改写丢项竞态（wq-0003 后续实测补强）。
 */
export function mutateQueue(mutate: (queue: WorkQueueFile) => void): void {
  acquireQueueLock();
  try {
    const queue = loadQueue();
    mutate(queue);
    saveQueue(queue);
  } finally {
    releaseQueueLock();
  }
}

export function loadQueue(): WorkQueueFile {
  if (!existsSync(QUEUE_PATH)) {
    return { version: 1, updatedAt: nowIso(), items: [] };
  }
  const parsed = JSON.parse(readFileSync(QUEUE_PATH, 'utf8')) as WorkQueueFile;
  if (parsed.version !== 1 || !Array.isArray(parsed.items)) {
    throw new Error(`WORKQUEUE.json 版本或结构非法：${QUEUE_PATH}`);
  }
  return parsed;
}

export function saveQueue(queue: WorkQueueFile): void {
  queue.updatedAt = nowIso();
  writeFileSync(QUEUE_PATH, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
}

function findItem(queue: WorkQueueFile, id: string): WorkItem {
  const item = queue.items.find((it) => it.id === id);
  if (!item) {
    throw new Error(`工作项不存在：${id}`);
  }
  return item;
}

function pushHistory(item: WorkItem, event: string, detail: string): void {
  item.updatedAt = nowIso();
  item.history.push({ at: nowIso(), event, detail });
}

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq === -1) {
      flags.set(arg.slice(2), 'true');
    } else {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    }
  }
  return flags;
}

function fail(message: string): never {
  console.error(`[workqueue] ${message}`);
  process.exit(1);
}

/** 巡检器入队/复现入口：同 probe+fingerprint 不重复建项，只刷新 lastSeen；原子写。 */
export function upsertFinding(input: {
  probe: string;
  fingerprint: string;
  title: string;
  severity: WorkItemSeverity;
  repro: string;
  detail: string;
}): { created: boolean; item: WorkItem } {
  ensureRuntimeDir();
  let created = false;
  let resultItem: WorkItem | undefined;
  mutateQueue((queue) => {
    const existing = queue.items.find(
      (it) => it.probe === input.probe && it.fingerprint === input.fingerprint,
    );
    if (existing) {
      if (existing.status === 'closed' || existing.status === 'waived') {
        // 已销项的缺陷再次复现 → 重开为 open，这是漏洞迭代闭环的关键一步
        existing.status = 'open';
        existing.owner = undefined;
        existing.claimedAt = undefined;
        existing.leaseUntil = undefined;
        pushHistory(existing, 'reopened-by-patrol', input.detail);
        resultItem = existing;
        return;
      }
      pushHistory(existing, 'seen-again-by-patrol', input.detail);
      resultItem = existing;
      return;
    }
    const seq = queue.items.length + 1;
    const item: WorkItem = {
      id: `wq-${String(seq).padStart(4, '0')}`,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: 'open',
      severity: input.severity,
      source: `patrol:${input.probe}`,
      probe: input.probe,
      fingerprint: input.fingerprint,
      title: input.title,
      repro: input.repro,
      attempts: 0,
      history: [{ at: nowIso(), event: 'created-by-patrol', detail: input.detail }],
    };
    queue.items.push(item);
    created = true;
    resultItem = item;
  });
  return { created, item: resultItem! };
}

function nextItem(queue: WorkQueueFile): WorkItem | undefined {
  const actionable = queue.items.filter((it) => it.status === 'open' || it.status === 'claimed');
  actionable.sort((a, b) => {
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    return a.createdAt.localeCompare(b.createdAt);
  });
  return actionable[0];
}

function summarize(item: WorkItem): string {
  return [
    `${item.id} [${item.status}/${item.severity}] ${item.title}`,
    `  source=${item.source} attempts=${item.attempts}`,
    `  repro=${item.repro}`,
    item.owner ? `  owner=${item.owner}` : null,
    item.evidence?.length ? `  evidence=${item.evidence.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function runRepro(item: WorkItem): { pass: boolean; output: string } {
  const res = spawnSync('/bin/sh', ['-c', item.repro], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // 60 分钟：medium/integration 分区无负载实跑约 20–30 分钟，轻载可至 40+ 分钟；
    // 45 分钟旧帽在重负载分区连续两轮撞顶截断日志（wq-0005 实测）。
    timeout: 60 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim();
  return { pass: res.status === 0, output };
}

const isMainModule = (() => {
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (!isMainModule) {
  // 被 auto-triage 等脚本作为库 import 时，只导出函数，不执行 CLI
} else {
  runCli();
}

function runCli(): void {
const [, , command, ...rest] = process.argv;
const positional: string[] = rest.filter((a) => !a.startsWith('--'));
const flags = parseFlags(rest);

if (!command) {
  fail('缺少命令；可用：next | list | claim | note | verify | close | waive | park | reopen | reap | stats | patrol-health');
}

const queue = loadQueue();

switch (command) {
  case 'next': {
    const item = nextItem(queue);
    if (!item) {
      console.log('WORKQUEUE_EMPTY');
      break;
    }
    console.log(summarize(item));
    break;
  }
  case 'list': {
    const items = flags.has('all')
      ? queue.items
      : queue.items.filter((it) => it.status !== 'closed' && it.status !== 'waived');
    if (items.length === 0) {
      console.log('WORKQUEUE_EMPTY');
      break;
    }
    for (const item of items) console.log(`${summarize(item)}\n`);
    break;
  }
  case 'claim': {
    const id = positional[0];
    const who = flags.get('who');
    const repro = flags.get('repro');
    if (!id || !who || !repro) fail('claim 需要 <id> --who=<agent> --repro=<command>');
    let snapshot: WorkItem | undefined;
    mutateQueue((queue) => {
      const item = findItem(queue, id);
      const sameOwnerReclaim = item.status === 'claimed' && item.owner === who;
      if (item.status !== 'open' && !sameOwnerReclaim) fail(`只能领取 open 项，当前 ${item.status}`);
      item.status = 'claimed';
      item.owner = who;
      item.repro = repro;
      item.claimedAt = nowIso();
      item.leaseUntil = new Date(Date.now() + DEFAULT_LEASE_HOURS * 3600_000).toISOString();
      pushHistory(item, sameOwnerReclaim ? 'reclaimed' : 'claimed', `who=${who}; repro=${repro}`);
      snapshot = { ...item };
    });
    console.log(summarize(snapshot!));
    break;
  }
  case 'note': {
    const id = positional[0];
    const note = flags.get('note');
    if (!id || !note) fail('note 需要 <id> --note=<text>');
    let snapshot: WorkItem | undefined;
    mutateQueue((queue) => {
      const item = findItem(queue, id);
      pushHistory(item, 'note', note);
      snapshot = { ...item };
    });
    console.log(summarize(snapshot!));
    break;
  }
  case 'verify': {
    const id = positional[0];
    if (!id) fail('verify 需要 <id>');
    let snapshot: WorkItem | undefined;
    mutateQueue((queue) => {
      const item = findItem(queue, id);
      if (item.status !== 'claimed') fail(`只能 verify claimed 项，当前 ${item.status}`);
      item.status = 'verifying';
      item.attempts += 1;
      snapshot = { ...item };
    });
    if (flags.has('skip-run')) {
      console.log(`[workqueue] ${id} 已置为 verifying（skip-run）；close 前必须补真跑 repro`);
      break;
    }
    const { pass, output } = runRepro(snapshot!);
    const logPath = join(RUNTIME_DIR, `verify-${id}-${Date.now()}.log`);
    ensureRuntimeDir();
    writeFileSync(logPath, output, 'utf8');
    if (pass) {
      mutateQueue((queue) => {
        pushHistory(findItem(queue, id), 'verify-pass', `repro exit=0; log=${logPath}`);
      });
      console.log(`[workqueue] ${id} verify PASS（log=${logPath}）；请 close --evidence=<path> 销项`);
    } else {
      let attempts = 0;
      mutateQueue((queue) => {
        const item = findItem(queue, id);
        attempts = item.attempts;
        if (item.attempts >= MAX_VERIFY_ATTEMPTS) {
          item.status = 'parked';
          pushHistory(item, 'auto-park', `verify 连续失败 ${item.attempts} 次，anti_loop 生效`);
        } else {
          item.status = 'claimed';
          pushHistory(item, 'verify-fail', `repro exit!=0; log=${logPath}`);
        }
      });
      console.error(`[workqueue] ${id} verify FAIL（attempt ${attempts}/${MAX_VERIFY_ATTEMPTS}，log=${logPath}）`);
      process.exit(2);
    }
    break;
  }
  case 'close': {
    const id = positional[0];
    const evidence = flags.get('evidence');
    if (!id || !evidence) fail('close 需要 <id> --evidence=<path>');
    let snapshot: WorkItem | undefined;
    mutateQueue((queue) => {
      const item = findItem(queue, id);
      if (item.status !== 'verifying') fail(`只有 verifying 项可销项，当前 ${item.status}；先 verify`);
      item.status = 'closed';
      item.closedAt = nowIso();
      item.evidence = [...(item.evidence ?? []), evidence];
      pushHistory(item, 'closed', `evidence=${evidence}`);
      snapshot = { ...item };
    });
    console.log(summarize(snapshot!));
    break;
  }
  case 'waive': {
    const id = positional[0];
    const why = flags.get('why');
    if (!id || !why) fail('waive 需要 <id> --why=<reason>');
    let snapshot: WorkItem | undefined;
    mutateQueue((queue) => {
      const item = findItem(queue, id);
      if (item.status === 'closed') fail('已 closed 项不能 waive');
      item.status = 'waived';
      item.closeReason = why;
      pushHistory(item, 'waived', why);
      snapshot = { ...item };
    });
    console.log(summarize(snapshot!));
    break;
  }
  case 'park': {
    const id = positional[0];
    const why = flags.get('why');
    if (!id || !why) fail('park 需要 <id> --why=<reason>');
    let snapshot: WorkItem | undefined;
    mutateQueue((queue) => {
      const item = findItem(queue, id);
      item.status = 'parked';
      item.closeReason = why;
      pushHistory(item, 'parked', why);
      snapshot = { ...item };
    });
    console.log(summarize(snapshot!));
    break;
  }
  case 'reopen': {
    const id = positional[0];
    const why = flags.get('why');
    if (!id || !why) fail('reopen 需要 <id> --why=<reason>');
    let snapshot: WorkItem | undefined;
    mutateQueue((queue) => {
      const item = findItem(queue, id);
      if (item.status === 'open') fail('已经是 open');
      item.status = 'open';
      item.owner = undefined;
      item.claimedAt = undefined;
      item.leaseUntil = undefined;
      pushHistory(item, 'reopened', why);
      snapshot = { ...item };
    });
    console.log(summarize(snapshot!));
    break;
  }
  case 'reap': {
    const now = Date.now();
    let reaped = 0;
    mutateQueue((queue) => {
      for (const item of queue.items) {
        if (item.status === 'claimed' && item.leaseUntil && Date.parse(item.leaseUntil) < now) {
          item.status = 'open';
          item.owner = undefined;
          item.claimedAt = undefined;
          item.leaseUntil = undefined;
          pushHistory(item, 'reaped', '租约过期，回收入 open');
          reaped += 1;
        }
      }
    });
    console.log(`[workqueue] reap 完成：回收 ${reaped} 项`);
    break;
  }
  case 'stats': {
    const counts: Record<string, number> = {};
    for (const item of queue.items) counts[item.status] = (counts[item.status] ?? 0) + 1;
    console.log(JSON.stringify({ total: queue.items.length, byStatus: counts, updatedAt: queue.updatedAt }));
    break;
  }
  case 'patrol-health': {
    // 巡检卡死探测：心跳过旧且持有者存活 → STALE（需人工/下一轮检查）；持有者已死 → REAP-LOCK。
    const staleMinutes = Number(flags.get('stale-min') ?? '90');
    const lockPath = join(RUNTIME_DIR, 'patrol.lock');
    const heartbeatPath = join(RUNTIME_DIR, 'patrol-heartbeat.json');
    const readJson = (p: string): Record<string, unknown> | undefined => {
      try {
        return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    };
    const lock = readJson(lockPath);
    const heartbeat = readJson(heartbeatPath);
    if (!lock) {
      console.log(JSON.stringify({ state: 'IDLE', heartbeat: heartbeat ?? null }));
      break;
    }
    const holderPid = typeof lock.pid === 'number' ? lock.pid : undefined;
    let holderAlive = false;
    if (holderPid !== undefined) {
      try {
        process.kill(holderPid, 0);
        holderAlive = true;
      } catch {
        holderAlive = false;
      }
    }
    const heartbeatAt = typeof heartbeat?.at === 'string' ? Date.parse(heartbeat.at) : NaN;
    const stale = Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt > staleMinutes * 60_000;
    const state = !holderAlive ? 'REAP-LOCK' : stale ? 'STALE' : 'RUNNING';
    console.log(JSON.stringify({ state, holderPid, holderAlive, heartbeat: heartbeat ?? null, staleMinutes }));
    break;
  }
  default:
    fail(`未知命令：${command}`);
}
}
