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

  it("绑定诊断 summary 含共享 testid，不改空镜说明/确认/冻结钮", () => {
    const vue = source("src/renderer/src/components/StudioBindingWorkbench.vue");
    expect(vue).toContain('class="inspector-section empty-review-section"');
    expect(vue).toContain('class="inspector-section freeze-section"');
    expect(vue.match(/data-testid="studio-binding-diagnostics"/g)?.length).toBe(2);
    expect(vue).toContain('<details v-if="selectedPanel.emptyConfirmation" class="binding-diagnostics"><summary data-testid="studio-binding-diagnostics">诊断详情</summary>');
    expect(vue).toContain('<details v-if="selectedPanel.bindingSet" class="binding-diagnostics"><summary data-testid="studio-binding-diagnostics">诊断详情</summary>');
    expect(vue).toContain("{{ selectedPanel.emptyConfirmation.id }}");
    expect(vue).toContain("{{ selectedPanel.bindingSet.id }}");
    expect(vue).toContain("{{ selectedPanel.bindingSet.fingerprint }}");
    expect(vue).toContain('data-testid="binding-empty-note"');
    expect(vue).toContain('data-testid="binding-confirm-empty"');
    expect(vue).toContain('data-testid="binding-freeze"');
    expect(vue).toContain('data-testid="binding-empty-confirmation-status"');
    expect(vue).toContain('data-testid="binding-set-status"');
    expect(vue).not.toContain("studio-binding-diagnostics-");
    expect(vue).not.toContain('binding-diagnostics" role="dialog"');
    expect(vue).not.toContain("studio-generation-plan-id-diagnostics");
    expect(vue).not.toContain("studio-continuity-empty-diagnostics");
  });
});

