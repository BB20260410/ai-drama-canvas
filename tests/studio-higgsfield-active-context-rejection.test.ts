import { DatabaseSync } from "node:sqlite";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getActiveManagedStudioContext } from "../src/core/active-managed-studio-context.js";
import {
  executeIdempotentCommand,
  listCommandLedger,
} from "../src/core/command-bus.js";
import {
  findEventsByIdempotencyKey,
  registerProject,
  setActiveProjectRegistration,
} from "../src/core/sidecar.js";
import {
  createStudioP7Fixture,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";

const originalRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
const originalWorkspace = process.env.AI_CANVAS_WORKSPACE;
const originalRecordedDigest = process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
let fixtures: StudioP7Fixture[] = [];
let registryParent: string | undefined;

afterEach(async () => {
  if (originalRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = originalRegistry;
  if (originalWorkspace === undefined) delete process.env.AI_CANVAS_WORKSPACE;
  else process.env.AI_CANVAS_WORKSPACE = originalWorkspace;
  if (originalRecordedDigest === undefined) delete process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
  else process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST = originalRecordedDigest;
  await Promise.all(fixtures.map((fixture) => fixture.cleanup()));
  if (registryParent) await rm(registryParent, { recursive: true, force: true });
  fixtures = [];
  registryParent = undefined;
});

function higgsfieldOwnerCounts(projectRoot: string): Record<string, number | null> {
  const databasePath = path.join(projectRoot, ".aicanvas", "studio-generation-ledger.sqlite");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Object.fromEntries([
      "studio_higgsfield_connector_request_events",
      "studio_higgsfield_video_generation_events",
      "studio_higgsfield_connector_capability_events",
    ].map((table) => {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
      const count = exists
        ? Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)
        : null;
      return [table, count];
    }));
  } finally {
    db.close();
  }
}

describe.sequential("Higgsfield active context 写前拒绝", () => {
  it("受信任适配器落地前 authorize/video prepare 均被停用 fail-closed，且零 owner 写与零调用许可", async () => {
    delete process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
    registryParent = path.join("/tmp", `ai-canvas-higgsfield-context-reject-${process.pid}-${Date.now()}`);
    process.env.AI_CANVAS_REGISTRY_PATH = path.join(registryParent, "projects.json");
    const identityWorkspace = path.join(registryParent, "stable-build-identity");
    await mkdir(path.join(identityWorkspace, "src", "mcp"), { recursive: true });
    await Promise.all([
      writeFile(path.join(identityWorkspace, "package.json"), `${JSON.stringify({ name: "ai-drama-canvas", version: "0.2.0" })}\n`),
      writeFile(path.join(identityWorkspace, "src", "mcp", "server.ts"), "server.registerTool(\"fixture\", {}, () => ({}));\n"),
    ]);
    process.env.AI_CANVAS_WORKSPACE = identityWorkspace;

    const first = await createStudioP7Fixture();
    const second = await createStudioP7Fixture();
    fixtures.push(first, second);
    await registerProject(first.shell.project);
    await registerProject(second.shell.project);
    await setActiveProjectRegistration(first.root);
    const staleToken = (await getActiveManagedStudioContext()).projectContextToken;
    const before = higgsfieldOwnerCounts(first.root);
    await setActiveProjectRegistration(second.root);

    const commands = [{
      requestId: "higgsfield-context-authorize-request-001",
      idempotencyKey: "higgsfield-context-authorize-key-001",
      request: {
        command: "authorize_studio_higgsfield_connector_request" as const,
        payload: {
          requestId: "higgsfield-request-001",
          claimToken: `higgsclaim-${"a".repeat(32)}`,
          expectedRevision: 3,
          projectContextToken: staleToken,
        },
      },
    }, {
      requestId: "higgsfield-context-video-request-001",
      idempotencyKey: "higgsfield-context-video-key-001",
      request: {
        command: "prepare_studio_higgsfield_video_generation" as const,
        payload: {
          intentId: "higgsfield-video-intent-001",
          expectedVideoPackageControlFingerprint: "b".repeat(64),
          projectContextToken: staleToken,
        },
      },
    }] as const;

    for (const command of commands) {
      // 2026-08-10 已批准 P1：Higgsfield 自证明授权停用——不可信自报不再具有外部调用授权效力。
      // 停用闸在命令解析层先于 context-token 闸拒绝；写前拒绝与零副作用的安全性质不变。
      await expect(executeIdempotentCommand(first.root, command, { studioWriteActor: "codex" }))
        .rejects.toThrow(/已停用：尚未建立受信任的 Higgsfield 本机适配器/u);
      const events = await findEventsByIdempotencyKey(first.root, command.idempotencyKey);
      expect(events.some((event) => event.type === "command.side-effect-committed")).toBe(false);
    }

    const records = await listCommandLedger(first.root);
    for (const command of commands) {
      expect(records.some((record) => record.idempotencyKey === command.idempotencyKey)).toBe(false);
    }
    expect(higgsfieldOwnerCounts(first.root)).toEqual(before);
    expect(JSON.stringify(records)).not.toMatch(/"callAllowed":true|higgsnonce-|connectorRequest/u);
  }, 180_000);
});
