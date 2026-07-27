export interface ProjectScopedActionToken {
  epoch: number;
  projectRoot: string;
  unitId: string;
}

export interface ProjectScopedActionGate {
  begin(projectRoot: string, unitId: string): ProjectScopedActionToken;
  isCurrent(token: ProjectScopedActionToken, projectRoot: string, unitId: string | undefined): boolean;
  invalidate(): void;
  dispose(): void;
}

export function createProjectScopedActionGate(): ProjectScopedActionGate {
  let epoch = 0;
  let disposed = false;
  return {
    begin(projectRoot, unitId) {
      if (disposed) throw new Error("工程作用域操作门已关闭。");
      return {
        epoch: ++epoch,
        projectRoot,
        unitId,
      };
    },
    isCurrent(token, projectRoot, unitId) {
      return !disposed
        && token.epoch === epoch
        && token.projectRoot === projectRoot
        && token.unitId === unitId;
    },
    invalidate() {
      epoch += 1;
    },
    dispose() {
      disposed = true;
      epoch += 1;
    },
  };
}
