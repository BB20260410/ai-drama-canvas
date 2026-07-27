/**
 * 红线工程只读哨兵：确认 dudu-s1e1 / codex 正式库未被本波破坏。
 * 用法：npx tsx scripts/redline-project-sentinel.ts [--json path]
 * 退出码：0 全过；1 失败；2 工程缺失
 */
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getApprovedTimelineProjection } from "../src/core/studio-approved-timeline-projection.js";
import { getStudioProductionDashboard } from "../src/core/studio-production-dashboard.js";
import { resolveRuntimeBuildIdentity } from "../src/core/build-identity.js";
import {
  assertRedlineProjectSentinelsUnchanged,
  createIsolatedRedlineProjectCopy,
  snapshotRedlineProjectSentinels,
  type RedlineSentinelSnapshot,
} from "./lib/redline-project-sentinel-shared.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dudu = path.join(root, "projects/dudu-s1e1-a84aa353");
const codex = path.join(root, "projects/codex-ai-drama-studio");
const isolation = path.join(root, "projects/grok-mvp-qingdeng-mrwc97mu-d0aea463");

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

interface IsolatedProbe<T> {
  value: T;
  formalSentinelsBefore: RedlineSentinelSnapshot[];
  formalSentinelsAfter: RedlineSentinelSnapshot[];
  copyRoot: string;
}

/**
 * 注意：dashboard / projection 会通过 Core 打开数据库，且旧工程可能触发补齐
 * schema。因此所有探针一律只接收完整临时副本，随后复核正式根的 hash/mtime。
 */
async function probeOnIsolatedProject<T>(
  projectRoot: string,
  probe: (copyRoot: string) => Promise<T>,
): Promise<IsolatedProbe<T>> {
  const formalSentinelsBefore = await snapshotRedlineProjectSentinels(projectRoot);
  const isolated = await createIsolatedRedlineProjectCopy(projectRoot);
  try {
    const value = await probe(isolated.projectRoot);
    const formalSentinelsAfter = await assertRedlineProjectSentinelsUnchanged(projectRoot, formalSentinelsBefore);
    return { value, formalSentinelsBefore, formalSentinelsAfter, copyRoot: isolated.projectRoot };
  } finally {
    await isolated.cleanup().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const checks: Array<Record<string, unknown>> = [];
  let failed = 0;

  if (!(await exists(dudu))) {
    console.error("missing dudu-s1e1 project");
    process.exit(2);
  }

  const duduProbe = await probeOnIsolatedProject(dudu, async (copyRoot) => ({
    overview: await getStudioProductionDashboard(copyRoot, { operation: "overview" }),
    projection: await getApprovedTimelineProjection(copyRoot, {
      season: "S1",
      episode: "S1E1",
      fastMode: true,
    }),
  }));
  const duduOverview = duduProbe.value.overview;
  const duduProj = duduProbe.value.projection;
  const duduUnits = (duduOverview as { counts?: { units?: number } }).counts?.units;
  const duduPass = (duduProj as { summary?: { pass?: number }; unitCount?: number }).summary?.pass;
  const duduUnitCount = (duduProj as { unitCount?: number }).unitCount;
  const duduOk = duduUnits === 33 && duduUnitCount === 33 && duduPass === 33;
  checks.push({
    id: "dudu-s1e1-formal",
    project: dudu,
    expect: { units: 33, unitCount: 33, pass: 33 },
    actual: { units: duduUnits, unitCount: duduUnitCount, pass: duduPass },
    pass: duduOk,
    isolation: {
      coreProjectRoot: duduProbe.copyRoot,
      formalSentinelsBefore: duduProbe.formalSentinelsBefore,
      formalSentinelsAfter: duduProbe.formalSentinelsAfter,
      verifiedUnchanged: true,
    },
    sampleRaw: ((duduProj as { units?: Array<{ selectedRawSha256?: string }> }).units ?? [])
      .slice(0, 3)
      .map((u) => u.selectedRawSha256),
  });
  if (!duduOk) failed += 1;

  if (await exists(codex)) {
    const codexProbe = await probeOnIsolatedProject(codex, (copyRoot) => (
      getStudioProductionDashboard(copyRoot, { operation: "overview" })
    ));
    const codexOverview = codexProbe.value;
    const counts = (codexOverview as { counts?: { units?: number; media?: number; canonicalAssets?: number } })
      .counts;
    const codexOk = counts?.units === 541 && (counts?.media ?? 0) > 0;
    checks.push({
      id: "codex-ai-drama-studio-counts",
      project: codex,
      expect: { units: 541 },
      actual: counts,
      pass: codexOk,
      note: "只读 counts；不读/改 PASS raw；Core 仅在完整临时副本运行",
      isolation: {
        coreProjectRoot: codexProbe.copyRoot,
        formalSentinelsBefore: codexProbe.formalSentinelsBefore,
        formalSentinelsAfter: codexProbe.formalSentinelsAfter,
        verifiedUnchanged: true,
      },
    });
    if (!codexOk) failed += 1;
  } else {
    checks.push({ id: "codex-ai-drama-studio-counts", pass: false, error: "missing" });
    failed += 1;
  }

  let isolationNote: Record<string, unknown> = { present: false };
  if (await exists(isolation)) {
    const isolationProbe = await probeOnIsolatedProject(isolation, async (copyRoot) => ({
      overview: await getStudioProductionDashboard(copyRoot, { operation: "overview" }),
      projection: await getApprovedTimelineProjection(copyRoot, {
        season: "S1",
        episode: "S1E1",
        fastMode: true,
      }),
    }));
    const isoOverview = isolationProbe.value.overview;
    const isoProj = isolationProbe.value.projection;
    isolationNote = {
      present: true,
      projectId: (isoOverview as { projectId?: string }).projectId,
      unitCount: (isoProj as { unitCount?: number }).unitCount,
      summary: (isoProj as { summary?: unknown }).summary,
      note: "隔离 canary 也只在完整临时副本探测",
      isolation: {
        coreProjectRoot: isolationProbe.copyRoot,
        formalSentinelsBefore: isolationProbe.formalSentinelsBefore,
        formalSentinelsAfter: isolationProbe.formalSentinelsAfter,
        verifiedUnchanged: true,
      },
    };
  }
  checks.push({ id: "isolation-snapshot", ...isolationNote, pass: true });

  const bi = await resolveRuntimeBuildIdentity(root);
  checks.push({
    id: "build-identity",
    buildId: bi.buildId,
    packageVersion: bi.packageVersion,
    hasFingerprint: Boolean(bi.buildId && bi.sourceDigest),
    pass: Boolean(bi.buildId),
  });
  if (!bi.buildId) failed += 1;

  const report = {
    schemaVersion: 1,
    kind: "redline-project-sentinel",
    mode: "formal-readonly-copy-core-probes",
    createdAt: new Date().toISOString(),
    pass: failed === 0,
    failed,
    checks,
  };

  const jsonIdx = process.argv.indexOf("--json");
  const outPath =
    jsonIdx >= 0 && process.argv[jsonIdx + 1]
      ? path.resolve(process.argv[jsonIdx + 1]!)
      : path.join(root, "docs/evidence/discipline-phases-20260725/p0-redline-sentinel.json");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ pass: report.pass, failed, outPath, buildId: bi.buildId }, null, 2));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
