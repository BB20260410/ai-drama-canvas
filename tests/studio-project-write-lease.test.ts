import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  executeIdempotentCommand,
  listCommandLedger,
} from "../src/core/command-bus.js";
import { createManagedStudioProject } from "../src/core/service.js";
import {
  acquireStudioProjectWriteLease,
  assertStudioProjectWriteLeaseForCommand,
  getStudioProjectWriteLease,
  recommendGenerationUnknownDisposition,
  releaseStudioProjectWriteLease,
  STUDIO_WRITE_LEASE_ENFORCED_COMMANDS,
  StudioProjectWriteLeaseError,
} from "../src/core/studio-project-write-lease.js";
import { listStudioTextDocuments } from "../src/core/studio-production.js";

describe("studio-project-write-lease", () => {
  let temporaryRoot: string;
  let root: string;
  let priorRegistryPath: string | undefined;

  beforeEach(async () => {
    temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "aicanvas-write-lease-")));
    priorRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
    process.env.AI_CANVAS_REGISTRY_PATH = path.join(temporaryRoot, "registry", "projects.json");
    const shell = await createManagedStudioProject({
      parentRoot: temporaryRoot,
      name: "lease-test",
      slug: "lease-test",
    });
    root = shell.paths.root;
  });

  afterEach(async () => {
    delete process.env.AI_CANVAS_TEST_COMMAND_DELAY_COMMAND;
    delete process.env.AI_CANVAS_TEST_COMMAND_DELAY_MS;
    STUDIO_WRITE_LEASE_ENFORCED_COMMANDS.delete("create_studio_script_document");
    if (priorRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
    else process.env.AI_CANVAS_REGISTRY_PATH = priorRegistryPath;
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("compat 模式：无租约时生图写放行", async () => {
    const prior = process.env.AI_CANVAS_WRITE_LEASE_MODE;
    process.env.AI_CANVAS_WRITE_LEASE_MODE = "compat";
    try {
      await expect(assertStudioProjectWriteLeaseForCommand(root, {
        command: "dispatch_studio_generation_pack",
      })).resolves.toBeUndefined();
      const projection = await getStudioProjectWriteLease(root);
      expect(projection.held).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.AI_CANVAS_WRITE_LEASE_MODE;
      else process.env.AI_CANVAS_WRITE_LEASE_MODE = prior;
    }
  });

  it("require 模式：无租约不准写", async () => {
    const prior = process.env.AI_CANVAS_WRITE_LEASE_MODE;
    process.env.AI_CANVAS_WRITE_LEASE_MODE = "require";
    try {
      await expect(assertStudioProjectWriteLeaseForCommand(root, {
        command: "dispatch_studio_generation_pack",
      })).rejects.toMatchObject({ code: "lease-required" });

      const lease = await acquireStudioProjectWriteLease(root, {
        holderId: "agent-req",
        holderKind: "agent",
        ttlSeconds: 120,
      });
      await expect(assertStudioProjectWriteLeaseForCommand(root, {
        command: "dispatch_studio_generation_pack",
        holderId: "agent-req",
        leaseToken: lease.leaseToken,
      })).resolves.toBeUndefined();
      await expect(assertStudioProjectWriteLeaseForCommand(root, {
        command: "submit_studio_post_result_observation",
      })).rejects.toMatchObject({ code: "lease-held" });
      await expect(assertStudioProjectWriteLeaseForCommand(root, {
        command: "submit_studio_post_result_observation",
        holderId: "agent-req",
        leaseToken: lease.leaseToken,
      })).resolves.toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env.AI_CANVAS_WRITE_LEASE_MODE;
      else process.env.AI_CANVAS_WRITE_LEASE_MODE = prior;
    }
  });

  it("acquire 后异主 dispatch 被硬拒，持有者可过", async () => {
    const lease = await acquireStudioProjectWriteLease(root, {
      holderId: "grok-session-1",
      holderKind: "grok",
      ttlSeconds: 120,
    });
    expect(lease.leaseToken.startsWith("lease-")).toBe(true);

    await expect(assertStudioProjectWriteLeaseForCommand(root, {
      command: "dispatch_studio_generation_pack",
      holderId: "codex-session-2",
      leaseToken: lease.leaseToken,
    })).rejects.toMatchObject({ code: "lease-held" });

    await expect(assertStudioProjectWriteLeaseForCommand(root, {
      command: "dispatch_studio_generation_pack",
      holderId: "grok-session-1",
      leaseToken: lease.leaseToken,
    })).resolves.toBeUndefined();

    // 非生图命令不受租约闸
    await expect(assertStudioProjectWriteLeaseForCommand(root, {
      command: "create_studio_script_document",
      holderId: "codex-session-2",
    })).resolves.toBeUndefined();
  });

  it("同 holder+token 可心跳续租；异主 acquire 失败；release 后可重获", async () => {
    const first = await acquireStudioProjectWriteLease(root, {
      holderId: "codex-a",
      holderKind: "codex",
      ttlSeconds: 60,
    });
    const renewed = await acquireStudioProjectWriteLease(root, {
      holderId: "codex-a",
      holderKind: "codex",
      leaseToken: first.leaseToken,
      ttlSeconds: 90,
    });
    expect(renewed.leaseToken).toBe(first.leaseToken);

    await expect(acquireStudioProjectWriteLease(root, {
      holderId: "grok-b",
      holderKind: "grok",
    })).rejects.toBeInstanceOf(StudioProjectWriteLeaseError);

    await releaseStudioProjectWriteLease(root, {
      holderId: "codex-a",
      leaseToken: first.leaseToken,
    });
    const next = await acquireStudioProjectWriteLease(root, {
      holderId: "grok-b",
      holderKind: "grok",
    });
    expect(next.holderId).toBe("grok-b");
  });

  it("初检后排队期间租约换主时在实际写入前复验，旧 holder 零写入", async () => {
    STUDIO_WRITE_LEASE_ENFORCED_COMMANDS.add("create_studio_script_document");
    const first = await acquireStudioProjectWriteLease(root, {
      holderId: "codex-stale",
      holderKind: "codex",
      ttlSeconds: 120,
    });
    process.env.AI_CANVAS_TEST_COMMAND_DELAY_COMMAND = "create_studio_script_document";
    process.env.AI_CANVAS_TEST_COMMAND_DELAY_MS = "1000";
    const command = executeIdempotentCommand(root, {
      requestId: "lease-fence-request-0001",
      idempotencyKey: "lease-fence-idempotency-0001",
      request: {
        command: "create_studio_script_document",
        payload: {
          id: "script-stale-lease-must-not-write",
          title: "旧租约不得写入",
          expectedRevision: 0,
        },
      },
    }, {
      writeLeaseHolderId: first.holderId,
      writeLeaseToken: first.leaseToken,
    });

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const record = (await listCommandLedger(root))
        .find((entry) => entry.idempotencyKey === "lease-fence-idempotency-0001");
      if (record?.execution?.phase === "executing") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await listCommandLedger(root))
      .find((entry) => entry.idempotencyKey === "lease-fence-idempotency-0001")?.execution?.phase)
      .toBe("executing");

    const takeover = await acquireStudioProjectWriteLease(root, {
      holderId: "grok-current",
      holderKind: "grok",
      forceTakeover: true,
      takeoverReason: "测试初检之后实际提交之前的租约代次切换",
      ttlSeconds: 120,
    });
    expect(takeover.leaseToken).not.toBe(first.leaseToken);
    await expect(command).rejects.toThrow(/租约|lease/u);
    expect((await listStudioTextDocuments(root, { kind: "script", limit: 10 })).items).toHaveLength(0);
  });

  it("generation_unknown 处置永远禁止 redispatch", () => {
    const a = recommendGenerationUnknownDisposition({
      hasCallIntent: true,
      hasCommittedResult: false,
      runTerminal: null,
      remoteMayExist: true,
    });
    expect(a.allowRedispatch).toBe(false);
    expect(a.disposition).toBe("reconcile_only");

    const b = recommendGenerationUnknownDisposition({
      hasCallIntent: false,
      hasCommittedResult: true,
      runTerminal: null,
      remoteMayExist: false,
    });
    expect(b.allowRedispatch).toBe(false);
    expect(b.disposition).toBe("clear");
  });
});
