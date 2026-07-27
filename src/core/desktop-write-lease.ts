/**
 * 桌面 UI 主进程：对生图相关写命令自动持有 / 续租 desktop-ui 写租约。
 * 避免 require 模式下 UI 无 token 被拒；多代理时若他方持租约，UI 会硬失败并提示。
 */
import {
  acquireStudioProjectWriteLease,
  STUDIO_WRITE_LEASE_ENFORCED_COMMANDS,
  type StudioProjectWriteLease,
} from "./studio-project-write-lease.js";

const DESKTOP_HOLDER_ID = "desktop-ui-main";
const cache = new Map<string, { leaseToken: string; expiresAt: string }>();

export async function ensureDesktopWriteLeaseForCommand(
  projectRoot: string,
  command: string,
): Promise<{ writeLeaseHolderId?: string; writeLeaseToken?: string }> {
  if (!STUDIO_WRITE_LEASE_ENFORCED_COMMANDS.has(command)) {
    return {};
  }
  if (process.env.AI_CANVAS_DISABLE_WRITE_LEASE === "1") {
    return {};
  }

  const root = projectRoot;
  const cached = cache.get(root);
  let lease: StudioProjectWriteLease;
  try {
    lease = await acquireStudioProjectWriteLease(root, {
      holderId: DESKTOP_HOLDER_ID,
      holderKind: "desktop-ui",
      ttlSeconds: 30 * 60,
      note: "desktop-ui auto lease",
      ...(cached?.leaseToken ? { leaseToken: cached.leaseToken } : {}),
    });
  } catch (error) {
    // 同 holder 已有租约但 token 丢了：强制接管本机桌面（仅同 holder 场景）
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes(`holderId=${DESKTOP_HOLDER_ID}`) || msg.includes(DESKTOP_HOLDER_ID)) {
      lease = await acquireStudioProjectWriteLease(root, {
        holderId: DESKTOP_HOLDER_ID,
        holderKind: "desktop-ui",
        ttlSeconds: 30 * 60,
        forceTakeover: true,
        takeoverReason: "desktop-ui 本机会话 token 丢失，安全接管自有租约",
        note: "desktop-ui takeover self",
      });
    } else {
      throw error;
    }
  }
  cache.set(root, { leaseToken: lease.leaseToken, expiresAt: lease.expiresAt });
  return {
    writeLeaseHolderId: DESKTOP_HOLDER_ID,
    writeLeaseToken: lease.leaseToken,
  };
}
