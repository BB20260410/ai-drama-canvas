import { createHash } from "node:crypto";
import {
  readConfinedJsonSidecar,
  writeConfinedJsonSidecarNoReplace,
} from "./confined-json-sidecar.js";
import { inspectManagedProjectReadOnly } from "./managed-project.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const MAX_PANELS = 6;
const MAX_REFERENCES_PER_PANEL = 100;
const MAX_REFERENCE_PATH_CHARACTERS = 4_096;
const MAX_SOUND_AND_TEXT_CHARACTERS = 40_000;
// 预览任务 JSON 自身允许 16 MiB；来源合同还会补充每条已导入媒体的 SHA、
// 格级声音文本和结构化缩进，因此合同上限必须覆盖所有“预览层合法”的输入。
// 真正写入前仍会按最终 UTF-8 序列化字节精确预检，避免先写 Unit 后失败。
const MAX_CONTRACT_BYTES = 24 * 1024 * 1024;
const CONTRACT_DIRECTORY = "local-creative-unit-source-contracts";

export interface LocalCreativeDeclaredReferenceRequirement {
  declaredPath: string;
  /** 只来自已经导入的 origin/CAS 记录；绝不直接打开任务 JSON 声明的任意路径。 */
  importedMediaSha256: string | null;
}

export interface LocalCreativeUnitSourcePanelContract {
  panelId: string;
  soundAndText: string;
  declaredReferences: LocalCreativeDeclaredReferenceRequirement[];
}

export interface LocalCreativeUnitSourceContract {
  schemaVersion: 1;
  kind: "local-creative-unit-source-contract";
  unitId: string;
  unitRevision: number;
  candidateId: string;
  candidateFingerprint: string;
  sourceFingerprint: string;
  panels: LocalCreativeUnitSourcePanelContract[];
  fingerprint: string;
  createdAt: string;
}

type LocalCreativeUnitSourceContractInput = Omit<
  LocalCreativeUnitSourceContract,
  "schemaVersion" | "kind" | "fingerprint" | "createdAt"
>;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stable(entry)]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex");
}

function requiredId(value: string, label: string): string {
  const normalized = value.trim();
  if (!ID_PATTERN.test(normalized)) throw new Error(`${label} 无效。`);
  return normalized;
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, "en"));
  const normalizedExpected = [...expected].sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(actual) !== JSON.stringify(normalizedExpected)) {
    throw new Error(`${label} 字段集合无效。`);
  }
}

export function normalizeLocalCreativeUnitSourcePanels(
  panels: LocalCreativeUnitSourcePanelContract[],
): LocalCreativeUnitSourcePanelContract[] {
  if (!Array.isArray(panels) || panels.length < 2 || panels.length > MAX_PANELS) {
    throw new Error(`来源合同 panels 必须为 2-${MAX_PANELS} 格。`);
  }
  const seenPanelIds = new Set<string>();
  return panels.map((panel) => {
    const panelId = requiredId(panel.panelId, "panelId");
    if (seenPanelIds.has(panelId)) throw new Error(`来源合同 panelId 重复：${panelId}`);
    seenPanelIds.add(panelId);
    const soundAndText = panel.soundAndText.trim();
    if (soundAndText.length > MAX_SOUND_AND_TEXT_CHARACTERS) {
      throw new Error(`来源合同 ${panelId} 的 soundAndText 超过上限。`);
    }
    if (!Array.isArray(panel.declaredReferences)
      || panel.declaredReferences.length > MAX_REFERENCES_PER_PANEL) {
      throw new Error(`来源合同 ${panelId} 的 declaredReferences 超过上限。`);
    }
    const seenPaths = new Set<string>();
    const declaredReferences = panel.declaredReferences
      .map((reference) => {
        const declaredPath = reference.declaredPath.trim();
        if (!declaredPath) throw new Error("declaredPath 不能为空。");
        if (declaredPath.length > MAX_REFERENCE_PATH_CHARACTERS) {
          throw new Error("declaredPath 超过长度上限。");
        }
        if (seenPaths.has(declaredPath)) throw new Error(`declaredPath 重复：${declaredPath}`);
        seenPaths.add(declaredPath);
        if (reference.importedMediaSha256 !== null
          && !SHA256_PATTERN.test(reference.importedMediaSha256)) {
          throw new Error("importedMediaSha256 必须为 null 或有效 SHA-256。");
        }
        return {
          declaredPath,
          importedMediaSha256: reference.importedMediaSha256,
        };
      })
      .sort((left, right) => left.declaredPath.localeCompare(right.declaredPath, "en")
        || (left.importedMediaSha256 ?? "").localeCompare(right.importedMediaSha256 ?? "", "en"));
    return { panelId, soundAndText, declaredReferences };
  });
}

export function prepareLocalCreativeUnitSourceContract(
  input: LocalCreativeUnitSourceContractInput,
): LocalCreativeUnitSourceContract {
  if (!Number.isSafeInteger(input.unitRevision) || input.unitRevision < 1) {
    throw new Error("unitRevision 必须为正整数。");
  }
  const panels = normalizeLocalCreativeUnitSourcePanels(input.panels);
  const body = {
    schemaVersion: 1 as const,
    kind: "local-creative-unit-source-contract" as const,
    unitId: requiredId(input.unitId, "unitId"),
    unitRevision: input.unitRevision,
    candidateId: requiredId(input.candidateId, "candidateId"),
    candidateFingerprint: input.candidateFingerprint,
    sourceFingerprint: input.sourceFingerprint,
    panels,
  };
  if (!SHA256_PATTERN.test(body.candidateFingerprint) || !SHA256_PATTERN.test(body.sourceFingerprint)) {
    throw new Error("来源合同 fingerprint 无效。");
  }
  const contract: LocalCreativeUnitSourceContract = {
    ...body,
    fingerprint: digest(body),
    createdAt: new Date().toISOString(),
  };
  const serializedBytes = Buffer.byteLength(`${JSON.stringify(contract, null, 2)}\n`, "utf8");
  if (serializedBytes > MAX_CONTRACT_BYTES) {
    throw new Error(`来源合同序列化后超过 ${MAX_CONTRACT_BYTES} 字节上限。`);
  }
  return contract;
}

function contractFileName(unitId: string, unitRevision: number): string {
  return `${requiredId(unitId, "unitId")}-r${unitRevision}.json`;
}

function assertContract(value: unknown): LocalCreativeUnitSourceContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("本机来源单元合同损坏。");
  const contract = value as LocalCreativeUnitSourceContract;
  exactKeys(contract as unknown as Record<string, unknown>, [
    "schemaVersion",
    "kind",
    "unitId",
    "unitRevision",
    "candidateId",
    "candidateFingerprint",
    "sourceFingerprint",
    "panels",
    "fingerprint",
    "createdAt",
  ], "本机来源单元合同");
  if (contract.schemaVersion !== 1
    || contract.kind !== "local-creative-unit-source-contract"
    || !ID_PATTERN.test(contract.unitId)
    || !ID_PATTERN.test(contract.candidateId)
    || !Number.isSafeInteger(contract.unitRevision)
    || contract.unitRevision < 1
    || !SHA256_PATTERN.test(contract.candidateFingerprint)
    || !SHA256_PATTERN.test(contract.sourceFingerprint)
    || !Array.isArray(contract.panels)
    || !SHA256_PATTERN.test(contract.fingerprint)
    || typeof contract.createdAt !== "string"
    || !Number.isFinite(Date.parse(contract.createdAt))
    || new Date(contract.createdAt).toISOString() !== contract.createdAt) {
    throw new Error("本机来源单元合同结构无效。");
  }
  for (const panel of contract.panels) {
    if (!panel || typeof panel !== "object" || Array.isArray(panel)) throw new Error("来源合同 panel 结构无效。");
    exactKeys(panel as unknown as Record<string, unknown>, [
      "panelId",
      "soundAndText",
      "declaredReferences",
    ], "来源合同 panel");
    if (!Array.isArray(panel.declaredReferences)) throw new Error("来源合同 declaredReferences 结构无效。");
    for (const reference of panel.declaredReferences) {
      if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
        throw new Error("来源合同 reference 结构无效。");
      }
      exactKeys(reference as unknown as Record<string, unknown>, [
        "declaredPath",
        "importedMediaSha256",
      ], "来源合同 reference");
    }
  }
  const normalizedPanels = normalizeLocalCreativeUnitSourcePanels(contract.panels);
  if (JSON.stringify(normalizedPanels) !== JSON.stringify(contract.panels)) {
    throw new Error("本机来源单元合同 panels 未按规范存储。");
  }
  const { fingerprint: _fingerprint, createdAt: _createdAt, ...body } = contract;
  if (digest(body) !== contract.fingerprint) throw new Error("本机来源单元合同指纹无效。");
  return contract;
}

export async function writeLocalCreativeUnitSourceContract(
  projectRoot: string,
  input: LocalCreativeUnitSourceContractInput,
): Promise<LocalCreativeUnitSourceContract> {
  const shell = await inspectManagedProjectReadOnly(projectRoot);
  const contract = prepareLocalCreativeUnitSourceContract(input);
  const fileName = contractFileName(contract.unitId, contract.unitRevision);
  const existing = await readConfinedJsonSidecar<unknown>(
    shell.paths.root,
    CONTRACT_DIRECTORY,
    fileName,
    null,
    MAX_CONTRACT_BYTES,
  );
  if (existing !== null) {
    const parsed = assertContract(existing);
    if (parsed.fingerprint !== contract.fingerprint) throw new Error("同一单元修订已有不同来源合同。");
    return parsed;
  }
  await writeConfinedJsonSidecarNoReplace(
    shell.paths.root,
    CONTRACT_DIRECTORY,
    fileName,
    contract,
    MAX_CONTRACT_BYTES,
  );
  const persisted = await readConfinedJsonSidecar<unknown>(
    shell.paths.root,
    CONTRACT_DIRECTORY,
    fileName,
    null,
    MAX_CONTRACT_BYTES,
  );
  const parsed = assertContract(persisted);
  if (parsed.fingerprint !== contract.fingerprint) throw new Error("同一单元修订已有不同来源合同。");
  return parsed;
}

export async function readLocalCreativeUnitSourceContract(
  projectRoot: string,
  unitId: string,
  unitRevision: number,
): Promise<LocalCreativeUnitSourceContract | null> {
  const shell = await inspectManagedProjectReadOnly(projectRoot);
  const value = await readConfinedJsonSidecar<unknown>(
    shell.paths.root,
    CONTRACT_DIRECTORY,
    contractFileName(unitId, unitRevision),
    null,
    MAX_CONTRACT_BYTES,
  );
  if (value === null) return null;
  const contract = assertContract(value);
  if (contract.unitId !== requiredId(unitId, "unitId") || contract.unitRevision !== unitRevision) {
    throw new Error("本机来源单元合同与请求的单元修订身份不一致。");
  }
  return contract;
}
