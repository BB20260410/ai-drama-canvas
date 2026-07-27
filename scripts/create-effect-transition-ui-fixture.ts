import { execFile } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { importEditProjectOtio } from "../src/core/editor.js";
import { commitProjectImport, prepareProjectImport } from "../src/core/importer.js";
import { scanAndPersist } from "../src/core/service.js";
import { mkdtempOwnedFixtureRoot, resetOwnedFixtureRoot } from "./lib/owned-fixture-root.js";

const execFileAsync = promisify(execFile);
const root = process.argv[2]
  ? await resetOwnedFixtureRoot(path.resolve(process.argv[2]), "create-effect-transition-ui-fixture")
  : (await mkdtempOwnedFixtureRoot("ai-canvas-editor-effect-transition-ui", "create-effect-transition-ui-fixture")).root;
const registryPath = path.resolve(process.argv[3] || path.join(os.tmpdir(), `ai-canvas-editor-effect-transition-ui-registry-${process.pid}.json`));
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;

function rational(value: number) {
  return { OTIO_SCHEMA: "RationalTime.1", value, rate: 24 };
}

function range(start: number, duration: number) {
  return { OTIO_SCHEMA: "TimeRange.1", start_time: rational(start), duration: rational(duration) };
}

function clip(name: string, sourcePath: string, start: number) {
  return {
    OTIO_SCHEMA: "Clip.2",
    name,
    source_range: range(start, 24),
    media_reference: { OTIO_SCHEMA: "ExternalReference.1", target_url: pathToFileURL(sourcePath).href, available_range: range(0, 48), available_image_bounds: null, metadata: {} },
    effects: [],
    markers: [],
    metadata: {},
  };
}

await access(registryPath).then(
  () => { throw new Error(`registry 必须是全新文件，拒绝覆盖：${registryPath}`); },
  () => undefined,
);
const firstDirectory = path.join(root, "EP01_15s_001_UI转场前项");
const secondDirectory = path.join(root, "EP01_15s_002_UI转场后项");
await Promise.all([mkdir(firstDirectory, { recursive: true }), mkdir(secondDirectory, { recursive: true })]);
await Promise.all([
  writeFile(path.join(firstDirectory, "00_信息.md"), "# UI 标准转场前项\n", "utf8"),
  writeFile(path.join(secondDirectory, "00_信息.md"), "# UI 标准转场后项\n", "utf8"),
]);
const firstVideo = path.join(firstDirectory, "EP01_15s_001_v1.mp4");
const secondVideo = path.join(secondDirectory, "EP01_15s_002_v1.mp4");
await Promise.all([
  execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=540x960:r=24:d=2", "-vf", "drawbox=x=80:y=380:w=140:h=180:color=yellow:t=fill", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", firstVideo]),
  execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=540x960:r=24:d=2", "-vf", "drawbox=x=320:y=380:w=140:h=180:color=cyan:t=fill", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", secondVideo]),
]);

const preview = await prepareProjectImport({ primaryRoot: root, projectMode: "filesystem", name: "Effect Transition UI 验收" });
if (!preview.canImport) throw new Error(preview.issues.map((issue) => issue.message).join("；"));
await commitProjectImport({ previewId: preview.previewId, config: preview.config, projectMode: "filesystem" });
await scanAndPersist(root);

const sourceOtio = path.join(root, "effect-transition-ui.otio");
const document = {
  OTIO_SCHEMA: "Timeline.1",
  name: "Effect Transition UI",
  global_start_time: null,
  tracks: {
    OTIO_SCHEMA: "Stack.1",
    name: "tracks",
    source_range: null,
    effects: [],
    markers: [],
    metadata: {},
    children: [{
      OTIO_SCHEMA: "Track.1",
      name: "V1",
      kind: "Video",
      source_range: null,
      effects: [],
      markers: [],
      metadata: {},
      children: [
        clip("UI 红场前项", firstVideo, 4),
        { OTIO_SCHEMA: "Transition.1", name: "UI 非对称溶解", transition_type: "SMPTE_Dissolve", in_offset: rational(3), out_offset: rational(5), enabled: true, metadata: {} },
        clip("UI 蓝场后项", secondVideo, 4),
      ],
    }],
  },
  metadata: { aicanvas: { fps: 24, width: 540, height: 960, backgroundColor: "#000000" } },
};
await writeFile(sourceOtio, `${JSON.stringify(document, null, 2)}\n`, "utf8");
const project = await importEditProjectOtio(root, sourceOtio, "UI 标准 Effect Transition");
const clips = project.tracks.find((track) => track.kind === "visual")!.clips;
process.stdout.write(`${JSON.stringify({ root, registryPath, editProjectId: project.id, revision: project.revision, outgoingClipId: clips[0]!.id, incomingClipId: clips[1]!.id, inOffsetFrames: clips[0]!.transition!.inOffsetFrames, outOffsetFrames: clips[0]!.transition!.outOffsetFrames, timebase: project.timebase }, null, 2)}\n`);
