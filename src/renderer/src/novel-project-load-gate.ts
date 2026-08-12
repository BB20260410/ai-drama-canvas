export interface NovelProjectLoadToken {
  root: string;
  generation: number;
}

export interface NovelProjectLoadGate {
  begin: (root: string) => NovelProjectLoadToken;
  capture: (root: string) => NovelProjectLoadToken;
  invalidate: () => void;
  isCurrent: (token: NovelProjectLoadToken, currentRoot: string) => boolean;
}

/**
 * 把 renderer 异步结果绑定到“项目根 + 代次”。旧项目即使晚返回，
 * 也只能得到 false，不能覆盖当前项目状态。
 */
export function createNovelProjectLoadGate(): NovelProjectLoadGate {
  let generation = 0;
  return {
    begin(root) {
      generation += 1;
      return { root, generation };
    },
    capture(root) {
      return { root, generation };
    },
    invalidate() {
      generation += 1;
    },
    isCurrent(token, currentRoot) {
      return token.generation === generation && token.root === currentRoot;
    },
  };
}
