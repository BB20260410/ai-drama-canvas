export interface LegacyProjectEpochToken {
  root: string;
  epoch: number;
}

export interface LegacyWatcherIdentityLike {
  projectRoot: string;
  watcherEpoch: number;
}

export interface LegacyProjectEpochGate {
  capture(root: string): LegacyProjectEpochToken;
  invalidate(): number;
  isCurrent(token: LegacyProjectEpochToken, currentRoot: string): boolean;
  isEpochCurrent(epoch: number): boolean;
}

/**
 * 监听事件必须同时命中当前 root 与当前 watcher incarnation。
 *
 * 只比较 root 无法拦住 A→B→A 后从第一代 A 迟到的事件；watcherEpoch 用来
 * 永久区分同一路径的不同监听实例。
 */
export function isCurrentLegacyWatcherEvent(
  expected: LegacyWatcherIdentityLike | null,
  event: LegacyWatcherIdentityLike,
  currentRoot: string,
): boolean {
  return Boolean(expected
    && expected.projectRoot === currentRoot
    && event.projectRoot === expected.projectRoot
    && event.watcherEpoch === expected.watcherEpoch);
}

/**
 * 旧文件系统画布的异步提交门。
 *
 * root 防止 A→B 的迟到回包，epoch 防止 A→B→A 的 ABA 回包。调用方仍需冻结
 * 每次 IPC 的 root；本门只决定回包是否还能提交到当前渲染状态。
 */
export function createLegacyProjectEpochGate(): LegacyProjectEpochGate {
  let epoch = 0;
  return {
    capture(root) {
      return { root, epoch };
    },
    invalidate() {
      epoch += 1;
      return epoch;
    },
    isCurrent(token, currentRoot) {
      return token.epoch === epoch && token.root === currentRoot;
    },
    isEpochCurrent(candidate) {
      return candidate === epoch;
    },
  };
}
