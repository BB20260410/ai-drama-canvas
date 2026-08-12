import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getActiveManagedStudioContext } from "../src/core/active-managed-studio-context.js";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import {
  __setBeforeImagegenIntentTransactionHookForTests,
  dispatchStudioGenerationPack,
  freezeAndPersistStudioUnitGridGenerationPack,
} from "../src/core/studio-generation-ledger.js";
import {
  __setAfterActiveProjectStateSnapshotHookForTests,
  getActiveProjectRegistrationSnapshot,
  getActiveProjectStateReadOnly,
  registerProject,
  setActiveProjectRegistration,
  unregisterProject,
} from "../src/core/sidecar.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedPanelContinuity,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";

const originalRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
const originalWorkspace = process.env.AI_CANVAS_WORKSPACE;
const originalRecordedDigest = process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
let fixtures: StudioP7Fixture[] = [];
let registryParent: string | undefined;

afterEach(async () => {
  __setBeforeImagegenIntentTransactionHookForTests(null);
  __setAfterActiveProjectStateSnapshotHookForTests(null);
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

describe.sequential("imagegen active-project activation fence", () => {
  it("state 与 registration 在同一 registry 快照读取，A→B→A 不能制造拼接上下文", async () => {
    registryParent = path.join("/tmp", `ai-canvas-active-snapshot-${process.pid}-${Date.now()}`);
    process.env.AI_CANVAS_REGISTRY_PATH = path.join(registryParent, "projects.json");
    const first = await createStudioP7Fixture();
    const second = await createStudioP7Fixture();
    fixtures.push(first, second);
    await registerProject(first.shell.project);
    await registerProject(second.shell.project);
    await setActiveProjectRegistration(first.root);

    let switchPromise: Promise<void> | undefined;
    let switchSettled = false;
    __setAfterActiveProjectStateSnapshotHookForTests(async () => {
      switchPromise = (async () => {
        await setActiveProjectRegistration(second.root);
        await setActiveProjectRegistration(first.root);
      })().finally(() => {
        switchSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(switchSettled).toBe(false);
    });
    const snapshot = await getActiveProjectRegistrationSnapshot();
    expect(path.resolve(snapshot.state!.primaryRoot)).toBe(path.resolve(first.root));
    expect(path.resolve(snapshot.registration!.primaryRoot)).toBe(path.resolve(first.root));
    await switchPromise;
    const after = await getActiveProjectStateReadOnly();
    expect(path.resolve(after!.primaryRoot)).toBe(path.resolve(first.root));
    expect(after!.activationId).not.toBe(snapshot.state!.activationId);
  }, 180_000);

  it("token 首检至 call intent 落盘期间阻止切换活动工程", async () => {
    delete process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
    registryParent = path.join("/tmp", `ai-canvas-active-fence-${process.pid}-${Date.now()}`);
    process.env.AI_CANVAS_REGISTRY_PATH = path.join(registryParent, "projects.json");
    const first = await createStudioP7Fixture();
    const second = await createStudioP7Fixture();
    fixtures.push(first, second);
    const identityWorkspace = path.join(registryParent, "stable-build-identity");
    await mkdir(path.join(identityWorkspace, "src", "mcp"), { recursive: true });
    await Promise.all([
      writeFile(path.join(identityWorkspace, "package.json"), `${JSON.stringify({ name: "ai-drama-canvas", version: "0.2.0" })}\n`),
      writeFile(path.join(identityWorkspace, "src", "mcp", "server.ts"), "server.registerTool(\"fixture\", {}, () => ({}));\n"),
    ]);
    process.env.AI_CANVAS_WORKSPACE = identityWorkspace;
    await registerProject(first.shell.project);
    await registerProject(second.shell.project);
    await setActiveProjectRegistration(first.root);

    for (const panel of first.units.sixPanel.panels) {
      await seedStudioP7ResolvedPanelContinuity(first.root, {
        unitId: first.units.sixPanel.unit.id,
        panelId: panel.id,
        assetIds: panel.assets
          .filter((asset) => asset.presence !== "forbidden")
          .map((asset) => asset.assetId),
      });
    }
    const frozen = await freezeAndPersistStudioUnitGridGenerationPack(first.root, {
      targetKind: "unit-grid",
      unitId: first.units.sixPanel.unit.id,
    });
    const generationRunId = "active-project-fence-run-0001";
    await dispatchStudioGenerationPack(first.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId,
      provider: "codex",
    });
    const context = await getActiveManagedStudioContext();

    let switchPromise: Promise<void> | undefined;
    let switchSettled = false;
    __setBeforeImagegenIntentTransactionHookForTests(async () => {
      switchPromise = setActiveProjectRegistration(second.root).finally(() => {
        switchSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(switchSettled).toBe(false);
      const during = await getActiveProjectStateReadOnly();
      expect(path.resolve(during!.primaryRoot)).toBe(path.resolve(first.root));
    });

    const prepared = await executeIdempotentCommand(first.root, {
      requestId: "active-project-fence-request-0001",
      idempotencyKey: "active-project-fence-idempotency-0001",
      request: {
        command: "prepare_studio_imagegen_call",
        payload: {
          packId: frozen.packId,
          packFingerprint: frozen.fingerprint,
          generationRunId,
          provider: "codex",
          projectContextToken: context.projectContextToken,
          expectedRevision: 0,
        },
      },
    });
    expect(prepared).toMatchObject({
      status: "succeeded",
      result: { callAllowed: true, idempotentReplay: false },
    });
    await switchPromise;
    const after = await getActiveProjectStateReadOnly();
    expect(path.resolve(after!.primaryRoot)).toBe(path.resolve(second.root));
  }, 180_000);

  it("token 首检至 call intent 落盘期间阻止注销活动工程", async () => {
    delete process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
    registryParent = path.join("/tmp", `ai-canvas-active-unregister-fence-${process.pid}-${Date.now()}`);
    process.env.AI_CANVAS_REGISTRY_PATH = path.join(registryParent, "projects.json");
    const first = await createStudioP7Fixture();
    fixtures.push(first);
    const identityWorkspace = path.join(registryParent, "stable-build-identity");
    await mkdir(path.join(identityWorkspace, "src", "mcp"), { recursive: true });
    await Promise.all([
      writeFile(path.join(identityWorkspace, "package.json"), `${JSON.stringify({ name: "ai-drama-canvas", version: "0.2.0" })}\n`),
      writeFile(path.join(identityWorkspace, "src", "mcp", "server.ts"), "server.registerTool(\"fixture\", {}, () => ({}));\n"),
    ]);
    process.env.AI_CANVAS_WORKSPACE = identityWorkspace;
    await registerProject(first.shell.project);
    await setActiveProjectRegistration(first.root);

    for (const panel of first.units.sixPanel.panels) {
      await seedStudioP7ResolvedPanelContinuity(first.root, {
        unitId: first.units.sixPanel.unit.id,
        panelId: panel.id,
        assetIds: panel.assets
          .filter((asset) => asset.presence !== "forbidden")
          .map((asset) => asset.assetId),
      });
    }
    const frozen = await freezeAndPersistStudioUnitGridGenerationPack(first.root, {
      targetKind: "unit-grid",
      unitId: first.units.sixPanel.unit.id,
    });
    const generationRunId = "active-project-unregister-fence-run-0001";
    await dispatchStudioGenerationPack(first.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId,
      provider: "codex",
    });
    const context = await getActiveManagedStudioContext();

    let unregisterPromise: Promise<void> | undefined;
    let unregisterSettled = false;
    __setBeforeImagegenIntentTransactionHookForTests(async () => {
      unregisterPromise = unregisterProject(first.root).finally(() => {
        unregisterSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(unregisterSettled).toBe(false);
      const during = await getActiveProjectStateReadOnly();
      expect(path.resolve(during!.primaryRoot)).toBe(path.resolve(first.root));
    });

    const prepared = await executeIdempotentCommand(first.root, {
      requestId: "active-project-unregister-fence-request-0001",
      idempotencyKey: "active-project-unregister-fence-idempotency-0001",
      request: {
        command: "prepare_studio_imagegen_call",
        payload: {
          packId: frozen.packId,
          packFingerprint: frozen.fingerprint,
          generationRunId,
          provider: "codex",
          projectContextToken: context.projectContextToken,
          expectedRevision: 0,
        },
      },
    });
    expect(prepared).toMatchObject({
      status: "succeeded",
      result: { callAllowed: true, idempotentReplay: false },
    });
    expect(unregisterPromise).toBeDefined();
    await unregisterPromise;
    expect(await getActiveProjectStateReadOnly()).toBeNull();
  }, 180_000);
});
