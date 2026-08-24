import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  __succeededPublicReplayHydrationCommandsForTests,
  __succeededPublicReplayHydrationRegistryForTests,
} from "../src/core/command-bus.js";

describe("execute_command succeeded public replay hydration registry", () => {
  it("完整登记全部 25 个 locator 命令，并全部启用严格只读", () => {
    const allCommands = [
      "abandon_studio_detached_generation_unknown",
      "abandon_studio_generation_unknown",
      "analyze_studio_script_entities",
      "append_studio_continuity_correction",
      "append_studio_continuity_observation",
      "attest_studio_generation_checkpoint",
      "build_studio_video_package",
      "cancel_studio_generation_run",
      "commit_agent_imagegen_result_bundle",
      "confirm_studio_panel_empty",
      "create_studio_generation_plan",
      "fail_studio_generation_run",
      "finalize_dudu_readonly_managed_project",
      "freeze_studio_asset_binding_set",
      "materialize_local_creative_production_units",
      "prepare_studio_imagegen_call",
      "prepare_studio_video_package_export",
      "rebind_studio_imagegen_call_context",
      "reconcile_studio_imagegen_call",
      "refresh_studio_generation_checkpoint",
      "resolve_studio_entity_proposal",
      "retry_studio_generation_plan_nodes",
      "stage_dudu_readonly_managed_project",
      "submit_studio_generation_review",
      "submit_studio_post_result_observation",
    ];
    const enabled = [
      "abandon_studio_detached_generation_unknown",
      "abandon_studio_generation_unknown",
      "analyze_studio_script_entities",
      "append_studio_continuity_correction",
      "append_studio_continuity_observation",
      "attest_studio_generation_checkpoint",
      "build_studio_video_package",
      "cancel_studio_generation_run",
      "commit_agent_imagegen_result_bundle",
      "confirm_studio_panel_empty",
      "create_studio_generation_plan",
      "fail_studio_generation_run",
      "finalize_dudu_readonly_managed_project",
      "freeze_studio_asset_binding_set",
      "materialize_local_creative_production_units",
      "prepare_studio_imagegen_call",
      "prepare_studio_video_package_export",
      "rebind_studio_imagegen_call_context",
      "reconcile_studio_imagegen_call",
      "refresh_studio_generation_checkpoint",
      "resolve_studio_entity_proposal",
      "retry_studio_generation_plan_nodes",
      "stage_dudu_readonly_managed_project",
      "submit_studio_generation_review",
      "submit_studio_post_result_observation",
    ];
    const registry = __succeededPublicReplayHydrationRegistryForTests();
    expect(new Set(registry.map((entry) => entry.command)).size).toBe(registry.length);
    expect(registry.map((entry) => entry.command).sort()).toEqual(allCommands);
    expect(registry.filter((entry) => entry.mode === "strict-readonly").map((entry) => entry.command).sort())
      .toEqual(enabled);
    expect([...__succeededPublicReplayHydrationCommandsForTests()].sort()).toEqual(enabled);
    const commandBusSource = readFileSync(new URL("../src/core/command-bus.ts", import.meta.url), "utf8");
    expect(commandBusSource).not.toContain("readStudioGenerationReviewOperationOutcome");
    expect(commandBusSource).not.toContain("readStudioPostResultObservationOutcomeByOperationId");
    expect(commandBusSource).not.toContain("readStudioGenerationCheckpointOperationReceipt");
  });
});
