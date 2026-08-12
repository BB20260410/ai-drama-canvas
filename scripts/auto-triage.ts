#!/usr/bin/env tsx
/**
 * auto-triage · 无人干预开发闭环的巡检器（缺陷自动发现层）
 *
 * 职责：定期跑有界探针 → 失败自动规范为 WORKQUEUE 工作项（复现已知失败则重开）→ 落盘巡检证据。
 * 巡检只做只读/无副作用探针：不写正式工程、不付费调用、不 Git 写操作、不重建 owner。
 *
 * 合同权威：docs/GOAL_无人干预开发闭环与工作队列协议_20260812.md
 *
 * 用法：
 *   tsx scripts/auto-triage.ts                 # 跑默认探针集
 *   tsx scripts/auto-triage.ts --probes=all    # 跑全部探针（含网络类）
 *   tsx scripts/auto-triage.ts --probes=typecheck,dep-audit
 *   tsx scripts/auto-triage.ts --dry-run       # 只跑不建票
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureRuntimeDir, RUNTIME_DIR, upsertFinding, type WorkItemSeverity } from './workqueue-ops.js';

const PATROL_LOCK_PATH = join(RUNTIME_DIR, 'patrol.lock');

/** 巡检单飞锁：wx 独占创建；持有者死亡（pid 不可 kill -0）时可接管，避免 SIGKILL 残留死锁。 */
export function acquirePatrolLock(): { acquired: boolean; holderPid?: number } {
  ensureRuntimeDir();
  try {
    writeFileSync(PATROL_LOCK_PATH, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), {
      flag: 'wx',
    });
    return { acquired: true };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    let holderPid: number | undefined;
    try {
      holderPid = (JSON.parse(readFileSync(PATROL_LOCK_PATH, 'utf8')) as { pid?: number }).pid;
    } catch {
      holderPid = undefined;
    }
    const alive = holderPid !== undefined && processAlive(holderPid);
    if (!alive) {
      // 持有者已死 → 接管锁（unlink 后重试 wx；失败则视为并发竞争输家）
      try {
        unlinkSync(PATROL_LOCK_PATH);
        writeFileSync(PATROL_LOCK_PATH, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), {
          flag: 'wx',
        });
        return { acquired: true };
      } catch {
        return { acquired: false, holderPid };
      }
    }
    return { acquired: false, holderPid };
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function releasePatrolLock(): void {
  try {
    unlinkSync(PATROL_LOCK_PATH);
  } catch {
    // 锁已不存在或被接管，无需处理
  }
}

const HEARTBEAT_PATH = join(RUNTIME_DIR, 'patrol-heartbeat.json');

/** 巡检心跳：启动与每个探针结束时刷新，供外部判断巡检是否卡死。 */
function writeHeartbeat(phase: string, detail?: string): void {
  ensureRuntimeDir();
  writeFileSync(
    HEARTBEAT_PATH,
    `${JSON.stringify({ pid: process.pid, at: new Date().toISOString(), phase, detail }, null, 2)}\n`,
    'utf8',
  );
}

interface ProbeSpec {
  name: string;
  title: string;
  severity: WorkItemSeverity;
  command: string;
  timeoutMs: number;
  default: boolean; // 是否属于默认巡检集
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 探针集 = 有界、可复现、无副作用。
 * repro 命令即探针命令本身：销项验证重跑同命令，exit 0 即缺陷消失。
 */
const PROBES: ProbeSpec[] = [
  {
    name: 'typecheck',
    title: '双套 typecheck（web+node）失败',
    severity: 'P0',
    command: 'npm run typecheck',
    timeoutMs: 12 * 60 * 1000,
    default: true,
  },
  {
    name: 'typecheck-app',
    title: 'MCP/主进程侧 typecheck:app 失败',
    severity: 'P0',
    command: 'npm run typecheck:app',
    timeoutMs: 10 * 60 * 1000,
    default: true,
  },
  {
    name: 'partition-audit',
    title: '测试分区审计漂移（fast/medium/integration/heavy 覆盖被破坏）',
    severity: 'P1',
    command: 'npm run test:partitions:audit',
    timeoutMs: 5 * 60 * 1000,
    default: true,
  },
  {
    name: 'goal-projection-canary',
    title: 'Goal 投影金丝雀测试失败（分页/剧本库/向导/对齐）',
    severity: 'P1',
    command: 'npm run smoke:goal-projection',
    timeoutMs: 8 * 60 * 1000,
    default: true,
  },
  {
    name: 'mcp-handshake',
    title: 'MCP stdio 握手/能力面 smoke 失败（主交付面）',
    severity: 'P0',
    command: 'npm run mcp:smoke',
    timeoutMs: 6 * 60 * 1000,
    default: true,
  },
  {
    name: 'dep-audit',
    title: '官方 registry 生产依赖审计发现漏洞',
    severity: 'P1',
    command:
      "npm audit --omit=dev --package-lock-only --json --registry=https://registry.npmjs.org | node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const m=j.metadata?.vulnerabilities??{};const bad=(m.low??0)+(m.moderate??0)+(m.high??0)+(m.critical??0);console.log(JSON.stringify(m));process.exit(bad>0?1:0)})\"",
    timeoutMs: 3 * 60 * 1000,
    default: false, // 依赖网络；仅 --probes=all / 显式指定时跑
  },
  {
    name: 'fast-tests',
    title: 'fast 测试分区存在失败用例（行为回归）',
    severity: 'P0',
    command: 'npm run test:fast',
    timeoutMs: 30 * 60 * 1000,
    default: false, // 全量 fast 分区较重；仅 --probes=all / 显式指定 / 深度巡检时跑
  },
  {
    name: 'medium-tests',
    title: 'medium 测试分区存在失败用例（重型行为回归）',
    severity: 'P0',
    command: 'npm run test:medium',
    timeoutMs: 40 * 60 * 1000,
    default: false,
  },
  {
    name: 'integration-tests',
    title: 'integration 测试分区存在失败用例（跨模块回归）',
    severity: 'P0',
    command: 'npm run test:integration',
    // 分区单跑约 22 分钟，与 medium 同轮负载下近 28 分钟；30 分钟帽已实测误触顶（wq-0006 exit=143）。
    timeoutMs: 45 * 60 * 1000,
    default: false,
  },
  {
    name: 'heavy-tests',
    title: 'heavy 测试分区存在失败用例（重型端到端回归）',
    severity: 'P1',
    command: 'npm run test:heavy',
    timeoutMs: 40 * 60 * 1000,
    default: false,
  },
  {
    name: 'build-full',
    title: '全链 build 失败（typecheck→mcp→identity→electron-vite）',
    severity: 'P0',
    command: 'npm run build',
    timeoutMs: 20 * 60 * 1000,
    default: false,
  },
];

function normalizeForFingerprint(text: string): string {
  return (
    text
      // 时间戳 / 十六进制身份 / 临时目录等易变字段归一化，保证同根因同指纹
      .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, '<ts>')
      .replace(/\b[0-9a-f]{8,}\b/g, '<hex>')
      .replace(/\/tmp\/[^\s:]+/g, '<tmp>')
      .replace(/\/var\/folders\/[^\s:]+/g, '<tmp>')
      .replace(/\d+ms/g, '<ms>')
      .replace(/\d+(\.\d+)?(s|sec)\b/g, '<s>')
      // 只保留尾部错误区，避免无关上下文导致指纹抖动
      .slice(-4000)
  );
}

function fingerprint(output: string): string {
  return createHash('sha1').update(normalizeForFingerprint(output)).digest('hex').slice(0, 16);
}

interface ProbeResult {
  probe: string;
  exitCode: number | null;
  durationMs: number;
  logPath: string;
  itemId?: string;
  created?: boolean;
  reopened?: boolean;
}

function runProbe(spec: ProbeSpec, dryRun: boolean): ProbeResult {
  const startedAt = Date.now();
  const res = spawnSync('/bin/sh', ['-c', spec.command], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: spec.timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const durationMs = Date.now() - startedAt;
  const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  const timedOut = res.error?.message?.includes('ETIMEDOUT') || (res.status === null && durationMs >= spec.timeoutMs);
  const exitCode = res.status;

  ensureRuntimeDir();
  const logPath = join(RUNTIME_DIR, `patrol-${spec.name}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  writeFileSync(logPath, output, 'utf8');

  if (exitCode === 0) {
    return { probe: spec.name, exitCode, durationMs, logPath };
  }

  if (dryRun) {
    return { probe: spec.name, exitCode, durationMs, logPath };
  }

  const fp = fingerprint(output);
  const tail = output.trim().split('\n').slice(-6).join(' | ').slice(0, 400);
  const { created, item } = upsertFinding({
    probe: spec.name,
    fingerprint: fp,
    title: spec.title,
    severity: spec.severity,
    repro: spec.command,
    detail: timedOut
      ? `探针超时（${spec.timeoutMs / 1000}s）exit=${exitCode}; log=${logPath}; tail=${tail}`
      : `探针失败 exit=${exitCode}; fp=${fp}; log=${logPath}; tail=${tail}`,
  });
  return {
    probe: spec.name,
    exitCode,
    durationMs,
    logPath,
    itemId: item.id,
    created,
    reopened: !created && item.history.at(-1)?.event === 'reopened-by-patrol',
  };
}

function main(): void {
  const lock = acquirePatrolLock();
  if (!lock.acquired) {
    console.log(`[auto-triage] 已有巡检在运行（holder pid=${lock.holderPid ?? 'unknown'}），本次单飞跳过`);
    process.exit(0);
  }
  try {
    runPatrol();
  } finally {
    releasePatrolLock();
  }
}

function runPatrol(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const probesArg = args.find((a) => a.startsWith('--probes='))?.slice('--probes='.length);

  let selected: ProbeSpec[];
  if (!probesArg) {
    selected = PROBES.filter((p) => p.default);
  } else if (probesArg === 'all') {
    selected = [...PROBES];
  } else {
    const names = new Set(probesArg.split(',').map((s) => s.trim()));
    selected = PROBES.filter((p) => names.has(p.name));
    const unknown = [...names].filter((n) => !PROBES.some((p) => p.name === n));
    if (unknown.length > 0) {
      console.error(`[auto-triage] 未知探针：${unknown.join(', ')}；可用：${PROBES.map((p) => p.name).join(', ')}`);
      process.exit(1);
    }
  }

  if (selected.length === 0) {
    console.error('[auto-triage] 没有可跑的探针');
    process.exit(1);
  }

  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeHeartbeat('started', selected.map((p) => p.name).join(','));
  const results: ProbeResult[] = [];
  for (const spec of selected) {
    writeHeartbeat('probe-running', spec.name);
    console.log(`[auto-triage] ▶ ${spec.name}（${spec.command}）`);
    const result = runProbe(spec, dryRun);
    results.push(result);
    if (result.exitCode === 0) {
      console.log(`[auto-triage]   PASS（${result.durationMs}ms）`);
    } else if (dryRun) {
      console.log(`[auto-triage]   FAIL（dry-run 不建票，exit=${result.exitCode}，log=${result.logPath}）`);
    } else {
      const action = result.created ? '新建工作项' : result.reopened ? '重开已销项缺陷' : '刷新已知缺陷';
      console.log(`[auto-triage]   FAIL → ${action} ${result.itemId}（log=${result.logPath}）`);
    }
  }

  const summary = {
    at: new Date().toISOString(),
    dryRun,
    probes: results.map(({ probe, exitCode, durationMs, logPath, itemId, created, reopened }) => ({
      probe,
      pass: exitCode === 0,
      exitCode,
      durationMs,
      logPath,
      itemId,
      created,
      reopened,
    })),
  };
  const summaryPath = join(RUNTIME_DIR, `patrol-summary-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  writeHeartbeat('done', summaryPath);

  const failures = results.filter((r) => r.exitCode !== 0);
  console.log(
    `[auto-triage] 巡检完成：${results.length - failures.length}/${results.length} PASS；摘要=${summaryPath}`,
  );
  // 巡检器自身永远 exit 0：失败已建票，由续跑循环消化；非 0 退出码只用于脚本自身错误
}

const isMainModule = (() => {
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main();
}
