import { describe, expect, it } from "vitest";
import {
  STUDIO_GLOBAL_IMAGE_CLASSIFIER_VERSION,
  classifyStudioGlobalImage,
  type StudioGlobalImageClassificationInput,
} from "../src/core/studio-global-image-classification.js";

describe("总资源库图片双轴分类", () => {
  it("唯一 canonical 关联优先于分镜路径、文件名和 raw 角色", () => {
    const result = classifyStudioGlobalImage({
      sourceBasename: "完整黄金面具_道具图_raw.png",
      projectRelativePath: "episodes/ep01/shots/人物素材/完整黄金面具_道具图_raw.png",
      canonicalAssociations: [
        {
          category: "character",
          assetId: "character-ahang",
          versionId: "character-ahang-v3",
        },
      ],
    });

    expect(result).toMatchObject({
      primaryCategory: "character",
      contentTags: ["character"],
      resourceRole: "raw",
      classificationState: "canonical",
      confidence: 1,
      classifierVersion: STUDIO_GLOBAL_IMAGE_CLASSIFIER_VERSION,
    });
    expect(result.evidence).toContain(
      "canonical:character:character-ahang:character-ahang-v3",
    );
  });

  it("不同类别的 canonical 关联显式标记冲突，不静默取第一个", () => {
    const result = classifyStudioGlobalImage({
      sourceBasename: "共用参考.png",
      canonicalAssociations: [
        { category: "prop", assetId: "prop-mask" },
        { category: "character", assetId: "character-priest" },
      ],
    });

    expect(result).toMatchObject({
      primaryCategory: "other",
      contentTags: ["character", "prop"],
      resourceRole: "asset-reference",
      classificationState: "metadata-ambiguous",
      confidence: 0.4,
    });
    expect(result.evidence).toContain("conflict:canonical:character,prop");
  });

  it("明确资产目录提供内容类别，labeled 只保留为生产角色", () => {
    const result = classifyStudioGlobalImage({
      sourceBasename: "完整黄金面具_labeled.png",
      projectRelativePath: "assets/03_道具素材/完整黄金面具_labeled.png",
    });

    expect(result).toMatchObject({
      primaryCategory: "prop",
      contentTags: ["prop"],
      resourceRole: "labeled",
      classificationState: "metadata-high",
      confidence: 0.93,
    });
  });

  it("旧制作包只在 assets 直接子目录识别 C/S/P 资产代码", () => {
    expect(
      classifyStudioGlobalImage({
        sourceBasename: "P03_资产_6474db01_raw.png",
        sourcePath: "/readonly/legacy/assets/P03_半璧/AI画布生成/P03_资产_6474db01_raw.png",
      }),
    ).toMatchObject({
      primaryCategory: "prop",
      contentTags: ["prop"],
      resourceRole: "raw",
      classificationState: "metadata-high",
    });
    expect(
      classifyStudioGlobalImage({
        sourceBasename: "S03_资产_93de2f22_labeled.png",
        sourcePath: "/readonly/legacy/assets/S03_青铜作坊/AI画布生成/S03_资产_93de2f22_labeled.png",
      }),
    ).toMatchObject({
      primaryCategory: "scene",
      contentTags: ["scene"],
      resourceRole: "labeled",
    });
    expect(
      classifyStudioGlobalImage({
        sourceBasename: "C07_资产_d9861f39_raw.png",
        sourcePath: "/readonly/legacy/assets/C07_姜子牙/AI画布生成/C07_资产_d9861f39_raw.png",
      }),
    ).toMatchObject({
      primaryCategory: "character",
      contentTags: ["character"],
      resourceRole: "raw",
    });
    expect(
      classifyStudioGlobalImage({
        sourceBasename: "S03_普通镜头.png",
        sourcePath: "/readonly/legacy/production/EP01/S03_普通镜头.png",
      }),
    ).not.toMatchObject({ primaryCategory: "scene" });
  });

  it("权威目录进入参考主分组，不把权威身份冒充 canonical", () => {
    expect(
      classifyStudioGlobalImage({
        sourceBasename: "阿航_青年_三视图.jpg",
        sourcePath: "/readonly/legacy/authorities/ahang/阿航_青年_三视图.jpg",
      }),
    ).toMatchObject({
      primaryCategory: "reference",
      resourceRole: "reference",
      classificationState: "metadata-high",
    });
  });

  it("raw 本身不推导人物、场景或道具", () => {
    const result = classifyStudioGlobalImage({
      sourceBasename: "EP01_001_raw.png",
      projectRelativePath: "outputs/raw/EP01_001_raw.png",
    });

    expect(result).toMatchObject({
      primaryCategory: "other",
      contentTags: [],
      resourceRole: "raw",
      classificationState: "visual-pending",
      confidence: 0.15,
    });
    expect(result.evidence).toContain("visual-review-required");
  });

  it("raw 位于镜头目录时主分组为分镜，但资源角色仍是 raw", () => {
    const result = classifyStudioGlobalImage({
      sourceBasename: "EP01_001_raw.png",
      projectRelativePath: "episodes/ep01/shots/EP01_001_raw.png",
    });

    expect(result).toMatchObject({
      primaryCategory: "storyboard",
      contentTags: [],
      resourceRole: "raw",
      classificationState: "metadata-high",
      confidence: 0.94,
    });
  });

  it("宫格优先进入分镜主分组，同时保留人物内容标签", () => {
    const result = classifyStudioGlobalImage({
      sourceBasename: "阿航角色设定_九宫格.png",
      projectRelativePath: "assets/characters/阿航角色设定_九宫格.png",
    });

    expect(result).toMatchObject({
      primaryCategory: "storyboard",
      contentTags: ["character"],
      resourceRole: "storyboard-grid",
      classificationState: "metadata-high",
      confidence: 0.94,
    });
  });

  it("混合人物与道具镜头保留双标签并暴露歧义", () => {
    const result = classifyStudioGlobalImage({
      sourceBasename: "character_prop_shot_001.png",
      projectRelativePath: "episodes/ep01/shots/character_prop_shot_001.png",
    });

    expect(result).toMatchObject({
      primaryCategory: "storyboard",
      contentTags: ["character", "prop"],
      resourceRole: "shot-frame",
      classificationState: "metadata-ambiguous",
      confidence: 0.55,
    });
    expect(result.evidence).toContain("conflict:metadata:character,prop");
  });

  it("冲突的明确资产目录不按目录遍历顺序选类别", () => {
    const result = classifyStudioGlobalImage({
      sourceBasename: "共用素材.png",
      projectRelativePath: "assets/characters/props/共用素材.png",
    });

    expect(result).toMatchObject({
      primaryCategory: "other",
      contentTags: ["character", "prop"],
      resourceRole: "asset-reference",
      classificationState: "metadata-ambiguous",
      confidence: 0.45,
    });
  });

  it("不把描述性的“真人实拍风格”自动当作 style 资产", () => {
    const result = classifyStudioGlobalImage({
      sourceBasename: "真人实拍风格_阿航.png",
      projectRelativePath: "incoming/真人实拍风格_阿航.png",
    });

    expect(result).toMatchObject({
      primaryCategory: "other",
      contentTags: [],
      resourceRole: "other",
      classificationState: "visual-pending",
    });
  });

  it("参考图、源图、海报分别保留资源角色并进入参考主分组", () => {
    expect(
      classifyStudioGlobalImage({
        sourceBasename: "阿航权威图.png",
        projectRelativePath: "references/阿航权威图.png",
      }),
    ).toMatchObject({
      primaryCategory: "reference",
      resourceRole: "reference",
      classificationState: "metadata-high",
    });
    expect(
      classifyStudioGlobalImage({
        sourceBasename: "扫描原图.png",
        projectRelativePath: "sources/扫描原图.png",
      }),
    ).toMatchObject({
      primaryCategory: "reference",
      resourceRole: "source-original",
      classificationState: "metadata-high",
    });
    expect(
      classifyStudioGlobalImage({
        sourceBasename: "EP01_封面.png",
        projectRelativePath: "marketing/EP01_封面.png",
      }),
    ).toMatchObject({
      primaryCategory: "reference",
      resourceRole: "poster-cover",
      classificationState: "metadata-high",
    });
  });

  it("manual 分类可覆盖自动推断，并保持输出确定且不修改输入", () => {
    const input: StudioGlobalImageClassificationInput = {
      sourceBasename: "未命名_raw.png",
      projectRelativePath: "shots/未命名_raw.png",
      manualClassification: {
        primaryCategory: "scene",
        contentTags: ["prop"],
        resourceRole: "reference",
        evidence: "人工复核为祭坛场景",
      },
    };
    const before = JSON.stringify(input);
    const first = classifyStudioGlobalImage(input);
    const second = classifyStudioGlobalImage(input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      primaryCategory: "scene",
      contentTags: ["scene", "prop"],
      resourceRole: "reference",
      classificationState: "manual",
      confidence: 1,
    });
    expect(first.evidence).toContain("manual-evidence:人工复核为祭坛场景");
    expect(JSON.stringify(input)).toBe(before);
  });

  it("declared category 高于目录分类，但冲突仍显式标记", () => {
    const result = classifyStudioGlobalImage({
      sourceBasename: "祭坛.png",
      projectRelativePath: "assets/props/祭坛.png",
      declaredCategories: ["scene"],
    });

    expect(result).toMatchObject({
      primaryCategory: "scene",
      contentTags: ["scene", "prop"],
      resourceRole: "asset-reference",
      classificationState: "metadata-ambiguous",
      confidence: 0.62,
    });
  });
});
