import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  registerStudioGlobalResourceReadIpc,
  type StudioGlobalResourceReadIpcServices,
} from "../src/main/studio-global-resource-read-ipc.js";

const workspace = process.cwd();
const channels = [
  "canvas:list-global-studio-assets",
  "canvas:list-global-studio-asset-images",
  "canvas:get-global-studio-asset-image",
  "canvas:list-global-studio-image-resources",
  "canvas:get-global-studio-image-resource",
  "canvas:list-global-studio-media-resources",
  "canvas:get-global-studio-media-resource",
] as const;

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown;

function collectStringChannels(sourceText: string, receiver: "ipcMain" | "ipcRenderer" | "handle", method: "handle" | "on" | "invoke"): string[] {
  const source = ts.createSourceFile("fixture.ts", sourceText, ts.ScriptTarget.Latest, true);
  const result: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      const expression = node.expression;
      const isReceiverCall = receiver === "handle"
        ? ts.isIdentifier(expression) && expression.text === "handle" && method === "handle"
        : ts.isPropertyAccessExpression(expression)
          && ts.isIdentifier(expression.expression)
          && expression.expression.text === receiver
          && expression.name.text === method;
      if (isReceiverCall) result.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

describe("Material Studio 全局资源只读 IPC registrar", () => {
  it("按精确顺序各登记一次，透传参数/结果，且不包装错误", async () => {
    const registrations: Array<{ channel: string; listener: RegisteredHandler }> = [];
    const calls: Array<{ name: string; args: unknown[] }> = [];
    const result = (name: string, ...args: unknown[]) => ({ name, args });
    const services: StudioGlobalResourceReadIpcServices = {
      listGlobalStudioAssetCatalog: async (query) => {
        calls.push({ name: "assets", args: [query] });
        return result("assets", query) as never;
      },
      listGlobalStudioAssetResourceImages: async (query) => {
        calls.push({ name: "asset-images", args: [query] });
        return result("asset-images", query) as never;
      },
      getGlobalStudioAssetResourceImage: async (projectRoot, mediaSha256) => {
        calls.push({ name: "asset-image", args: [projectRoot, mediaSha256] });
        return result("asset-image", projectRoot, mediaSha256) as never;
      },
      listGlobalStudioImageResources: async (query) => {
        calls.push({ name: "image-resources", args: [query] });
        return result("image-resources", query) as never;
      },
      getGlobalStudioImageResource: async (projectRoot, mediaSha256) => {
        calls.push({ name: "image-resource", args: [projectRoot, mediaSha256] });
        return result("image-resource", projectRoot, mediaSha256) as never;
      },
      listGlobalStudioMediaResources: async (query) => {
        calls.push({ name: "media-resources", args: [query] });
        return result("media-resources", query) as never;
      },
      getGlobalStudioMediaResource: async (projectRoot, mediaSha256) => {
        calls.push({ name: "media-resource", args: [projectRoot, mediaSha256] });
        return result("media-resource", projectRoot, mediaSha256) as never;
      },
    };

    registerStudioGlobalResourceReadIpc((channel, listener) => {
      registrations.push({ channel, listener: listener as RegisteredHandler });
    }, services);

    expect(registrations.map((entry) => entry.channel)).toEqual(channels);
    expect(new Set(registrations.map((entry) => entry.channel)).size).toBe(7);

    const inputs = [
      [{ category: "character" }],
      [{ category: "scene", limit: 3 }],
      ["/fixture/a", "a".repeat(64)],
      [{ category: "prop", search: "火" }],
      ["/fixture/b", "b".repeat(64)],
      [{ kind: "video" }],
      ["/fixture/c", "c".repeat(64)],
    ];
    await Promise.all(registrations.map(async ({ listener }, index) => {
      await expect(listener({ event: index }, ...inputs[index]!)).resolves.toEqual(
        result([
          "assets",
          "asset-images",
          "asset-image",
          "image-resources",
          "image-resource",
          "media-resources",
          "media-resource",
        ][index]!, ...inputs[index]!),
      );
    }));
    expect(calls.map((call) => call.args)).toEqual(inputs);

    const expectedError = new Error("owner-failure");
    services.listGlobalStudioAssetCatalog = async () => { throw expectedError; };
    await expect(registrations[0]!.listener({}, { category: "style" })).rejects.toBe(expectedError);
  });

  it("Main 聚合 registrar 后保持 IPC/preload ABI，且 registrar 不捕获原始 ipcMain", async () => {
    const [main, registrar, preload] = await Promise.all([
      readFile(path.join(workspace, "src/main/index.ts"), "utf8"),
      readFile(path.join(workspace, "src/main/studio-global-resource-read-ipc.ts"), "utf8"),
      readFile(path.join(workspace, "src/preload/index.ts"), "utf8"),
    ]);
    const mainHandles = collectStringChannels(main, "ipcMain", "handle");
    const registrarHandles = collectStringChannels(registrar, "handle", "handle");
    const allHandles = [...mainHandles, ...registrarHandles];
    const mainOns = collectStringChannels(main, "ipcMain", "on");
    const preloadInvokes = collectStringChannels(preload, "ipcRenderer", "invoke");

    // ABI 冻结基线 2026-08-12（wq-0004 有界重基线）：自 2026-08-10 基线后新增 4 个已批准通道：
    //   canvas:get-studio-higgsfield-video-generation-control（Higgsfield 桥只读控制面，2026-08-10 07:55 切片）
    //   canvas:list-edit-media-page（剪辑台媒体分页，运行速度整改 2026-08-10 15:42）
    //   canvas:get/set-active-hybrid-workspace-preference（小说混合工作区，2026-07-31 novel 切片）
    //   其余 reconcile/startup 与 shell-validation 通道属 07-31 前已存在集合；基线经独立终审 CLEAN 后冻结。
    expect(new Set(allHandles).size).toBe(270);
    expect(allHandles).toHaveLength(270);
    expect(mainOns).toHaveLength(3);
    expect(new Set(mainOns).size).toBe(3);
    expect(preloadInvokes).toHaveLength(257);
    expect(new Set(preloadInvokes).size).toBe(257);
    expect(createHash("sha256").update([...allHandles].sort().join("\n")).digest("hex"))
      .toBe("d472cc47d60af0ceae28f52dabc1135fb21b1bb8b7abc7de5f324c67d09e6069");
    expect(createHash("sha256").update([...preloadInvokes].sort().join("\n")).digest("hex"))
      .toBe("de772fc8a50b83f6155aad8dc54dd400382936494784e5b39658fdd7375098da");

    expect(registrar).not.toMatch(/\bipcMain\b/u);
    expect(collectStringChannels(registrar, "handle", "handle")).toEqual(channels);
    expect(main).toContain('import { registerStudioGlobalResourceReadIpc } from "./studio-global-resource-read-ipc.js";');
    const registerIpcStart = main.indexOf("function registerIpc");
    const registerIpc = main.slice(registerIpcStart, main.indexOf("function createWindow", registerIpcStart));
    expect(registerIpc).toMatch(/^function registerIpc\(\): void \{\s*installSourceRuntimeWriteGate\(\);/u);
    expect(registerIpc).toContain("registerStudioGlobalResourceReadIpc(ipcMain.handle.bind(ipcMain));");
    for (const channel of channels) expect(main).not.toContain(`ipcMain.handle("${channel}"`);
  });
});
