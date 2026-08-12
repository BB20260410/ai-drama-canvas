import path from "node:path";

const SHA256 = /^[a-f0-9]{64}$/u;

/** 唯一允许回给 Codex 的本机绝对路径：已经验证的 source-closure CAS 图片。 */
export function projectHiggsfieldPrepareConnectorRequestForMcp(value: unknown, projectRoot: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = structuredClone(value as Record<string, unknown>);
  const request = result.connectorRequest;
  if (!request || typeof request !== "object" || Array.isArray(request)) return result;
  const references = (request as Record<string, unknown>).imageReferences;
  if (!Array.isArray(references)) throw new Error("Higgsfield connectorRequest.imageReferences 无效。");
  const videoClosureRoot = path.resolve(projectRoot, ".aicanvas/studio-video-package-source-closure/objects/sha256");
  const imageMediaRoot = path.resolve(projectRoot, ".aicanvas/objects/sha256");
  for (const reference of references) {
    if (!reference || typeof reference !== "object" || Array.isArray(reference)) throw new Error("Higgsfield 图片参考无效。");
    const item = reference as Record<string, unknown>;
    if (typeof item.sha256 !== "string" || !SHA256.test(item.sha256)
      || typeof item.localPath !== "string" || !path.isAbsolute(item.localPath)) {
      throw new Error("Higgsfield 图片参考缺少受控 SHA/localPath。 ");
    }
    const sha256 = item.sha256 as string;
    const localPath = item.localPath as string;
    const candidate = path.resolve(localPath);
    const expectedRoots = [videoClosureRoot, imageMediaRoot];
    const allowed = expectedRoots.some((root) => candidate === path.join(root, sha256.slice(0, 2), sha256)
      && path.normalize(localPath) === candidate);
    if (!allowed) {
      throw new Error("Higgsfield connectorRequest 禁止返回受控 CAS 以外的 localPath。");
    }
  }
  return result;
}
