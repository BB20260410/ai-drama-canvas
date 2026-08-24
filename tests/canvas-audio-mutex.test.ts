import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  claimCanvasAudioPlayback,
  releaseCanvasAudioPlayback,
} from "../src/renderer/src/canvas-audio-mutex.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function nodeSource(): string {
  return readFileSync(path.join(root, "src/renderer/src/components/ManagedStudioCanvasNode.vue"), "utf8");
}

function inspectorSource(): string {
  return readFileSync(path.join(root, "src/renderer/src/components/CanvasInspectorPanel.vue"), "utf8");
}

function mockAudio() {
  return { pause: vi.fn() };
}

describe("画布音频互斥", () => {
  it("第二节点 play 会 pause 当前持有者", () => {
    const first = mockAudio();
    const second = mockAudio();
    claimCanvasAudioPlayback(first as unknown as HTMLAudioElement);
    claimCanvasAudioPlayback(second as unknown as HTMLAudioElement);
    expect(first.pause).toHaveBeenCalledTimes(1);
    expect(second.pause).not.toHaveBeenCalled();
    releaseCanvasAudioPlayback(second as unknown as HTMLAudioElement);
  });

  it("同一节点再次 claim 不 pause 自己", () => {
    const first = mockAudio();
    claimCanvasAudioPlayback(first as unknown as HTMLAudioElement);
    claimCanvasAudioPlayback(first as unknown as HTMLAudioElement);
    expect(first.pause).not.toHaveBeenCalled();
    releaseCanvasAudioPlayback(first as unknown as HTMLAudioElement);
  });

  it("release 后下一 claim 不再 pause 已释放节点", () => {
    const first = mockAudio();
    const second = mockAudio();
    claimCanvasAudioPlayback(first as unknown as HTMLAudioElement);
    releaseCanvasAudioPlayback(first as unknown as HTMLAudioElement);
    claimCanvasAudioPlayback(second as unknown as HTMLAudioElement);
    expect(first.pause).not.toHaveBeenCalled();
    releaseCanvasAudioPlayback(second as unknown as HTMLAudioElement);
  });

  it("claim 空值不改持有者", () => {
    const first = mockAudio();
    const second = mockAudio();
    claimCanvasAudioPlayback(first as unknown as HTMLAudioElement);
    claimCanvasAudioPlayback(null);
    claimCanvasAudioPlayback(second as unknown as HTMLAudioElement);
    expect(first.pause).toHaveBeenCalledTimes(1);
    releaseCanvasAudioPlayback(second as unknown as HTMLAudioElement);
  });

  it("CanvasNode play 认领互斥，卸载释放；busy/身份/卸载 pause 仍在", () => {
    const node = nodeSource();
    expect(node).toContain('@play="onCanvasAudioPlay"');
    expect(node).toContain("claimCanvasAudioPlayback(audioEl.value)");
    expect(node).toContain("releaseCanvasAudioPlayback(audioEl.value)");
    expect(node).toContain("watch(\n  () => props.data.busy,\n  (busy) => {\n    if (busy) audioEl.value?.pause();\n  },\n);");
    expect(node).toContain("watch(playbackUrl, () => {\n  audioEl.value?.pause();\n});");
    expect(node).toContain("onBeforeUnmount(() => {\n  nodeDisposed = true;\n  audioEl.value?.pause();");
    expect(node).not.toContain("wavesurfer");
    expect(node).not.toContain("from \"../studio-multimedia-playback-selection");
  });

  it("busy 中点原生 play 立即 pause，不认领互斥", () => {
    const node = nodeSource();
    const play = node.slice(
      node.indexOf("function onCanvasAudioPlay()"),
      node.indexOf("watch(\n  () => props.data.busy,"),
    );
    expect(play).toContain("if (props.data.busy) {");
    expect(play).toContain("audioEl.value?.pause();");
    expect(play.indexOf("if (props.data.busy)")).toBeLessThan(play.indexOf("claimCanvasAudioPlayback(audioEl.value)"));
  });

  it("busy 节点禁用原生音频 pointer-events，避免 overlay 点不穿仍能 play", () => {
    const node = nodeSource();
    expect(node).toContain(".msc-node.busy .canvas-audio-player { pointer-events: none; }");
    expect(node).toContain(".managed-node-status-overlay {\n  position: absolute;\n  inset: 0;\n  z-index: 6;\n  display: grid;\n  place-items: center;\n  border-radius: 10px;\n  background: color-mix(in srgb, var(--msc-surface) 72%, transparent);\n  color: var(--msc-accent-strong);\n  font-size: 11px;\n  font-weight: 600;\n  pointer-events: none;\n}");
  });

  it("检查器角色音频 play 认领互斥，busy 早退 pause，卸载释放", () => {
    const inspector = inspectorSource();
    const play = inspector.slice(
      inspector.indexOf("function onCharacterAudioPlay()"),
      inspector.indexOf("watch(\n  () => props.characterAudioBlocked,"),
    );
    expect(inspector).toContain('data-testid="managed-canvas-character-audio-player"');
    expect(play).toContain("if (props.characterAudioBlocked) {");
    expect(play).toContain("characterAudioEl.value?.pause();");
    expect(play.indexOf("if (props.characterAudioBlocked)")).toBeLessThan(play.indexOf("claimCanvasAudioPlayback(characterAudioEl.value)"));
    expect(inspector).toContain("watch(\n  () => props.characterAudioBlocked,\n  (blocked) => {\n    if (blocked) characterAudioEl.value?.pause();\n  },\n);");
    expect(inspector).toContain("watch(\n  () => props.characterAudioPlaybackUrl,");
    expect(inspector).toContain("releaseCanvasAudioPlayback(characterAudioEl.value)");
    expect(inspector).not.toContain("wavesurfer");
  });
});
