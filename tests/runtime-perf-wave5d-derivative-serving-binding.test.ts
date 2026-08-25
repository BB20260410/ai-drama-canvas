import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("Wave 5-D 派生 serving 不校源 CAS 全 SHA", () => {
  it("derivative 分支只读 DB 绑定再 inspect 派生文件，不再 inspectCasObjectCached 源对象", () => {
    const protocol = source("src/core/studio-media-protocol.ts");
    const start = protocol.indexOf('if (request.target === "derivative")');
    const mediaStart = protocol.indexOf('if (request.target === "media")', start);
    expect(start).toBeGreaterThan(-1);
    expect(mediaStart).toBeGreaterThan(start);
    const derivativeBranch = protocol.slice(start, mediaStart);
    expect(derivativeBranch).toContain("validateDerivativeRow");
    expect(derivativeBranch).toContain("validateMediaRow");
    expect(derivativeBranch).toContain("派生类型与源媒体 kind 不匹配");
    expect(derivativeBranch).toContain("inspectManagedFileCached");
    expect(derivativeBranch).toContain('target: "derivative"');
    expect(derivativeBranch).not.toContain("inspectCasObjectCached");
    expect(derivativeBranch).not.toContain("sourcePath");
    expect(protocol).toContain("material-studio-thumb:v1:autorotate:inside-512:no-enlarge:webp-q82");
    expect(protocol).toContain("studio-video-proxy:v1:max-1280x720:h264-crf28-aac128k-faststart");
    const mediaBranch = protocol.slice(mediaStart, protocol.indexOf("if (!row.thumbnailRelpath", mediaStart));
    expect(mediaBranch).toContain("inspectCasObjectCached");
  });
});
