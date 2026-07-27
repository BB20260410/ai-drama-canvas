import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import type { DuduReadonlySourceInput } from "../../src/core/dudu-readonly-source.js";

const execFileAsync = promisify(execFile);
const ASSET_ID = "char-dudu-user-locked-v1";
const ASSET_RELATIVE_PATH = "01_视觉资产锁/嘟嘟_测试权威.png";
const BUILDER_RELATIVE_PATH = "tools/build_video_submission_pack.py";

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function unitId(index: number): string {
  return `S1E01-U${String(index).padStart(2, "0")}`;
}

function panelCount(index: number): number {
  if (index === 0) return 3;
  return index <= 13 ? 4 : 3;
}

function durationSeconds(index: number): number {
  return index === 0 ? 12 : 15;
}

function panelDuration(index: number): number {
  return durationSeconds(index) / panelCount(index);
}

function timecode(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  const wholeSeconds = Math.floor(remainder);
  const fraction = Number.isInteger(remainder)
    ? ""
    : remainder.toFixed(3).replace(/0+$/u, "").split(".")[1] ?? "";
  const secondsText = `${String(wholeSeconds).padStart(2, "0")}${fraction ? `.${fraction}` : ""}`;
  return `${String(minutes).padStart(2, "0")}:${secondsText}`;
}

function scriptBody(visualExecution: boolean): string {
  const lines = [
    visualExecution ? "# S1E1 测试视觉执行 v2.1" : "# S1E1 测试锁版剧本",
    visualExecution ? "DEC-METEOR-VFX-003；全局 meteor_vfx=OFF。" : "U00（2格12s）为历史残留摘要，结构化单元头优先。",
    "",
  ];
  for (let index = 0; index < 33; index += 1) {
    const id = unitId(index);
    const count = panelCount(index);
    const duration = durationSeconds(index);
    const perPanel = panelDuration(index);
    lines.push(`## ${id} · ${duration}s · ${count}宫格 · 测试单元${String(index).padStart(2, "0")}`);
    for (let panel = 1; panel <= count; panel += 1) {
      const containsCharacter = panel === 1;
      lines.push(
        `### ${id}-G${panel} · ${perPanel}s`,
        "| 字段 | 内容 |",
        "| --- | --- |",
        `| 景别 | ${containsCharacter ? "中景" : "纯黑"} |`,
        "| 机位 | 平视 |",
        "| 运镜 | 固定机位 |",
        `| 构图 | ${containsCharacter ? `嘟嘟位于画面中央，测试单元${index}第${panel}格` : "纯黑独立成格，无实体"} |`,
        `| 动作 | ${containsCharacter ? `嘟嘟完成第${panel}格动作` : "无"} |`,
        `| 表情 | ${containsCharacter ? "克制专注" : "无"} |`,
        `| 表情细节 | ${containsCharacter ? "眼神稳定" : "无"} |`,
        "| 情绪 | 安静连续 |",
        `| 光线 | ${containsCharacter ? "柔和暖光" : "纯黑"} |`,
        `| 色彩 | ${containsCharacter ? "暖褐" : "纯黑"} |`,
        `| 连续性 | ${containsCharacter ? "嘟嘟身份保持" : "无角色"}；meteor_vfx=OFF；unit=${id} |`,
        "| 对话 | 无 |",
        "| 旁白 | 无 |",
        "| 音效 | 轻微环境声 |",
        "",
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function contractBody(): string {
  return [
    "# 测试唯一长期合同",
    "状态：ACTIVE",
    "U00—U32共33个单元。",
    "U00是12秒序章；U01—U32各15秒。",
    "每次生图实际参考图1—5张。",
    "完成后停止，不进入S1E2。",
    "流星纹只允许作为默认OFF的镜头级VFX。",
    "",
  ].join("\n");
}

function legacyBinding(id: string): string {
  return `# ${id} legacy BindingSet\n\n当前历史 PASS 只读绑定：${ASSET_ID}。\n`;
}

function legacyGenerationRecord(id: string): string {
  return [
    `# ${id} 生成记录`,
    "",
    "## 允许参考实际使用",
    "",
    `- 参考图：${ASSET_RELATIVE_PATH}`,
    "",
  ].join("\n");
}

function v2Binding(id: string, assetSha256: string, historical: boolean): string {
  const status = historical ? "FROZEN / RAW_PASS" : "FROZEN / READY_TO_DISPATCH";
  return [
    `# ${id} BindingSet v2`,
    "",
    "版本：v2.0",
    `状态：${status}`,
    "禁止 A3；A2 后停止。",
    "",
    "## A. 权威与边界",
    "",
    "- 本测试单元唯一角色是嘟嘟；其他角色不得入画。",
    "",
    "## B. 资产门禁",
    "",
    "| id | reference_role | path | sha256 |",
    "| --- | --- | --- | --- |",
    `| ${ASSET_ID} | CHARACTER_IDENTITY | ${ASSET_RELATIVE_PATH} | ${assetSha256} |`,
    "",
    "## C. 身份规则",
    "",
    "嘟嘟始终使用测试权威图，禁止改变身份。",
    "",
    "## D. 逐格导演谱",
    "",
    ...Array.from({ length: panelCount(Number(id.slice(-2))) }, (_, offset) => [
      `### ${id}-G${offset + 1}`,
      `${offset + 1}. 嘟嘟在画面内，必须使用 ${ASSET_ID}。`,
      "",
    ]).flat(),
    "## E. raw宫格中文提示词",
    "",
    `生成 ${panelCount(Number(id.slice(-2)))} 格测试宫格，唯一角色是嘟嘟，禁止其他角色入画。`,
    "",
    "## G. 硬失败",
    "",
    "- 身份漂移为硬失败；A1/A2 预算内处理。",
    "",
  ].join("\n");
}

function sourceSpec(input: {
  id: string;
  index: number;
  rawRelativePath: string;
  rawSha256: string;
  lockedScriptPath: string;
}): Record<string, unknown> {
  const count = panelCount(input.index);
  const duration = durationSeconds(input.index);
  const perPanel = panelDuration(input.index);
  const schemaVersion = input.index <= 12 ? "1.0" : "2.0";
  const readiness = input.index <= 12
    ? undefined
    : input.index <= 18
      ? "NOT_TESTED"
      : "STORYBOARD_CROP_ANCHOR_FOLLOWUP_ONLY";
  const panels = Array.from({ length: count }, (_, offset) => ({
    id: `G${offset + 1}`,
    rect: { x: 0, y: offset * 300, width: 300, height: 300 },
  }));
  const shots = Array.from({ length: count }, (_, offset) => {
    const start = offset * perPanel;
    const end = start + perPanel;
    const shot: Record<string, unknown> = {
      id: `G${offset + 1}`,
      timeline_start: timecode(start),
      timeline_end: timecode(end),
      duration_sec: perPanel,
      shot_size: "中景",
      camera_angle: "平视",
      axis_180: "保持轴线",
      composition: "嘟嘟居中",
      character_state: "身份稳定",
      action: `完成第${offset + 1}格动作`,
      dialogue: "无",
      voiceover: "无",
      sound: "轻微环境声",
      lighting: "柔和暖光",
      scene_anchor: "测试场景",
      previous_end_state: offset === 0 ? "承接前态" : `G${offset}`,
      next_start_state: offset === count - 1 ? "衔接后态" : `G${offset + 2}`,
      caption_lines: ["测试", "测试", "测试", "测试"],
      camera_score: { narrative_intent: "测试" },
      video_prompt: "仅用于确定性测试，不调用视频模型。",
      negative_prompt: "禁止文字与身份漂移。",
    };
    if (schemaVersion === "2.0") {
      Object.assign(shot, {
        storyboard_frame_role: "representative",
        input_frame_role: "shot_start",
        i2v_input: {
          storyboard_crop_path: "待构建",
          storyboard_crop_sha256: "待构建",
          can_use_as_start_frame: true,
          start_frame_path: "待构建",
          start_frame_sha256: "待构建",
          end_frame_path: null,
          end_frame_sha256: null,
          claim_limit: "仅用于静态结构测试。",
        },
      });
    }
    return shot;
  });
  return {
    fixture_rgb: [35 + input.index, 65 + input.index, 95 + input.index],
    schema_version: schemaVersion,
    unit_id: input.id,
    source_script: input.lockedScriptPath,
    raw_path: input.rawRelativePath,
    raw_sha256: input.rawSha256,
    unit_duration_sec: duration,
    layout: { columns: 1, rows: count, reading_order: "top-to-bottom" },
    panels,
    shots,
    status: "PASS",
    generation: { provider: "historical-readonly" },
    ...(readiness ? {
      target_video_model_gate: {
        target_model: "NOT_CALLED",
        sample_status: readiness,
        claim_limit: "静态包结构证据；真实动态模型未调用。",
      },
    } : {}),
  };
}

const TEST_BUILDER = String.raw`#!/usr/bin/env python3
from __future__ import annotations
import argparse, binascii, hashlib, json, os, struct, zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

def digest(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()

def png_chunk(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", binascii.crc32(kind + payload) & 0xffffffff)

def solid_png(width: int, height: int, rgb: list[int]) -> bytes:
    if width < 1 or height < 1 or len(rgb) != 3 or any(not isinstance(value, int) or value < 0 or value > 255 for value in rgb):
        raise RuntimeError("invalid fixture PNG geometry")
    scanline = b"\x00" + bytes(rgb) * width
    pixels = scanline * height
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", header) + png_chunk(b"IDAT", zlib.compress(pixels, 9)) + png_chunk(b"IEND", b"")

def first_rgb(path: Path) -> list[int]:
    data = path.read_bytes()
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise RuntimeError("fixture raw is not PNG")
    offset = 8
    bit_depth = color_type = None
    compressed = bytearray()
    while offset + 12 <= len(data):
        length = struct.unpack(">I", data[offset:offset + 4])[0]
        kind = data[offset + 4:offset + 8]
        payload = data[offset + 8:offset + 8 + length]
        offset += 12 + length
        if kind == b"IHDR":
            _, _, bit_depth, color_type, _, _, _ = struct.unpack(">IIBBBBB", payload)
        elif kind == b"IDAT":
            compressed.extend(payload)
        elif kind == b"IEND":
            break
    if bit_depth != 8 or color_type not in (2, 6):
        raise RuntimeError("fixture raw PNG must be 8-bit RGB/RGBA")
    first_scanline = zlib.decompress(bytes(compressed))
    if len(first_scanline) < 4 or first_scanline[0] not in range(5):
        raise RuntimeError("fixture raw PNG scanline is invalid")
    # 第一行第一个像素对 PNG 五种 filter 的 left/up/upper-left 均为零。
    return list(first_scanline[1:4])

def bump() -> None:
    target = os.environ.get("P30_TEST_BUILDER_COUNTER")
    if target:
        with open(target, "a", encoding="utf-8") as handle:
            handle.write("1\n")

def resolve(value: str) -> Path:
    path = Path(value)
    return path.resolve() if path.is_absolute() else (ROOT / path).resolve()

def relative(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()

def build(spec_path: Path, output_root: Path) -> Path:
    bump()
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    raw = resolve(spec["raw_path"])
    if digest(raw) != spec["raw_sha256"]:
        raise RuntimeError("raw hash mismatch")
    unit = spec["unit_id"]
    target = output_root / unit
    target.mkdir(parents=True, exist_ok=True)
    if any(target.iterdir()):
        raise RuntimeError("target not empty")
    generated = []
    normalized = json.loads(json.dumps(spec, ensure_ascii=False))
    normalized["raw_path"] = relative(raw)
    rgb = normalized.get("fixture_rgb") or first_rgb(raw)
    labeled_cards = []
    for panel, shot in zip(normalized["panels"], normalized["shots"], strict=True):
        shot_id = shot["id"]
        rect = panel["rect"]
        width, height = int(rect["width"]), int(rect["height"])
        crop = target / f"{unit}-{shot_id}_raw.png"
        fault = os.environ.get("P30_TEST_BUILDER_FAULT")
        crop_rgb = [rgb[0] ^ 1, rgb[1], rgb[2]] if fault == "wrong-pixels" and shot_id == "G1" else rgb
        crop.write_bytes(solid_png(width, height, crop_rgb))
        if fault == "invalid-png" and shot_id == "G1":
            crop.write_bytes(b"not-a-png-but-manifest-hash-matches")
        generated.append(crop)
        if normalized["schema_version"] == "2.0":
            image_hash = digest(crop)
            plan = shot["i2v_input"]
            plan["storyboard_crop_path"] = crop.name
            plan["storyboard_crop_sha256"] = image_hash
            plan["start_frame_path"] = crop.name
            plan["start_frame_sha256"] = image_hash
            plan["end_frame_path"] = None
            plan["end_frame_sha256"] = None
        labeled = target / f"{unit}-{shot_id}_labeled.png"
        labeled.write_bytes(solid_png(width, height + 24, rgb))
        labeled_cards.append((width, height + 24))
        generated.append(labeled)
        prompt = target / f"{unit}-{shot_id}_video.md"
        tick = chr(96)
        duration_text = f"{float(shot['duration_sec']):.1f}" if isinstance(shot["duration_sec"], int) else str(shot["duration_sec"])
        video_prompt = "合法UTF-8但不属于冻结规格的篡改提示词。" if fault == "wrong-prompt" and shot_id == "G1" else shot["video_prompt"]
        prompt.write_text(
            f"# {unit}-{shot_id} 图生视频指令\n\n"
            f"- 时码：{tick}{shot['timeline_start']}—{shot['timeline_end']}{tick}；时长：{tick}{duration_text}s{tick}\n\n"
            f"## 图生视频中文提示词\n\n{video_prompt}\n\n"
            f"## 固定禁止项\n\n{shot['negative_prompt']}\n",
            encoding="utf-8",
        )
        if fault == "invalid-markdown" and shot_id == "G1":
            prompt.write_bytes(b"\xff\xfe\x00invalid-utf8")
        generated.append(prompt)
    total_labeled = target / f"{unit}_labeled.png"
    total_labeled.write_bytes(solid_png(max(width for width, _ in labeled_cards), sum(height for _, height in labeled_cards), rgb))
    generated.append(total_labeled)
    video_json = target / f"{unit}_video.json"
    video_json.write_text(json.dumps(normalized, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    generated.append(video_json)
    if normalized["schema_version"] == "1.0":
        notice = target / "LEGACY_I2V_AUDIT_REQUIRED.md"
        notice.write_text("legacy audit required\n", encoding="utf-8")
        generated.append(notice)
    readiness = "LEGACY_FRAME_ROLE_AUDIT_REQUIRED" if normalized["schema_version"] == "1.0" else normalized["target_video_model_gate"]["sample_status"]
    manifest = {
        "manifest_version": "2.0",
        "spec_schema_version": normalized["schema_version"],
        "builder": "tools/build_video_submission_pack.py",
        "unit_id": unit,
        "status": normalized["status"],
        "i2v_readiness": readiness,
        "source_spec": {"path": relative(spec_path), "sha256": digest(spec_path)},
        "raw": {"path": relative(raw), "sha256": digest(raw)},
        "files": [{"path": item.name, "sha256": digest(item)} for item in generated],
    }
    (target / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return target

def verify(package: Path) -> None:
    bump()
    manifest = json.loads((package / "manifest.json").read_text(encoding="utf-8"))
    if package.name != manifest["unit_id"]:
        raise RuntimeError("unit mismatch")
    raw = resolve(manifest["raw"]["path"])
    spec = resolve(manifest["source_spec"]["path"])
    if digest(raw) != manifest["raw"]["sha256"] or digest(spec) != manifest["source_spec"]["sha256"]:
        raise RuntimeError("input drift")
    names = set()
    for entry in manifest["files"]:
        name = entry["path"]
        if Path(name).name != name or name in names or digest(package / name) != entry["sha256"]:
            raise RuntimeError("file drift")
        names.add(name)
    if names | {"manifest.json"} != {item.name for item in package.iterdir()}:
        raise RuntimeError("file set drift")

def main() -> int:
    parser = argparse.ArgumentParser()
    subs = parser.add_subparsers(dest="command", required=True)
    build_parser = subs.add_parser("build")
    build_parser.add_argument("--spec", required=True)
    build_parser.add_argument("--output-root", required=True)
    build_parser.add_argument("--font")
    verify_parser = subs.add_parser("verify")
    verify_parser.add_argument("--package-dir", required=True)
    args = parser.parse_args()
    if args.command == "build":
        print(build(Path(args.spec).resolve(), Path(args.output_root).resolve()))
    else:
        verify(Path(args.package_dir).resolve())
        print(Path(args.package_dir).resolve())
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
`;

export interface DuduReadonlySourceFixture {
  root: string;
  projectsRoot: string;
  registryPath: string;
  productionRoot: string;
  lockedScriptPath: string;
  builderPath: string;
  assetSha256: string;
  source: DuduReadonlySourceInput;
  rawRelativePathByUnit: Record<string, string>;
  rawSha256ByUnit: Record<string, string>;
  cleanup(): Promise<void>;
}

async function writeRelative(root: string, relativePath: string, content: Buffer | string): Promise<string> {
  const target = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, content);
  return target;
}

export async function createDuduReadonlySourceFixture(): Promise<DuduReadonlySourceFixture> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "p30-dudu-readonly-source-")));
  const productionRoot = path.join(root, "production");
  const projectsRoot = path.join(root, "projects");
  const registryPath = path.join(root, "registry", "projects.json");
  const lockedScriptPath = path.join(root, "locked", "S1E1_锁版测试.md");
  await Promise.all([
    mkdir(productionRoot, { recursive: true, mode: 0o700 }),
    mkdir(projectsRoot, { recursive: true, mode: 0o700 }),
    mkdir(path.dirname(lockedScriptPath), { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(lockedScriptPath, scriptBody(false));

  const assetBytes = await sharp({
    create: { width: 512, height: 512, channels: 3, background: { r: 155, g: 104, b: 67 } },
  }).png({ compressionLevel: 9 }).toBuffer();
  const assetSha256 = sha256(assetBytes);
  await writeRelative(productionRoot, ASSET_RELATIVE_PATH, assetBytes);
  await Promise.all([
    writeRelative(productionRoot, "00_唯一长期执行合同_v2.md", contractBody()),
    writeRelative(productionRoot, "00_视觉正典_v2/00_视觉正典修订说明.md", "DEC-METEOR-VFX-003\n"),
    writeRelative(productionRoot, "00_视觉正典_v2/episodes/S1E1_树下的家_视觉执行v2.md", scriptBody(true)),
    writeRelative(productionRoot, "01_视觉资产锁/00_正典冲突与执行裁决.md", "DEC-METEOR-VFX-003\n"),
    writeRelative(productionRoot, "01_视觉资产锁/04_特殊规则/rule-liuxingdeng-v2_故事卡.md", "DEC-METEOR-VFX-003\nSHOT_LEVEL_VFX\n"),
    writeRelative(productionRoot, BUILDER_RELATIVE_PATH, TEST_BUILDER),
  ]);
  await writeRelative(productionRoot, "01_视觉资产锁/00_允许参考资产.json", `${JSON.stringify({
    max_referenced_image_paths_per_call: 5,
    assets: [{
      id: ASSET_ID,
      type: "character",
      reference_role: "CHARACTER_IDENTITY",
      file: ASSET_RELATIVE_PATH,
      sha256: assetSha256,
      status: "APPROVED",
      inherit: "保持测试嘟嘟身份与毛色。",
      forbid: "禁止换脸、变色或增减饰件。",
    }],
  }, null, 2)}\n`);

  const rawRelativePathByUnit: Record<string, string> = {};
  const rawSha256ByUnit: Record<string, string> = {};
  const machineUnits: Array<Record<string, unknown>> = [];
  for (let index = 0; index < 33; index += 1) {
    const id = unitId(index);
    if (index <= 12) {
      await writeRelative(productionRoot, `05_提示词/${id}_BindingSet.md`, legacyBinding(id));
      await writeRelative(productionRoot, `05_提示词/${id}_生成记录.md`, legacyGenerationRecord(id));
    } else if (index <= 29) {
      await writeRelative(productionRoot, `05_提示词/${id}_BindingSet_v2.md`, v2Binding(id, assetSha256, index <= 27));
    }

    const count = panelCount(index);
    const rawBytes = await sharp({
      create: {
        width: 300,
        height: count * 300,
        channels: 3,
        background: { r: 35 + index, g: 65 + index, b: 95 + index },
      },
    }).png({ compressionLevel: 9 }).toBuffer();
    const rawRelativePath = `03_15秒宫格故事板/S1E1/${id}_${count}格_raw.png`;
    const rawSha256 = sha256(rawBytes);
    rawRelativePathByUnit[id] = rawRelativePath;
    rawSha256ByUnit[id] = rawSha256;

    if (index <= 27) {
      await writeRelative(productionRoot, rawRelativePath, rawBytes);
      const specRelativePath = `05_提示词/${id}_视频规格.json`;
      await writeRelative(productionRoot, specRelativePath, `${JSON.stringify(sourceSpec({
        id,
        index,
        rawRelativePath,
        rawSha256,
        lockedScriptPath,
      }), null, 2)}\n`);
      const outputRoot = path.join(productionRoot, "06_图生视频提交包", "S1E1");
      await mkdir(outputRoot, { recursive: true, mode: 0o700 });
      await execFileAsync("python3", [
        path.join(productionRoot, BUILDER_RELATIVE_PATH),
        "build",
        "--spec",
        path.join(productionRoot, specRelativePath),
        "--output-root",
        outputRoot,
      ], { maxBuffer: 1_000_000 });
      const qcRelativePath = `02_出图总表/${id}_QC.md`;
      await writeRelative(productionRoot, qcRelativePath, `# ${id} QC\n\nVISUAL_PASS\n`);
      machineUnits.push({
        unit_id: id,
        duration_sec: durationSeconds(index),
        panel_count: count,
        storyboard_status: "PASS",
        raw_qc_status: "VISUAL_PASS",
        approved_raw_path: rawRelativePath,
        approved_raw_sha256: rawSha256,
        preparation_status: "HISTORICAL_PASS",
        generation_status: "HISTORICAL_PASS",
        video_pack_status: "VERIFIED",
        continuity_status: "PASS",
        overall_status: "PASS",
        tool_invocation_count: 1,
        visual_candidate_count: 1,
        rejected_candidates: [],
        evidence: {
          qc: qcRelativePath,
          video_pack: `06_图生视频提交包/S1E1/${id}`,
        },
      });
    } else {
      machineUnits.push({
        unit_id: id,
        duration_sec: durationSeconds(index),
        panel_count: count,
        storyboard_status: "PENDING",
        raw_qc_status: "NOT_STARTED",
        preparation_status: index <= 29 ? "FROZEN_READY" : "PENDING_BINDING",
        generation_status: "NOT_STARTED",
        video_pack_status: "NOT_STARTED",
        continuity_status: "PENDING",
        overall_status: "PENDING",
        tool_invocation_count: 0,
        visual_candidate_count: 0,
        rejected_candidates: [],
        evidence: {},
      });
    }
  }
  await writeRelative(productionRoot, "02_出图总表/00_S1E1_生产状态.json", `${JSON.stringify({
    summary: {
      unit_count: 33,
      storyboard_pass_count: 28,
      earliest_storyboard_pending: "S1E01-U28",
    },
    units: machineUnits,
  }, null, 2)}\n`);

  const source: DuduReadonlySourceInput = { lockedScriptPath, productionRoot };
  return {
    root,
    projectsRoot,
    registryPath,
    productionRoot,
    lockedScriptPath,
    builderPath: path.join(productionRoot, BUILDER_RELATIVE_PATH),
    assetSha256,
    source,
    rawRelativePathByUnit,
    rawSha256ByUnit,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export async function builderInvocationCount(counterPath: string): Promise<number> {
  const bytes = await readFile(counterPath).catch(() => Buffer.alloc(0));
  return bytes.toString("utf8").split(/\r?\n/u).filter(Boolean).length;
}
