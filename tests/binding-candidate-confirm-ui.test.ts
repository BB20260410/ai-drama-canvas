import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("Binding 工作台候选确认（Jellyfish）", () => {
  it("确认/忽略候选动作与 Core resolve 路径绑定", () => {
    const vue = source("src/renderer/src/components/StudioBindingWorkbench.vue");
    expect(parse(vue, { filename: "StudioBindingWorkbench.vue" }).errors).toEqual([]);
    expect(vue).toContain("data-candidate-action=\"confirm\"");
    expect(vue).toContain("data-candidate-action=\"ignore\"");
    expect(vue).toContain("确认候选");
    expect(vue).toContain("忽略候选");
    expect(vue).toContain("resolveProposal");
    expect(vue).toContain("planStudioBindingCandidateConfirm");
    expect(vue).toContain("planStudioBindingCandidateIgnore");
    expect(vue).toContain("'exclude'");
    expect(vue).toContain("'select'");
    expect(vue).toContain("'accept'");
  });
});

