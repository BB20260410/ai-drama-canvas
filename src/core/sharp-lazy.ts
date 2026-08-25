/**
 * Wave 4-F：媒体网关。启动路径不得静态 `import "sharp"`。
 * 首次 touch 再动态加载；不改变 CAS recipe / 缩略指纹 / 解码参数。
 */
export type SharpModule = typeof import("sharp");
export type SharpFn = SharpModule["default"];

let sharpModule: Promise<SharpModule> | undefined;

export function loadSharp(): Promise<SharpModule> {
  sharpModule ??= import("sharp");
  return sharpModule;
}

export async function loadSharpDefault(): Promise<SharpFn> {
  const loaded = await loadSharp();
  return (loaded.default ?? loaded) as SharpFn;
}

export async function withSharp<T>(read: (sharp: SharpFn) => T | Promise<T>): Promise<T> {
  return read(await loadSharpDefault());
}
