import type { VoiceIdentity } from "@core/types";
import { createStudioCommandEnvelope } from "./studio-command-envelope";

export function audioSha256sForCharacterAsset(voices: VoiceIdentity[], assetId: string): string[] {
  const id = assetId.trim();
  if (!id) return [];
  return [...new Set(
    voices
      .filter((voice) => (voice.characterAssetIds ?? []).includes(id))
      .flatMap((voice) => voice.sampleMediaSha256s ?? []),
  )];
}

export const CHARACTER_IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".tif", ".tiff", ".avif",
]);
export const CHARACTER_AUDIO_EXTENSIONS = new Set([
  ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg",
]);

export interface CharacterCanvasPackCommandResult {
  status: "succeeded" | "failed" | "cancelled" | "running" | "unknown";
  error?: { message?: string };
  result?: unknown;
}

export interface CharacterCanvasPackApi {
  executeStudioCommand(
    projectRoot: string,
    envelope: Awaited<ReturnType<typeof createStudioCommandEnvelope>>,
  ): Promise<CharacterCanvasPackCommandResult>;
  upsertVoiceIdentity(
    projectRoot: string,
    input: {
      name: string;
      description?: string;
      characterAssetIds: string[];
      sampleMediaSha256s: string[];
    },
  ): Promise<VoiceIdentity>;
}

export type CanvasPackCategory = "character" | "scene" | "prop";

export type CharacterViewSlot = "side" | "back";

export interface IngestCharacterCanvasPackInput {
  name: string;
  imagePath: string;
  audioPath?: string;
  category?: CanvasPackCategory;
  sideImagePath?: string;
  backImagePath?: string;
  aliases?: string[];
  description?: string;
}

export function splitCanvasAssetAliases(raw: string | undefined): string[] {
  return [...new Set((raw ?? "").split(/[,，\n]/u).map((alias) => alias.trim()).filter(Boolean))].slice(0, 100);
}

export interface IngestCharacterCanvasPackResult {
  assetId: string;
  imageSha256: string;
  audioSha256?: string;
  viewSha256s?: Partial<Record<CharacterViewSlot, string>>;
}

function extensionOf(filePath: string): string {
  const base = filePath.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot).toLowerCase() : "";
}

export function isCharacterImagePath(filePath: string): boolean {
  return CHARACTER_IMAGE_EXTENSIONS.has(extensionOf(filePath));
}

export function isCharacterAudioPath(filePath: string): boolean {
  return CHARACTER_AUDIO_EXTENSIONS.has(extensionOf(filePath));
}

function requiredResult<T>(outcome: CharacterCanvasPackCommandResult, label: string): T {
  if (outcome.status !== "succeeded" || outcome.result === undefined) {
    throw new Error(outcome.error?.message || `${label}失败。`);
  }
  return outcome.result as T;
}

const PACK_LABEL: Record<CanvasPackCategory, string> = {
  character: "角色",
  scene: "场景",
  prop: "道具",
};

export async function ingestCharacterCanvasPack(
  api: CharacterCanvasPackApi,
  projectRoot: string,
  input: IngestCharacterCanvasPackInput,
): Promise<IngestCharacterCanvasPackResult> {
  const category: CanvasPackCategory = input.category ?? "character";
  const label = PACK_LABEL[category];
  const name = input.name.trim();
  if (!name) throw new Error(`${label}名称不能为空。`);
  if (!isCharacterImagePath(input.imagePath)) {
    throw new Error(`${label}参考图只接受 png/jpg/webp/gif 等图片。`);
  }
  if ((input.sideImagePath || input.backImagePath) && category !== "character") {
    throw new Error(`${label}库不登记多视图槽。`);
  }
  if (input.audioPath && category !== "character") {
    throw new Error(`${label}库不绑定角色声线，请只上传参考图。`);
  }
  if (input.audioPath && !isCharacterAudioPath(input.audioPath)) {
    throw new Error("角色音频只接受 mp3/wav/m4a/aac/flac/ogg。");
  }

  const aliases = [...new Set((input.aliases ?? []).map((alias) => alias.trim()).filter(Boolean))].slice(0, 100);
  const description = (input.description ?? "").trim().slice(0, 20_000) || `画布${label}库入库`;
  const created = requiredResult<{ id?: string; revision?: number }>(
    await api.executeStudioCommand(projectRoot, await createStudioCommandEnvelope({
      command: "create_studio_asset",
      payload: {
        category,
        name,
        description,
        expectedRevision: 0,
        ...(aliases.length ? { aliases } : {}),
      },
    })),
    `创建${label}`,
  );
  const assetId = created.id?.trim();
  if (!assetId) throw new Error(`${label}创建结果缺少 ID。`);
  let expectedRevision = Number(created.revision ?? 1);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) expectedRevision = 1;

  const importedImage = requiredResult<{ sha256?: string; kind?: string }>(
    await api.executeStudioCommand(projectRoot, await createStudioCommandEnvelope({
      command: "import_studio_media",
      payload: { sourcePath: input.imagePath },
    })),
    `导入${label}参考图`,
  );
  const imageSha256 = importedImage.sha256?.trim().toLowerCase() ?? "";
  if (!/^[a-f0-9]{64}$/u.test(imageSha256) || importedImage.kind !== "image") {
    throw new Error("导入的参考图不是可用图片。");
  }

  const version = requiredResult<{ version?: { id?: string }; assetRevision?: number }>(
    await api.executeStudioCommand(projectRoot, await createStudioCommandEnvelope({
      command: "append_studio_asset_version",
      payload: {
        assetId,
        mediaSha256: imageSha256,
        reviewStatus: "pending",
        sourceNote: `画布${label}库上传参考图`,
        expectedRevision,
      },
    })),
    `登记${label}参考图`,
  );
  const versionId = version.version?.id?.trim();
  if (!versionId) throw new Error(`${label}参考图版本缺少 ID。`);
  expectedRevision = Number(version.assetRevision ?? expectedRevision + 1);

  const reviewed = requiredResult<{ revision?: number }>(
    await api.executeStudioCommand(projectRoot, await createStudioCommandEnvelope({
      command: "review_studio_asset_version",
      payload: {
        assetId,
        versionId,
        decision: "approved",
        expectedRevision,
        note: `画布${label}库：用户本地上传的参考图。`,
      },
    })),
    `审核${label}参考图`,
  );
  expectedRevision = Number(reviewed.revision ?? expectedRevision + 1);

  const locked = requiredResult<{ revision?: number }>(
    await api.executeStudioCommand(projectRoot, await createStudioCommandEnvelope({
      command: "set_studio_primary_authority",
      payload: {
        assetId,
        versionId,
        expectedRevision,
        note: `画布${label}库将上传图提升为当前硬锁权威。`,
      },
    })),
    `锁定${label}参考图`,
  );
  expectedRevision = Number(locked.revision ?? expectedRevision + 1);

  const viewSha256s: Partial<Record<CharacterViewSlot, string>> = {};
  for (const [slot, path] of [
    ["side", input.sideImagePath],
    ["back", input.backImagePath],
  ] as const) {
    if (!path) continue;
    if (!isCharacterImagePath(path)) throw new Error(`${slot === "side" ? "侧" : "背"}视图只接受 png/jpg/webp/gif 等图片。`);
    const imported = requiredResult<{ sha256?: string; kind?: string }>(
      await api.executeStudioCommand(projectRoot, await createStudioCommandEnvelope({
        command: "import_studio_media",
        payload: { sourcePath: path },
      })),
      `导入${slot === "side" ? "侧" : "背"}视图`,
    );
    const sha = imported.sha256?.trim().toLowerCase() ?? "";
    if (!/^[a-f0-9]{64}$/u.test(sha) || imported.kind !== "image") {
      throw new Error("导入的多视图不是可用图片。");
    }
    const extra = requiredResult<{ version?: { id?: string }; assetRevision?: number }>(
      await api.executeStudioCommand(projectRoot, await createStudioCommandEnvelope({
        command: "append_studio_asset_version",
        payload: {
          assetId,
          mediaSha256: sha,
          reviewStatus: "pending",
          sourceNote: `view:${slot}`,
          expectedRevision,
        },
      })),
      `登记${slot === "side" ? "侧" : "背"}视图`,
    );
    const extraVersionId = extra.version?.id?.trim();
    if (!extraVersionId) throw new Error("多视图版本缺少 ID。");
    expectedRevision = Number(extra.assetRevision ?? expectedRevision + 1);
    const extraReviewed = requiredResult<{ revision?: number }>(
      await api.executeStudioCommand(projectRoot, await createStudioCommandEnvelope({
        command: "review_studio_asset_version",
        payload: {
          assetId,
          versionId: extraVersionId,
          decision: "approved",
          expectedRevision,
          note: `画布角色库：${slot === "side" ? "侧" : "背"}视图参考，不改当前硬锁正面。`,
        },
      })),
      `审核${slot === "side" ? "侧" : "背"}视图`,
    );
    expectedRevision = Number(extraReviewed.revision ?? expectedRevision + 1);
    viewSha256s[slot] = sha;
  }

  let audioSha256: string | undefined;
  if (input.audioPath) {
    const importedAudio = requiredResult<{ sha256?: string; kind?: string }>(
      await api.executeStudioCommand(projectRoot, await createStudioCommandEnvelope({
        command: "import_studio_media",
        payload: { sourcePath: input.audioPath },
      })),
      "导入角色音频",
    );
    audioSha256 = importedAudio.sha256?.trim().toLowerCase();
    if (!audioSha256 || !/^[a-f0-9]{64}$/u.test(audioSha256) || importedAudio.kind !== "audio") {
      throw new Error("导入的音频不是可用音频文件。");
    }
    await api.upsertVoiceIdentity(projectRoot, {
      name: `${name} 声线`,
      description: "画布角色库绑定的角色音频",
      characterAssetIds: [assetId],
      sampleMediaSha256s: [audioSha256],
    });
  }

  return {
    assetId,
    imageSha256,
    ...(audioSha256 ? { audioSha256 } : {}),
    ...(Object.keys(viewSha256s).length ? { viewSha256s } : {}),
  };
}

