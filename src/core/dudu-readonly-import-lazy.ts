/**
 * Wave 4-C：Dudu 只读导入冷域。启动路径不得静态拉 dudu-readonly-import.js。
 * 写路径仍走 command-bus / studio-command-executor 原命令；此处只延迟加载同一模块。
 */
export type DuduReadonlyImportModule = typeof import("./dudu-readonly-import.js");

let duduReadonlyImportModule: Promise<DuduReadonlyImportModule> | undefined;

export function loadDuduReadonlyImport(): Promise<DuduReadonlyImportModule> {
  duduReadonlyImportModule ??= import("./dudu-readonly-import.js");
  return duduReadonlyImportModule;
}

export async function withDuduReadonlyImport<T>(
  read: (dudu: DuduReadonlyImportModule) => T | Promise<T>,
): Promise<T> {
  return read(await loadDuduReadonlyImport());
}
