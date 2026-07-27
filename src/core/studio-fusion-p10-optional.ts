/**
 * P10 可选实验合同（探索默认 quarantine；禁止项不实现）。
 */

export function exploreModePolicy(): { allowFormalLedger: false; forceQuarantine: true } {
  return { allowFormalLedger: false, forceQuarantine: true };
}

export function validateFineControlPanel(input: {
  cameraMove?: string;
  region?: { x: number; y: number; w: number; h: number };
}): void {
  if (input.region) {
    const r = input.region;
    if (!(r.w > 0 && r.h > 0)) throw new Error("fine-control: region 非法。");
  }
}

export function sequenceReorder(ids: string[], from: number, to: number): string[] {
  if (from < 0 || to < 0 || from >= ids.length || to >= ids.length) throw new Error("sequence: 索引非法。");
  const next = [...ids];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}
