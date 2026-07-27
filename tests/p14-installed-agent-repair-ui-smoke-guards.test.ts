import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertP14AgentRepairEvidenceHasNoSensitivePayload,
  assertP14InstalledAgentRepairEvidence,
  p14AgentRepairEvidenceDigest,
  parseP14InstalledAgentRepairCli,
  type P14InstalledAgentRepairEvidence,
} from "../scripts/p14-installed-agent-repair-ui-smoke-guards.js";

function validEvidence(): P14InstalledAgentRepairEvidence {
  const inventory = { files: 85, bytes: 1_024, aggregateSha256: "a".repeat(64) };
  const body = {
    schemaVersion: 1 as const,
    kind: "p14-installed-agent-repair-ui-smoke" as const,
    status: "PASS" as const,
    runtime: {
      installedBundle: true as const,
      localOnly: true as const,
      executablePathSha256: "b".repeat(64),
      sourceDigest: "c".repeat(64),
      buildId: "d".repeat(32),
      mcpToolCount: 183,
    },
    project: {
      projectRootPathSha256: "e".repeat(64),
      managed: true as const,
      explicitActiveProject: true as const,
      defaultRegistry: true as const,
      before: inventory,
      after: { ...inventory },
      unchanged: true as const,
    },
    agents: {
      repairButtonClicked: true as const,
      repairIpcCompletedAfterGrokDoctor: true as const,
      codexCurrent: true as const,
      grokCurrent: true as const,
      codexConfiguredRuntimeStarted: true as const,
      codexRuntimeToolCount: 183,
    },
    backup: {
      newDirectoryCount: 1 as const,
      directoryPathSha256: "f".repeat(64),
      directoryMode: "0700" as const,
      files: [
        { role: "codex-config" as const, originalState: "present" as const, sha256: "1".repeat(64), mode: "0600" as const, matchesPreRepairSnapshot: true as const },
        { role: "grok-config" as const, originalState: "missing" as const, sha256: "2".repeat(64), mode: "0600" as const, matchesPreRepairSnapshot: true as const },
      ],
      preserved: true as const,
    },
    repairedConfigs: {
      codex: { state: "present" as const, sha256: "3".repeat(64), mode: "0600" as const },
      grok: { state: "present" as const, sha256: "4".repeat(64), mode: "0600" as const },
    },
    ui: {
      screenshot: {
        fileName: "01-agent-connection-repaired.png" as const,
        sha256: "5".repeat(64),
        width: 1_728,
        height: 1_029,
        sizeBytes: 20_001,
        maxChannelStandardDeviation: 3.1,
      },
      pageErrorCount: 0 as const,
      consoleErrorCount: 0 as const,
      externalRequestCount: 0 as const,
      highEntropyValueCount: 0 as const,
    },
    boundaries: {
      realHome: true as const,
      isolatedUserData: true as const,
      noProjectWrites: true as const,
      noConfigContentsInEvidence: true as const,
      noSecretEnvironmentForwardedToMcpProbe: true as const,
      failureKeepsBackup: true as const,
    },
  };
  return { ...body, fingerprint: p14AgentRepairEvidenceDigest(body) };
}

describe("P14 安装版 Agent 修复 UI smoke guards", () => {
  it("工程内容快照忽略运行时锁造成的目录时间戳变化，但保留逐文件 SHA", () => {
    const source = readFileSync(new URL("../scripts/ui-p14-installed-agent-repair-smoke.ts", import.meta.url), "utf8");
    expect(source).toContain('rows.push(`D\\0${safeRelative}\\0${metadata.mode.toString()}`)');
    expect(source).toContain("await sha256File(absolute)");
    expect(source).not.toContain("metadata.mtimeNs");
    expect(source).not.toContain("metadata.ctimeNs");
  });

  it("只接受安装版、显式受管工程和两个工程外全新输出路径", () => {
    const input = [
      "/Applications/AI 漫剧画布.app/Contents/MacOS/AI 漫剧画布",
      "/Users/test/Documents/AI漫剧项目/验收工程",
      "/tmp/p14-agent-repair.json",
      "/tmp/p14-agent-repair-shots",
    ];
    expect(parseP14InstalledAgentRepairCli(input)).toEqual({
      executablePath: input[0], projectRoot: input[1], evidencePath: input[2], screenshotDirectory: input[3],
    });
    expect(() => parseP14InstalledAgentRepairCli(input.slice(0, 3))).toThrow(/用法/u);
    expect(() => parseP14InstalledAgentRepairCli(["./app", ...input.slice(1)])).toThrow(/绝对路径/u);
    expect(() => parseP14InstalledAgentRepairCli([input[0]!, input[1]!, `${input[1]}/evidence.json`, input[3]!])).toThrow(/验收工程内/u);
    expect(() => parseP14InstalledAgentRepairCli([input[0]!, input[1]!, input[2]!, "/Applications/AI 漫剧画布.app/shots"])).toThrow(/安装包内/u);
  });

  it("PASS 必须证明工程不变、双端 current、doctor 后返回、MCP 启动与 0700/0600 备份", () => {
    const evidence = validEvidence();
    expect(() => assertP14InstalledAgentRepairEvidence(evidence)).not.toThrow();
    const changed = {
      ...evidence,
      project: { ...evidence.project, after: { ...evidence.project.after, aggregateSha256: "9".repeat(64) } },
    };
    expect(() => assertP14InstalledAgentRepairEvidence({
      ...changed,
      fingerprint: p14AgentRepairEvidenceDigest(Object.fromEntries(Object.entries(changed).filter(([key]) => key !== "fingerprint"))),
    } as P14InstalledAgentRepairEvidence)).toThrow(/project\.unchanged/u);
    expect(() => assertP14InstalledAgentRepairEvidence({ ...evidence, agents: { ...evidence.agents, grokCurrent: false } } as unknown as P14InstalledAgentRepairEvidence)).toThrow(/agents|fingerprint/u);
    expect(() => assertP14InstalledAgentRepairEvidence({ ...evidence, backup: { ...evidence.backup, directoryMode: "0755" } } as unknown as P14InstalledAgentRepairEvidence)).toThrow(/backup|fingerprint/u);
  });

  it("证据拒绝配置内容、命令输出、原始绝对路径和伪造 fingerprint", () => {
    const evidence = validEvidence();
    expect(() => assertP14AgentRepairEvidenceHasNoSensitivePayload({ ...evidence, stdout: "secret" })).toThrow(/禁止字段/u);
    expect(() => assertP14AgentRepairEvidenceHasNoSensitivePayload({ ...evidence, projectRoot: "/Users/test/project" })).toThrow(/原始路径|绝对路径/u);
    expect(() => assertP14InstalledAgentRepairEvidence({ ...evidence, fingerprint: "0".repeat(64) })).toThrow(/fingerprint\.content/u);
    expect(JSON.stringify(evidence)).not.toMatch(/\/Users\/|\/Applications\/|api.?key|password|token/iu);
  });
});
