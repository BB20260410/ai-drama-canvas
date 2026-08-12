export interface StudioInitialOverviewReleaseGate {
  reset(projectRoot: string): void;
  tryRelease(projectRoot: string): boolean;
  markReleased(projectRoot: string): void;
  isReleased(projectRoot: string): boolean;
}

function normalizeProjectRoot(projectRoot: string): string {
  return projectRoot.trim();
}

/**
 * 素材中心首屏 overview 的一次性释放门。
 *
 * 默认受管画布先让 units 进入真实 DOM；首卡、用户主动切换或画布失败三条路径
 * 都可以尝试释放，但同一工程只允许一次。切工程 reset 后，旧工程的迟到事件失效。
 */
export function createStudioInitialOverviewReleaseGate(): StudioInitialOverviewReleaseGate {
  let currentProjectRoot = "";
  let released = false;

  const matches = (projectRoot: string): boolean => {
    const normalized = normalizeProjectRoot(projectRoot);
    return Boolean(normalized) && normalized === currentProjectRoot;
  };

  return {
    reset(projectRoot) {
      currentProjectRoot = normalizeProjectRoot(projectRoot);
      released = false;
    },
    tryRelease(projectRoot) {
      if (!matches(projectRoot) || released) return false;
      released = true;
      return true;
    },
    markReleased(projectRoot) {
      if (matches(projectRoot)) released = true;
    },
    isReleased(projectRoot) {
      return matches(projectRoot) && released;
    },
  };
}
