import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { importLocalCreativeProjectContent } from "../src/core/local-creative-project-content-import.js";
import { inspectLocalCreativeProject } from "../src/core/local-creative-project-ingest.js";
import { materializeLocalCreativeProject } from "../src/core/local-creative-project-materializer.js";
import { createManagedProject } from "../src/core/managed-project.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function parsed(result: unknown): Record<string, any> {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return JSON.parse(content.find((entry) => entry.type === "text")?.text ?? "{}") as Record<string, any>;
}

function expectNoPrivateMediaData(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain("mediaByFileId");
  expect(serialized).not.toMatch(/"(?:objectPath|databasePath|bodyPath|contentRelpath|casPath|mediaBytes)"\s*:/u);
  expect(serialized).not.toMatch(/[\\/]\.aicanvas[\\/](?:objects|studio-production[\\/]objects)[\\/]/u);
  expect(serialized).not.toMatch(/data:[^;,]+;base64,/iu);
}

async function createClient(runtimeRoot: string): Promise<Client> {
  const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  delete env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
  delete env.AI_CANVAS_RELEASE_MANIFEST_PATH;
  env.AI_CANVAS_REGISTRY_PATH = path.join(runtimeRoot, "registry", "projects.json");
  env.AI_CANVAS_MCP_ALLOW_MULTI = "1";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/server.ts"],
    cwd: workspace,
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "local-ingest-status-mcp-test", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

async function importedFixture(runtimeRoot: string): Promise<{
  projectRoot: string;
  sourceRoot: string;
}> {
  const projectsRoot = path.join(runtimeRoot, "projects");
  const sourceRoot = path.join(runtimeRoot, "source");
  await Promise.all([
    mkdir(projectsRoot),
    mkdir(path.join(sourceRoot, "场景"), { recursive: true }),
  ]);
  await sharp({
    create: { width: 24, height: 18, channels: 3, background: "#566a72" },
  }).png().toFile(path.join(sourceRoot, "场景", "scene-river.png"));
  await writeFile(
    path.join(sourceRoot, "场景锁.md"),
    "参考资产：场景/scene-river.png\n状态: APPROVED_LOCK\n唯一权威场景锁\nReview / QC: PASS\n",
  );
  await writeFile(
    path.join(sourceRoot, "S1E01_河岸剧本.md"),
    "S1E01 第一场：河岸。远景，河水从画面左侧流向右侧。\n",
  );
  const preview = await inspectLocalCreativeProject({
    projectKey: "mcp-local-ingest-story",
    projectName: "MCP 本机导入状态",
    projectType: "story-production",
    sourceLayers: [{ role: "PRIMARY_AUTHORITY", rootPath: sourceRoot }],
    computeSha256: true,
  });
  const materialized = await materializeLocalCreativeProject({
    projectsRoot,
    project: {
      key: preview.project.key,
      name: preview.project.name,
      projectType: preview.project.type,
      resolution: "CREATE_MANAGED",
      sources: [{ root: sourceRoot, role: "PRIMARY_AUTHORITY" }],
      authorityPolicy: "EVIDENCE_REQUIRED",
      scanSummary: {
        previewFingerprint: preview.previewFingerprint,
        statistics: { ...preview.statistics },
        lockEvidence: {
          approved: 1,
          candidate: 0,
          references: preview.references.length,
          locksWithReferences: 1,
        },
        warnings: { total: preview.warnings.length, byCode: {} },
      },
    },
  });
  await importLocalCreativeProjectContent({
    projectRoot: materialized.projectRoot,
    preview,
    authorityPolicy: "CREATE_PENDING_FROM_APPROVED_LOCKS",
  });
  return { projectRoot: materialized.projectRoot, sourceRoot };
}

describe("本机创作项目导入状态 MCP", () => {
  it("暴露有界只读状态，明确视觉未确认且 authority 未继承", async () => {
    const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "mcp-local-ingest-status-")));
    temporaryRoots.push(runtimeRoot);
    const fixture = await importedFixture(runtimeRoot);
    const ordinary = await createManagedProject({
      parentRoot: path.join(runtimeRoot, "projects"),
      name: "非本机导入普通工程",
      slug: "ordinary",
    });
    const client = await createClient(runtimeRoot);
    try {
      const tools = await client.listTools();
      const tool = tools.tools.find((entry) => entry.name === "get_local_creative_project_ingest_status");
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect((tool?.inputSchema as { required?: string[] }).required).toContain("projectRoot");
      expect(JSON.stringify(tool?.inputSchema)).toContain("cursor");
      expect(JSON.stringify(tool?.inputSchema)).toContain("limit");

      const status = parsed(await client.callTool({
        name: "get_local_creative_project_ingest_status",
        arguments: { projectRoot: fixture.projectRoot, limit: 1 },
      }));
      expect(status).toMatchObject({
        kind: "local-creative-project-ingest-status",
        project: { key: "mcp-local-ingest-story", type: "story-production" },
        sourceLayers: [{
          role: "PRIMARY_AUTHORITY",
          rootBasename: "source",
          rootFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }],
        contentImport: {
          status: "completed",
          truthStatus: "PARTIAL_BY_POLICY",
          appliedAuthorityPolicy: "CREATE_PENDING_FROM_APPROVED_LOCKS",
          documentCoverage: {
            sourceDocuments: 2,
            eligibleTextDocuments: 2,
            selectedDocuments: 1,
            importEligibleDocuments: 1,
            inventoryOnlyDocuments: 1,
          },
          documentClassification: {
            verified: true,
            byClass: { script: 1, other: 1 },
            byImportTarget: { script: 1, "inventory-only": 1 },
          },
          runSummary: {
            documentsSelected: 1,
            documentsImported: 1,
            mediaImported: 1,
            authorityPromotions: 0,
          },
        },
        managedCounts: {
          media: { unique: 1, origins: 1 },
          documents: { total: 1, script: 1, prompt: 0 },
          assets: { canonical: 1, pendingVersions: 1, primaryAuthorities: 0 },
        },
        lockReferenceIndex: {
          available: true,
          total: 2,
          items: [{ visualAppearance: "UNCONFIRMED" }],
        },
        canonicalDecisions: {
          available: true,
          total: 1,
          items: [{ authorityPromoted: false, visualAppearance: "UNCONFIRMED" }],
        },
        visualAppearance: "UNCONFIRMED",
        authority: {
          authorityInherited: false,
          sourceDeclarationsPromotedAutomatically: false,
          managedPrimaryAuthorities: 0,
        },
      });
      expect(status.sourceLayers[0]).not.toHaveProperty("root");
      expect(status.lockReferenceIndex.items[0]).toEqual(expect.objectContaining({
        lockBasename: expect.any(String),
        lockPathFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }));
      expectNoPrivateMediaData(status);

      const ordinaryResult = await client.callTool({
        name: "get_local_creative_project_ingest_status",
        arguments: { projectRoot: ordinary.paths.root },
      }) as { isError?: boolean; content?: unknown };
      expect(ordinaryResult.isError).toBe(true);
      expect(JSON.stringify(ordinaryResult)).toMatch(/本机创作导入|ingest manifest|不存在/u);
      expectNoPrivateMediaData(ordinaryResult);
    } finally {
      await client.close();
    }
  }, 120_000);
});
