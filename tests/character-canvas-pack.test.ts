import { describe, expect, it } from "vitest";
import {
  audioSha256sForCharacterAsset,
  ingestCharacterCanvasPack,
  isCharacterAudioPath,
  isCharacterImagePath,
  splitCanvasAssetAliases,
  type CharacterCanvasPackApi,
} from "../src/renderer/src/character-canvas-pack.js";
import type { VoiceIdentity } from "../src/core/types.js";

const IMAGE_SHA = "a".repeat(64);
const AUDIO_SHA = "b".repeat(64);

function voice(partial: Partial<VoiceIdentity>): VoiceIdentity {
  return {
    id: "voice-1",
    name: "阿航声线",
    language: "zh-CN",
    description: "",
    samplePaths: [],
    characterAssetIds: [],
    characterItemIds: [],
    sampleMediaSha256s: [],
    tags: [],
    revision: 1,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    ...partial,
  };
}

describe("画布角色库入库", () => {
  it("只接受图片和音频扩展名", () => {
    expect(isCharacterImagePath("/tmp/阿航.png")).toBe(true);
    expect(isCharacterImagePath("/tmp/阿航.mp3")).toBe(false);
    expect(isCharacterAudioPath("/tmp/阿航.wav")).toBe(true);
    expect(isCharacterAudioPath("/tmp/阿航.png")).toBe(false);
  });

  it("别名按逗号、中文逗号和换行拆分并去空", () => {
    expect(splitCanvasAssetAliases("阿航，小航, 航航\n阿航")).toEqual(["阿航", "小航", "航航"]);
    expect(splitCanvasAssetAliases("  ")).toEqual([]);
  });

  it("入库把非空 aliases 写入 create_studio_asset envelope，空则省略", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const api: CharacterCanvasPackApi = {
      async executeStudioCommand(_root: string, envelope: Parameters<CharacterCanvasPackApi["executeStudioCommand"]>[1]) {
        const command = envelope.request.command;
        if (command === "create_studio_asset") {
          payloads.push(envelope.request.payload as Record<string, unknown>);
          return { status: "succeeded", result: { id: "char-ahang", revision: 1 } };
        }
        if (command === "import_studio_media") return { status: "succeeded", result: { sha256: IMAGE_SHA, kind: "image" } };
        if (command === "append_studio_asset_version") return { status: "succeeded", result: { version: { id: "version-1" }, assetRevision: 2 } };
        if (command === "review_studio_asset_version") return { status: "succeeded", result: { revision: 3 } };
        if (command === "set_studio_primary_authority") return { status: "succeeded", result: { id: "char-ahang" } };
        return { status: "failed", error: { message: command } };
      },
      async upsertVoiceIdentity() {
        return voice({});
      },
    };
    await ingestCharacterCanvasPack(api, "/tmp/project", {
      name: "阿航",
      imagePath: "/tmp/阿航.png",
      aliases: [" 小航 ", "阿航", ""],
    });
    expect(payloads[0]?.aliases).toEqual(["小航", "阿航"]);
    await ingestCharacterCanvasPack(api, "/tmp/project", {
      name: "阿航",
      imagePath: "/tmp/阿航.png",
    });
    expect(payloads[1]?.aliases).toBeUndefined();
  });

  it("入库非空 description 覆盖模板，空则保留画布库入库句", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const api: CharacterCanvasPackApi = {
      async executeStudioCommand(_root: string, envelope: Parameters<CharacterCanvasPackApi["executeStudioCommand"]>[1]) {
        const command = envelope.request.command;
        if (command === "create_studio_asset") {
          payloads.push(envelope.request.payload as Record<string, unknown>);
          return { status: "succeeded", result: { id: "char-ahang", revision: 1 } };
        }
        if (command === "import_studio_media") return { status: "succeeded", result: { sha256: IMAGE_SHA, kind: "image" } };
        if (command === "append_studio_asset_version") return { status: "succeeded", result: { version: { id: "version-1" }, assetRevision: 2 } };
        if (command === "review_studio_asset_version") return { status: "succeeded", result: { revision: 3 } };
        if (command === "set_studio_primary_authority") return { status: "succeeded", result: { id: "char-ahang" } };
        return { status: "failed", error: { message: command } };
      },
      async upsertVoiceIdentity() {
        return voice({});
      },
    };
    await ingestCharacterCanvasPack(api, "/tmp/project", {
      name: "阿航",
      imagePath: "/tmp/阿航.png",
      description: "  少年领航  ",
    });
    expect(payloads[0]?.description).toBe("少年领航");
    await ingestCharacterCanvasPack(api, "/tmp/project", {
      name: "阿航",
      imagePath: "/tmp/阿航.png",
    });
    expect(payloads[1]?.description).toBe("画布角色库入库");
    await ingestCharacterCanvasPack(api, "/tmp/project", {
      name: "山洞内景",
      imagePath: "/tmp/cave.png",
      category: "scene",
      description: "   ",
    });
    expect(payloads[2]?.description).toBe("画布场景库入库");
  });

  it("按角色资产 ID 收集已绑定的 CAS 音频", () => {
    const voices = [
      voice({ characterAssetIds: ["char-ahang"], sampleMediaSha256s: [AUDIO_SHA] }),
      voice({ id: "voice-2", characterAssetIds: ["char-other"], sampleMediaSha256s: ["c".repeat(64)] }),
    ];
    expect(audioSha256sForCharacterAsset(voices, "char-ahang")).toEqual([AUDIO_SHA]);
    expect(audioSha256sForCharacterAsset(voices, "missing")).toEqual([]);
  });

  it("创建角色、锁定参考图并绑定音频 SHA", async () => {
    const commands: string[] = [];
    const api: CharacterCanvasPackApi = {
      async executeStudioCommand(_root: string, envelope: Parameters<CharacterCanvasPackApi["executeStudioCommand"]>[1]) {
        commands.push(envelope.request.command);
        const command = envelope.request.command;
        if (command === "create_studio_asset") {
          return { status: "succeeded", result: { id: "char-ahang", revision: 1 } };
        }
        if (command === "import_studio_media") {
          const sourcePath = (envelope.request.payload as { sourcePath: string }).sourcePath;
          if (sourcePath.endsWith(".png")) {
            return { status: "succeeded", result: { sha256: IMAGE_SHA, kind: "image" } };
          }
          return { status: "succeeded", result: { sha256: AUDIO_SHA, kind: "audio" } };
        }
        if (command === "append_studio_asset_version") {
          return { status: "succeeded", result: { version: { id: "version-1" }, assetRevision: 2 } };
        }
        if (command === "review_studio_asset_version") {
          return { status: "succeeded", result: { revision: 3 } };
        }
        if (command === "set_studio_primary_authority") {
          return { status: "succeeded", result: { id: "char-ahang", revision: 4 } };
        }
        return { status: "failed", error: { message: `unexpected ${command}` } };
      },
      async upsertVoiceIdentity(_root, input) {
        expect(input.characterAssetIds).toEqual(["char-ahang"]);
        expect(input.sampleMediaSha256s).toEqual([AUDIO_SHA]);
        return voice({
          characterAssetIds: input.characterAssetIds,
          sampleMediaSha256s: input.sampleMediaSha256s,
        });
      },
    };

    const result = await ingestCharacterCanvasPack(api, "/tmp/project", {
      name: "阿航",
      imagePath: "/tmp/阿航.png",
      audioPath: "/tmp/阿航.wav",
    });
    expect(result).toEqual({ assetId: "char-ahang", imageSha256: IMAGE_SHA, audioSha256: AUDIO_SHA });
    expect(commands).toEqual([
      "create_studio_asset",
      "import_studio_media",
      "append_studio_asset_version",
      "review_studio_asset_version",
      "set_studio_primary_authority",
      "import_studio_media",
    ]);
  });

  it("没有音频时仍锁定参考图，不写音色", async () => {
    let upserted = false;
    const api: CharacterCanvasPackApi = {
      async executeStudioCommand(_root: string, envelope: Parameters<CharacterCanvasPackApi["executeStudioCommand"]>[1]) {
        const command = envelope.request.command;
        if (command === "create_studio_asset") return { status: "succeeded", result: { id: "char-ahang", revision: 1 } };
        if (command === "import_studio_media") return { status: "succeeded", result: { sha256: IMAGE_SHA, kind: "image" } };
        if (command === "append_studio_asset_version") return { status: "succeeded", result: { version: { id: "version-1" }, assetRevision: 2 } };
        if (command === "review_studio_asset_version") return { status: "succeeded", result: { revision: 3 } };
        if (command === "set_studio_primary_authority") return { status: "succeeded", result: { id: "char-ahang" } };
        return { status: "failed", error: { message: command } };
      },
      async upsertVoiceIdentity() {
        upserted = true;
        return voice({});
      },
    };
    const result = await ingestCharacterCanvasPack(api, "/tmp/project", {
      name: "阿航",
      imagePath: "/tmp/阿航.jpg",
    });
    expect(result.audioSha256).toBeUndefined();
    expect(upserted).toBe(false);
  });

  it("场景入库只锁定参考图，拒绝音频、不写音色", async () => {
    let upserted = false;
    const categories: string[] = [];
    const api: CharacterCanvasPackApi = {
      async executeStudioCommand(_root: string, envelope: Parameters<CharacterCanvasPackApi["executeStudioCommand"]>[1]) {
        const command = envelope.request.command;
        if (command === "create_studio_asset") {
          categories.push((envelope.request.payload as { category: string }).category);
          return { status: "succeeded", result: { id: "scene-cave", revision: 1 } };
        }
        if (command === "import_studio_media") return { status: "succeeded", result: { sha256: IMAGE_SHA, kind: "image" } };
        if (command === "append_studio_asset_version") return { status: "succeeded", result: { version: { id: "version-1" }, assetRevision: 2 } };
        if (command === "review_studio_asset_version") return { status: "succeeded", result: { revision: 3 } };
        if (command === "set_studio_primary_authority") return { status: "succeeded", result: { id: "scene-cave" } };
        return { status: "failed", error: { message: command } };
      },
      async upsertVoiceIdentity() {
        upserted = true;
        return voice({});
      },
    };
    const result = await ingestCharacterCanvasPack(api, "/tmp/project", {
      name: "山洞内景",
      imagePath: "/tmp/cave.png",
      category: "scene",
    });
    expect(result).toEqual({ assetId: "scene-cave", imageSha256: IMAGE_SHA });
    expect(categories).toEqual(["scene"]);
    expect(upserted).toBe(false);
    await expect(ingestCharacterCanvasPack(api, "/tmp/project", {
      name: "山洞内景",
      imagePath: "/tmp/cave.png",
      audioPath: "/tmp/amb.wav",
      category: "scene",
    })).rejects.toThrow("不绑定角色声线");
  });

  it("角色可追加侧/背视图，不改当前硬锁正面", async () => {
    const notes: string[] = [];
    let authorityCount = 0;
    const api: CharacterCanvasPackApi = {
      async executeStudioCommand(_root: string, envelope: Parameters<CharacterCanvasPackApi["executeStudioCommand"]>[1]) {
        const command = envelope.request.command;
        const payload = envelope.request.payload as { sourceNote?: string };
        if (command === "create_studio_asset") return { status: "succeeded", result: { id: "char-ahang", revision: 1 } };
        if (command === "import_studio_media") {
          const sourcePath = (envelope.request.payload as { sourcePath: string }).sourcePath;
          return { status: "succeeded", result: { sha256: sourcePath.includes("side") ? "c".repeat(64) : sourcePath.includes("back") ? "d".repeat(64) : IMAGE_SHA, kind: "image" } };
        }
        if (command === "append_studio_asset_version") {
          notes.push(payload.sourceNote ?? "");
          return { status: "succeeded", result: { version: { id: `version-${notes.length}` }, assetRevision: notes.length + 1 } };
        }
        if (command === "review_studio_asset_version") return { status: "succeeded", result: { revision: 8 } };
        if (command === "set_studio_primary_authority") {
          authorityCount += 1;
          return { status: "succeeded", result: { id: "char-ahang", revision: 4 } };
        }
        return { status: "failed", error: { message: command } };
      },
      async upsertVoiceIdentity() {
        return voice({});
      },
    };
    const result = await ingestCharacterCanvasPack(api, "/tmp/project", {
      name: "阿航",
      imagePath: "/tmp/front.png",
      sideImagePath: "/tmp/side.png",
      backImagePath: "/tmp/back.png",
    });
    expect(authorityCount).toBe(1);
    expect(notes).toEqual(["画布角色库上传参考图", "view:side", "view:back"]);
    expect(result.viewSha256s).toEqual({ side: "c".repeat(64), back: "d".repeat(64) });
  });
});
