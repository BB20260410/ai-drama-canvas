/**
 * Studio 精确身份匹配器。
 *
 * 构建一次 Aho–Corasick 自动机，随后按文本长度线性扫描；不会为每个 source
 * span 再遍历全部人物/场景/道具别名。该模块只做精确词法匹配，不作模型推断。
 */

export interface StudioLexicalIdentityGroupLike {
  key: string;
  category: string;
  assetIds: readonly string[];
}

export interface StudioNormalizedTextMap {
  text: string;
  starts: number[];
  ends: number[];
}

export interface StudioLexicalIdentityMatch<TGroup extends StudioLexicalIdentityGroupLike> {
  start: number;
  end: number;
  surfaceText: string;
  group: TGroup;
}

export interface StudioLexicalIdentityMatcher<TGroup extends StudioLexicalIdentityGroupLike> {
  readonly groupCount: number;
  readonly nodeCount: number;
  match(value: string, baseOffsetUtf16?: number, maxMatches?: number): StudioLexicalIdentityMatch<TGroup>[];
}

interface AutomatonNode<TGroup> {
  transitions: Map<string, number>;
  failure: number;
  outputs: TGroup[];
}

export function normalizeStudioLexicalTextWithUtf16Map(value: string): StudioNormalizedTextMap {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let previousWasSpace = false;
  for (let offset = 0; offset < value.length;) {
    const point = value.codePointAt(offset)!;
    const original = String.fromCodePoint(point);
    const start = offset;
    const end = offset + original.length;
    offset = end;
    const normalized = original.normalize("NFKC").toLocaleLowerCase("zh-CN");
    for (let index = 0; index < normalized.length; index += 1) {
      const unit = normalized[index]!;
      if (/\s/u.test(unit)) {
        if (text.length === 0) continue;
        if (previousWasSpace) {
          ends[ends.length - 1] = end;
          continue;
        }
        text += " ";
        starts.push(start);
        ends.push(end);
        previousWasSpace = true;
        continue;
      }
      text += unit;
      starts.push(start);
      ends.push(end);
      previousWasSpace = false;
    }
  }
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    starts.pop();
    ends.pop();
  }
  return { text, starts, ends };
}

function asciiWord(value: string | undefined): boolean {
  return Boolean(value && /[a-z0-9_]/iu.test(value));
}

function assertGroups<TGroup extends StudioLexicalIdentityGroupLike>(groups: readonly TGroup[]): TGroup[] {
  const seen = new Set<string>();
  return groups.map((group) => {
    if (!group || typeof group !== "object" || typeof group.key !== "string" || !group.key) {
      throw new Error("Studio identity matcher 的 key 必须是非空规范化字符串。");
    }
    if (group.key !== group.key.normalize("NFKC").toLocaleLowerCase("zh-CN")) {
      throw new Error(`Studio identity matcher 的 key 尚未规范化：${group.key}`);
    }
    const identity = `${group.category}\u0000${group.key}`;
    if (seen.has(identity)) throw new Error(`Studio identity matcher 存在重复 category/key：${identity}`);
    seen.add(identity);
    return group;
  });
}

export function createStudioLexicalIdentityMatcher<TGroup extends StudioLexicalIdentityGroupLike>(
  inputGroups: readonly TGroup[],
): StudioLexicalIdentityMatcher<TGroup> {
  const groups = assertGroups(inputGroups);
  const nodes: Array<AutomatonNode<TGroup>> = [{ transitions: new Map(), failure: 0, outputs: [] }];
  for (const group of groups) {
    let nodeIndex = 0;
    for (let index = 0; index < group.key.length; index += 1) {
      const unit = group.key[index]!;
      const existing = nodes[nodeIndex]!.transitions.get(unit);
      if (existing !== undefined) {
        nodeIndex = existing;
        continue;
      }
      const childIndex = nodes.length;
      nodes.push({ transitions: new Map(), failure: 0, outputs: [] });
      nodes[nodeIndex]!.transitions.set(unit, childIndex);
      nodeIndex = childIndex;
    }
    nodes[nodeIndex]!.outputs.push(group);
  }

  const queue: number[] = [];
  for (const childIndex of nodes[0]!.transitions.values()) {
    nodes[childIndex]!.failure = 0;
    queue.push(childIndex);
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const parentIndex = queue[cursor]!;
    for (const [unit, childIndex] of nodes[parentIndex]!.transitions) {
      queue.push(childIndex);
      let fallbackIndex = nodes[parentIndex]!.failure;
      while (fallbackIndex !== 0 && !nodes[fallbackIndex]!.transitions.has(unit)) {
        fallbackIndex = nodes[fallbackIndex]!.failure;
      }
      const fallbackChild = nodes[fallbackIndex]!.transitions.get(unit);
      nodes[childIndex]!.failure = fallbackChild ?? 0;
      nodes[childIndex]!.outputs.push(...nodes[nodes[childIndex]!.failure]!.outputs);
    }
  }
  for (const node of nodes) {
    node.outputs.sort((left, right) => right.key.length - left.key.length
      || left.category.localeCompare(right.category, "en")
      || left.key.localeCompare(right.key, "zh-CN")
      || [...left.assetIds].join("\u0000").localeCompare([...right.assetIds].join("\u0000"), "en"));
  }

  return {
    groupCount: groups.length,
    nodeCount: nodes.length,
    match(value, baseOffsetUtf16 = 0, maxMatches = 50_000) {
      if (!Number.isSafeInteger(baseOffsetUtf16) || baseOffsetUtf16 < 0) {
        throw new Error("Studio identity matcher 的 baseOffsetUtf16 必须是非负整数。");
      }
      if (!Number.isSafeInteger(maxMatches) || maxMatches < 1 || maxMatches > 1_000_000) {
        throw new Error("Studio identity matcher 的 maxMatches 必须是 1–1000000 的整数。");
      }
      const normalized = normalizeStudioLexicalTextWithUtf16Map(value);
      const matches: StudioLexicalIdentityMatch<TGroup>[] = [];
      let state = 0;
      for (let index = 0; index < normalized.text.length; index += 1) {
        const unit = normalized.text[index]!;
        while (state !== 0 && !nodes[state]!.transitions.has(unit)) state = nodes[state]!.failure;
        state = nodes[state]!.transitions.get(unit) ?? 0;
        for (const group of nodes[state]!.outputs) {
          const normalizedStart = index - group.key.length + 1;
          if (normalizedStart < 0) continue;
          const before = normalizedStart > 0 ? normalized.text[normalizedStart - 1] : undefined;
          const after = index + 1 < normalized.text.length ? normalized.text[index + 1] : undefined;
          if ((asciiWord(group.key[0]) && asciiWord(before))
            || (asciiWord(group.key[group.key.length - 1]) && asciiWord(after))) continue;
          const localStart = normalized.starts[normalizedStart];
          const localEnd = normalized.ends[index];
          if (localStart === undefined || localEnd === undefined) continue;
          matches.push({
            start: baseOffsetUtf16 + localStart,
            end: baseOffsetUtf16 + localEnd,
            surfaceText: value.slice(localStart, localEnd),
            group,
          });
          if (matches.length > maxMatches) {
            throw new Error(`Studio identity matcher 命中超过 ${maxMatches} 项，拒绝截断或静默丢弃。`);
          }
        }
      }
      return matches.sort((left, right) => left.start - right.start
        || right.end - left.end
        || left.group.category.localeCompare(right.group.category, "en")
        || left.group.key.localeCompare(right.group.key, "zh-CN"));
    },
  };
}
