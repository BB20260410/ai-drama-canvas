#!/usr/bin/env node
/**
 * workqueue-patrol-lock-selftest · wq-0003 的 repro/验证脚本
 *
 * 验证巡检单飞锁三合同：
 *   1. 持有者存活时，并发竞争者必须 acquired=false 并报告 holderPid（不并行写 WORKQUEUE.json）
 *   2. 持有者释放后，下一次 acquire 必须 acquired=true
 *   3. 持有者死亡（假 pid）时，锁可被接管，不留死锁
 *
 * 若当前有真实巡检持有锁，则最多等待 5 分钟直到空闲再开始断言。
 * exit 0 = 全部合同通过；非 0 = 缺陷仍存在。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const TRY_ACQUIRE_CODE = `
import { acquirePatrolLock, releasePatrolLock } from '${REPO_ROOT}/scripts/auto-triage.ts';
const lock = acquirePatrolLock();
console.log(JSON.stringify(lock));
if (lock.acquired) {
  // tsx -e 按 CJS 处理不支持顶层 await，用定时器持锁后释放
  setTimeout(() => releasePatrolLock(), Number(process.env.HOLD_MS ?? '0'));
}
`;

function tsxRun(env = {}) {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', '-e', TRY_ACQUIRE_CODE], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function parseLock(out) {
  const line = out.split('\n').find((l) => l.trim().startsWith('{'));
  if (!line) throw new Error(`未输出锁结果：${out}`);
  return JSON.parse(line);
}

function fail(msg) {
  console.error(`[lock-selftest] FAIL: ${msg}`);
  process.exit(1);
}

// 0. 等待真实巡检释放锁（最多 5 分钟）
for (let i = 0; i < 60; i++) {
  if (!existsSync(join(REPO_ROOT, '.workqueue', 'patrol.lock'))) break;
  if (i === 59) fail('等待真实巡检释放锁超时（5 分钟）');
  await new Promise((r) => setTimeout(r, 5000));
}

// 1. 持有者持锁 1.5s，并发竞争者必须失败并报告 holderPid
const holder = spawn('npx', ['tsx', '-e', TRY_ACQUIRE_CODE], {
  cwd: REPO_ROOT,
  env: { ...process.env, HOLD_MS: '3000' },
});
await new Promise((r) => setTimeout(r, 1500)); // 等持有者完成 wx 创建

const contender = await tsxRun();
const contenderLock = parseLock(contender.out);
if (contenderLock.acquired !== false) {
  holder.kill('SIGKILL');
  fail(`持有者存活时竞争者却拿到了锁：${JSON.stringify(contenderLock)}`);
}
if (!Number.isInteger(contenderLock.holderPid)) {
  holder.kill('SIGKILL');
  fail(`竞争结果缺少 holderPid：${JSON.stringify(contenderLock)}`);
}
console.log(`[lock-selftest] 并发互斥 PASS（竞争者 acquired=false，holderPid=${contenderLock.holderPid}）`);

// 2. 等持有者自然释放后，必须能重新拿锁
await new Promise((r) => holder.on('close', r));
const afterRelease = await tsxRun();
const afterLock = parseLock(afterRelease.out);
if (afterLock.acquired !== true) {
  fail(`持有者释放后无法重新获锁：${JSON.stringify(afterLock)}`);
}
console.log('[lock-selftest] 释放后重获 PASS');

// 3. 伪造死锁（假 pid）→ 必须可接管
import('node:fs').then(async ({ writeFileSync, mkdirSync }) => {
  mkdirSync(join(REPO_ROOT, '.workqueue'), { recursive: true });
  writeFileSync(
    join(REPO_ROOT, '.workqueue', 'patrol.lock'),
    JSON.stringify({ pid: 999999, at: new Date().toISOString() }),
  );
  const takeover = await tsxRun();
  const takeoverLock = parseLock(takeover.out);
  if (takeoverLock.acquired !== true) {
    fail(`死持有者锁无法接管：${JSON.stringify(takeoverLock)}`);
  }
  console.log('[lock-selftest] 死锁接管 PASS');
  console.log('[lock-selftest] ALL PASS');
  process.exit(0);
});
