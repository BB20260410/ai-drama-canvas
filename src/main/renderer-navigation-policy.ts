import path from "node:path";
import { fileURLToPath } from "node:url";

export interface RendererNavigationPolicyInput {
  /** 仅开发态传入；必须是应用实际 loadURL 使用的地址。 */
  devRendererUrl?: string;
  /** 安装/构建态唯一允许的 renderer index 文件。 */
  packagedEntryPath: string;
}

/**
 * 主窗口持有高权限 preload，因此导航白名单必须绑定“本次实际加载的 renderer”，
 * 不能泛化为任意 localhost 端口或 bundle 目录内任意 HTML。
 */
export function isRendererNavigationAllowed(url: string, input: RendererNavigationPolicyInput): boolean {
  let candidate: URL;
  try {
    candidate = new URL(url);
  } catch {
    return false;
  }
  if (input.devRendererUrl) {
    try {
      const dev = new URL(input.devRendererUrl);
      return (dev.protocol === "http:" || dev.protocol === "https:")
        && candidate.origin === dev.origin;
    } catch {
      return false;
    }
  }
  if (candidate.protocol !== "file:") return false;
  try {
    return path.resolve(fileURLToPath(candidate)) === path.resolve(input.packagedEntryPath);
  } catch {
    return false;
  }
}
