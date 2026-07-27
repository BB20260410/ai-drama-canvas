import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyEditOperation,
  createEditProject,
  listTimelineFrameExtractions,
  listVideoContinuationPacks,
  prepareTimelineVideoContinuation,
  saveEditProject,
} from "../src/core/editor.js";
import { getProjectIndex, scanAndPersist } from "../src/core/service.js";
import { ensureSidecar, getSidecarPaths, writeJsonAtomic } from "../src/core/sidecar.js";
import type { EditClip, EditProject } from "../src/core/types.js";
import { seedProductionReady } from "./workflow-helpers.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, stableValue(entry)]));
  return value;
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function nestedClip(project: EditProject): EditClip {
  return project.tracks.flatMap((track) => track.clips).find((clip) => clip.kind === "timeline")!;
}

async function fixture(): Promise<{ root: string; sourceVideoPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-editor-nested-continuation-"));
  roots.push(root);
  const config = await ensureSidecar(root);
  config.sourceRoots = [];
  config.outputRoots = [root];
  await writeJsonAtomic(getSidecarPaths(root).config, config);
  let sourceVideoPath = "";
  for (const unit of [1, 2]) {
    const stem = `EP01_15s_${String(unit).padStart(3, "0")}`;
    const directory = path.join(root, `${stem}_嵌套续接${unit}`);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "00_信息.md"), `# ${stem}\n\n嵌套时间线续接跨进程测试。\n`, "utf8");
    const videoPath = path.join(directory, `${stem}_v1.mp4`);
    await execFileAsync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi",
      "-i", `testsrc2=size=320x256:rate=25`,
      "-vf", unit === 1 ? "hue=h=20:s=.8" : "hue=h=130:s=.8",
      "-frames:v", unit === 1 ? "25" : "12",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      videoPath,
    ]);
    if (unit === 1) sourceVideoPath = videoPath;
  }
  await scanAndPersist(root);
  await seedProductionReady(root, "frames");
  return { root, sourceVideoPath };
}

describe("嵌套时间线生产续接", () => {
  it("三层真实媒体跨进程复用冻结血缘，并在快照或计划篡改时先于新包失败", async () => {
    const { root, sourceVideoPath } = await fixture();
    const index = await getProjectIndex(root);
    const sourceArtifact = index.artifacts.find((artifact) => artifact.path === sourceVideoPath)!;
    expect(sourceArtifact).toBeTruthy();
    expect(index.items.some((item) => item.id === "main-ep01-unit002")).toBe(true);

    const leafDraft = await createEditProject(root, { name: "续接 25fps 叶子", width: 320, height: 256, fps: 25, autoPopulate: false });
    const leafVisual = leafDraft.tracks.find((track) => track.kind === "visual")!;
    leafVisual.clips.push({
      id: "clip-continuation-leaf-video",
      trackId: leafVisual.id,
      kind: "video",
      name: "续接叶子真实视频",
      sourcePath: sourceVideoPath,
      artifactId: sourceArtifact.id,
      itemId: sourceArtifact.itemId,
      startFrame: 0,
      durationFrames: 25,
      trimStartFrame: 0,
      startSeconds: 0,
      durationSeconds: 1,
      trimStartSeconds: 0,
      playbackRate: 1,
      volume: 1,
      opacity: 1,
      muted: false,
    });
    const leafSubtitle = leafDraft.tracks.find((track) => track.kind === "subtitle")!;
    leafSubtitle.clips.push({
      id: "clip-continuation-leaf-subtitle",
      trackId: leafSubtitle.id,
      kind: "subtitle",
      name: "续接叶子字幕",
      startFrame: 0,
      durationFrames: 25,
      trimStartFrame: 0,
      startSeconds: 0,
      durationSeconds: 1,
      trimStartSeconds: 0,
      playbackRate: 1,
      volume: 1,
      opacity: 1,
      muted: false,
      text: "嵌套续接血缘",
      fontSize: 28,
      fontColor: "#ffffff",
      subtitleBackground: "#000000",
    });
    const leaf = await saveEditProject(root, leafDraft, leafDraft.revision);

    const middleInitial = await createEditProject(root, { name: "续接 24fps 中层", width: 320, height: 256, fps: 24, autoPopulate: false });
    const middleAttached = await applyEditOperation(root, middleInitial.id, middleInitial.revision, {
      type: "add_nested_timeline",
      trackId: middleInitial.tracks.find((track) => track.kind === "visual")!.id,
      childEditProjectId: leaf.id,
      childExpectedRevision: leaf.revision,
      startFrame: 0,
    });
    const middle = middleAttached.project;

    const rootInitial = await createEditProject(root, { name: "续接 29.97fps 根层", width: 320, height: 256, fps: 29.97, autoPopulate: false });
    const rootAttached = await applyEditOperation(root, rootInitial.id, rootInitial.revision, {
      type: "add_nested_timeline",
      trackId: rootInitial.tracks.find((track) => track.kind === "visual")!.id,
      childEditProjectId: middle.id,
      childExpectedRevision: middle.revision,
      startFrame: 0,
    });
    const rootProject = rootAttached.project;

    const first = await prepareTimelineVideoContinuation(root, {
      editProjectId: rootProject.id,
      targetItemId: "main-ep01-unit002",
      expectedRevision: rootProject.revision,
      enqueue: false,
    });
    expect(first.generationJob).toBeUndefined();
    expect(first.extraction).toMatchObject({
      editProjectId: rootProject.id,
      editProjectRevision: rootProject.revision,
      registeredItemId: "main-ep01-unit002",
      registeredVariant: "start",
      dependencyManifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      renderPlanSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(first.extraction.dependencyRefs?.map((entry) => ({ id: entry.editProjectId, revision: entry.revision, depth: entry.depth }))).toEqual([
      { id: middle.id, revision: middle.revision, depth: 1 },
      { id: leaf.id, revision: leaf.revision, depth: 2 },
    ]);
    expect(first.extraction.sourceClipRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ editProjectId: rootProject.id, editProjectRevision: rootProject.revision, clipId: nestedClip(rootProject).id }),
      expect.objectContaining({ editProjectId: middle.id, editProjectRevision: middle.revision, clipId: nestedClip(middle).id }),
      { editProjectId: leaf.id, editProjectRevision: leaf.revision, clipId: "clip-continuation-leaf-video" },
      { editProjectId: leaf.id, editProjectRevision: leaf.revision, clipId: "clip-continuation-leaf-subtitle" },
    ]));
    expect(first.extraction.sourceArtifactIds).toContain(sourceArtifact.id);
    expect(first.extraction.sourceItemIds).toContain(sourceArtifact.itemId);
    expect(first.pack).toMatchObject({
      sourceType: "timeline",
      editProjectId: rootProject.id,
      editProjectRevision: rootProject.revision,
      dependencyManifestSha256: first.extraction.dependencyManifestSha256,
      renderPlanSha256: first.extraction.renderPlanSha256,
      timelineFrameId: first.extraction.id,
      targetFirstFrameArtifactId: first.extraction.registeredArtifactId,
      status: "ready",
    });

    const renderPlanPath = path.join(getSidecarPaths(root).editorRenderPlans, `${first.extraction.renderPlanSha256}.json`);
    const renderPlanOriginal = await readFile(renderPlanPath, "utf8");
    const renderPlan = JSON.parse(renderPlanOriginal) as Record<string, any>;
    expect(sha256Json(renderPlan)).toBe(first.extraction.renderPlanSha256);
    expect(renderPlan).toMatchObject({
      contract: "aicanvas.nested-timeline.ffmpeg.v1",
      rootEditProjectId: rootProject.id,
      rootEditProjectRevision: rootProject.revision,
      rootProjectSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      dependencyManifestSha256: first.extraction.dependencyManifestSha256,
      dependencyRefs: first.extraction.dependencyRefs,
    });
    expect(renderPlan.rootProjectSha256).toBe(sha256Json(rootProject));

    const directRetry = await prepareTimelineVideoContinuation(root, {
      editProjectId: rootProject.id,
      targetItemId: "main-ep01-unit002",
      expectedRevision: rootProject.revision,
      enqueue: false,
    });
    expect({ extractionId: directRetry.extraction.id, packId: directRetry.pack.id, artifactId: directRetry.extraction.registeredArtifactId }).toEqual({ extractionId: first.extraction.id, packId: first.pack.id, artifactId: first.extraction.registeredArtifactId });

    const editorModule = pathToFileURL(path.join(process.cwd(), "src", "core", "editor.ts")).href;
    const childScript = `import { prepareTimelineVideoContinuation } from ${JSON.stringify(editorModule)}; const value = await prepareTimelineVideoContinuation(${JSON.stringify(root)}, ${JSON.stringify({ editProjectId: rootProject.id, targetItemId: "main-ep01-unit002", expectedRevision: rootProject.revision, enqueue: false })}); process.stdout.write(JSON.stringify({ extractionId: value.extraction.id, packId: value.pack.id, artifactId: value.extraction.registeredArtifactId, dependencyManifestSha256: value.extraction.dependencyManifestSha256, renderPlanSha256: value.extraction.renderPlanSha256 }));`;
    const { stdout: restartStdout } = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], { cwd: process.cwd(), maxBuffer: 1_000_000 });
    expect(JSON.parse(restartStdout)).toEqual({ extractionId: first.extraction.id, packId: first.pack.id, artifactId: first.extraction.registeredArtifactId, dependencyManifestSha256: first.extraction.dependencyManifestSha256, renderPlanSha256: first.extraction.renderPlanSha256 });
    expect(await listTimelineFrameExtractions(root, rootProject.id)).toHaveLength(1);
    expect(await listVideoContinuationPacks(root, "main-ep01-unit002")).toHaveLength(1);

    const renderPlanTampered = { ...renderPlan, rootProjectSha256: "0".repeat(64) };
    await writeFile(renderPlanPath, `${JSON.stringify(renderPlanTampered, null, 2)}\n`, "utf8");
    await expect(prepareTimelineVideoContinuation(root, { editProjectId: rootProject.id, targetItemId: "main-ep01-unit002", expectedRevision: rootProject.revision, enqueue: false })).rejects.toThrow("内容寻址文件已存在但内容不一致");
    expect(await listTimelineFrameExtractions(root, rootProject.id)).toHaveLength(1);
    expect(await listVideoContinuationPacks(root, "main-ep01-unit002")).toHaveLength(1);
    await writeFile(renderPlanPath, renderPlanOriginal, "utf8");

    const rootDependency = nestedClip(rootProject).nestedTimeline!;
    const dependencyPath = path.join(getSidecarPaths(root).editorDependencies, `${rootDependency.childSnapshotSha256}.json`);
    const dependencyOriginal = await readFile(dependencyPath, "utf8");
    const dependencyTampered = JSON.parse(dependencyOriginal) as Record<string, any>;
    dependencyTampered.project.name = "被篡改的中层快照";
    await writeFile(dependencyPath, `${JSON.stringify(dependencyTampered, null, 2)}\n`, "utf8");
    await expect(prepareTimelineVideoContinuation(root, { editProjectId: rootProject.id, targetItemId: "main-ep01-unit002", expectedRevision: rootProject.revision, enqueue: false })).rejects.toThrow("快照哈希不一致");
    expect(await listTimelineFrameExtractions(root, rootProject.id)).toHaveLength(1);
    expect(await listVideoContinuationPacks(root, "main-ep01-unit002")).toHaveLength(1);
    await writeFile(dependencyPath, dependencyOriginal, "utf8");

    const finalRetry = await prepareTimelineVideoContinuation(root, { editProjectId: rootProject.id, targetItemId: "main-ep01-unit002", expectedRevision: rootProject.revision, enqueue: false });
    expect({ extractionId: finalRetry.extraction.id, packId: finalRetry.pack.id, artifactId: finalRetry.extraction.registeredArtifactId }).toEqual({ extractionId: first.extraction.id, packId: first.pack.id, artifactId: first.extraction.registeredArtifactId });
  }, 120_000);
});
