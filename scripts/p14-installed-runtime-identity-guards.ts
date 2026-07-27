import path from "node:path";
import {
  RELEASE_MANIFEST_FILE_NAME,
  readReleaseManifest,
  type ReleaseManifest,
} from "../src/core/release-manifest.js";

export interface InstalledApplicationReleaseIdentity {
  source: "installed-app-resources-release-manifest";
  executablePath: string;
  manifestPath: string;
  version: string;
  sourceDigest: string;
  buildId: string;
  fingerprint: string;
  releaseManifestFingerprint: string;
}

/**
 * 只接受被启动 .app 自身签名边界内的 Resources/release-manifest.json。
 * 不允许调用方另传工作区 manifest，从路径层阻断“启动旧 App、记录新源码身份”。
 */
export function installedApplicationReleaseManifestPath(executablePathValue: string): string {
  if (!executablePathValue.trim() || !path.isAbsolute(executablePathValue)) {
    throw new Error(`安装版可执行文件必须是绝对路径：${executablePathValue}`);
  }
  const executablePath = path.normalize(executablePathValue);
  const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
  const markerIndex = executablePath.lastIndexOf(marker);
  if (markerIndex <= 0 || markerIndex + marker.length >= executablePath.length
    || !executablePath.slice(0, markerIndex).endsWith(".app")
    || executablePath.slice(markerIndex + marker.length).includes(path.sep)) {
    throw new Error(`只接受 .app/Contents/MacOS 内的安装版可执行文件：${executablePath}`);
  }
  const appRoot = executablePath.slice(0, markerIndex);
  return path.join(appRoot, "Contents", "Resources", RELEASE_MANIFEST_FILE_NAME);
}

export async function readInstalledApplicationReleaseIdentity(
  executablePathValue: string,
): Promise<InstalledApplicationReleaseIdentity> {
  const executablePath = path.normalize(executablePathValue);
  const manifestPath = installedApplicationReleaseManifestPath(executablePath);
  const manifest: ReleaseManifest = await readReleaseManifest(manifestPath);
  return {
    source: "installed-app-resources-release-manifest",
    executablePath,
    manifestPath,
    version: manifest.version,
    sourceDigest: manifest.sourceDigest,
    buildId: manifest.buildId,
    fingerprint: manifest.buildIdentityFingerprint,
    releaseManifestFingerprint: manifest.fingerprint,
  };
}

