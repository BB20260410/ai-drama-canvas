/**
 * 总资源库图片分类纯函数。
 *
 * 这个模块只根据调用方已经读取到的元数据产生非权威分类投影：
 * - 不读文件系统、不写数据库、不改变 canonical / Review / Primary；
 * - primaryCategory 是总资源库唯一主分组，contentTags 是可多选的内容语义轴；
 * - resourceRole 是生产角色轴，raw / labeled 不等同于人物、场景或道具；
 * - 多个同级类别冲突时保留全部 contentTags，并显式标记 metadata-ambiguous。
 */

export const STUDIO_GLOBAL_IMAGE_CLASSIFIER_VERSION =
  "studio-global-image-classifier-v1" as const;

export type StudioGlobalImageContentTag =
  | "character"
  | "scene"
  | "prop"
  | "style";

export type StudioGlobalImagePrimaryCategory =
  | StudioGlobalImageContentTag
  | "storyboard"
  | "reference"
  | "other";

export type StudioGlobalImageResourceRole =
  | "asset-reference"
  | "raw"
  | "labeled"
  | "source-original"
  | "storyboard-grid"
  | "shot-frame"
  | "poster-cover"
  | "reference"
  | "other";

export type StudioGlobalImageClassificationState =
  | "canonical"
  | "metadata-high"
  | "metadata-ambiguous"
  | "visual-pending"
  | "manual";

export interface StudioGlobalImageCanonicalAssociation {
  category: StudioGlobalImageContentTag;
  assetId?: string;
  versionId?: string;
}

export interface StudioGlobalImageManualClassification {
  primaryCategory: StudioGlobalImagePrimaryCategory;
  contentTags?: readonly StudioGlobalImageContentTag[];
  resourceRole?: StudioGlobalImageResourceRole;
  evidence?: string;
}

export interface StudioGlobalImageClassificationInput {
  sourceBasename: string;
  /**
   * 优先提供工程内相对路径，避免工程根目录名称被误当成素材目录。
   * 缺失时才退回 sourcePath。
   */
  projectRelativePath?: string;
  sourcePath?: string;
  canonicalAssociations?: readonly StudioGlobalImageCanonicalAssociation[];
  declaredCategories?: readonly StudioGlobalImageContentTag[];
  declaredResourceRole?: StudioGlobalImageResourceRole;
  manualClassification?: StudioGlobalImageManualClassification;
}

export interface StudioGlobalImageClassification {
  primaryCategory: StudioGlobalImagePrimaryCategory;
  contentTags: StudioGlobalImageContentTag[];
  resourceRole: StudioGlobalImageResourceRole;
  classificationState: StudioGlobalImageClassificationState;
  confidence: number;
  evidence: string[];
  classifierVersion: typeof STUDIO_GLOBAL_IMAGE_CLASSIFIER_VERSION;
}

const CONTENT_TAG_ORDER: readonly StudioGlobalImageContentTag[] = [
  "character",
  "scene",
  "prop",
  "style",
];

const DIRECTORY_ALIASES: Readonly<
  Record<StudioGlobalImageContentTag, ReadonlySet<string>>
> = {
  character: new Set([
    "character",
    "characters",
    "characterasset",
    "characterassets",
    "cast",
    "role",
    "roles",
    "roleasset",
    "roleassets",
    "人物",
    "人物库",
    "人物素材",
    "人物资源",
    "人物设定",
    "角色",
    "角色库",
    "角色素材",
    "角色资源",
    "角色设定",
  ]),
  scene: new Set([
    "scene",
    "scenes",
    "sceneasset",
    "sceneassets",
    "location",
    "locations",
    "environmentasset",
    "environmentassets",
    "场景",
    "场景库",
    "场景素材",
    "场景资源",
    "场景设定",
    "环境素材",
    "环境设定",
  ]),
  prop: new Set([
    "prop",
    "props",
    "propasset",
    "propassets",
    "objectasset",
    "objectassets",
    "道具",
    "道具库",
    "道具素材",
    "道具资源",
    "道具设定",
    "物件素材",
    "物件设定",
  ]),
  style: new Set([
    "style",
    "styles",
    "styleasset",
    "styleassets",
    "lookdev",
    "风格",
    "风格库",
    "风格素材",
    "风格资源",
    "美术风格",
    "视觉风格",
  ]),
};

interface CategoryEvidence {
  category: StudioGlobalImageContentTag;
  evidence: string;
}

interface RoleDetection {
  role: StudioGlobalImageResourceRole;
  evidence: string;
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replaceAll("\\", "/").toLowerCase();
}

function basenameWithoutExtension(value: string): string {
  const normalized = normalizeText(value);
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return basename.replace(/\.[^.]+$/u, "");
}

function normalizedClassificationPath(
  input: StudioGlobalImageClassificationInput,
): string {
  const preferredPath =
    input.projectRelativePath?.trim() ||
    input.sourcePath?.trim() ||
    input.sourceBasename;
  return normalizeText(preferredPath).replace(/\/+/gu, "/");
}

function orderedTags(
  values: Iterable<StudioGlobalImageContentTag>,
): StudioGlobalImageContentTag[] {
  const available = new Set(values);
  return CONTENT_TAG_ORDER.filter((category) => available.has(category));
}

function uniqueEvidence(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.length > 0))];
}

function semanticPrimaryTag(
  primaryCategory: StudioGlobalImagePrimaryCategory,
): StudioGlobalImageContentTag | undefined {
  return CONTENT_TAG_ORDER.find((category) => category === primaryCategory);
}

function normalizeDirectorySegment(value: string): string {
  return value
    .replace(/\.[^.]+$/u, "")
    .replace(/^\s*\d{1,3}(?:[\s._-]+|(?=[^\d]))/u, "")
    .replace(/[\s._-]+/gu, "");
}

function detectDirectoryCategories(
  classificationPath: string,
): CategoryEvidence[] {
  const segments = classificationPath.split("/").filter(Boolean);
  const directorySegments = segments.slice(0, -1);
  const result: CategoryEvidence[] = [];
  for (const [index, rawSegment] of directorySegments.entries()) {
    const segment = normalizeDirectorySegment(rawSegment);
    for (const category of CONTENT_TAG_ORDER) {
      if (DIRECTORY_ALIASES[category].has(segment)) {
        result.push({
          category,
          evidence: `asset-directory:${category}:${rawSegment}`,
        });
      }
    }
    // 旧制作包普遍以 assets/Cxx、assets/Sxx、assets/Pxx 保存显式资产。
    // 代码前缀只在 assets 直接子目录生效，避免把剧集、镜号或普通文件名误当类别。
    const parent = directorySegments[index - 1]?.normalize("NFKC").toLowerCase();
    if (parent === "assets") {
      const category = /^c\d/iu.test(rawSegment)
        ? "character"
        : /^s\d/iu.test(rawSegment)
          ? "scene"
          : /^p\d/iu.test(rawSegment)
            ? "prop"
            : undefined;
      if (category) {
        result.push({
          category,
          evidence: `coded-asset-directory:${category}:${rawSegment}`,
        });
      }
    }
  }
  return result;
}

function hasEnglishToken(value: string, tokenPattern: string): boolean {
  return new RegExp(
    `(?:^|[^a-z0-9])(?:${tokenPattern})(?:[^a-z0-9]|$)`,
    "u",
  ).test(value);
}

function detectFilenameCategories(sourceBasename: string): CategoryEvidence[] {
  const filename = basenameWithoutExtension(sourceBasename);
  const result: CategoryEvidence[] = [];

  if (
    hasEnglishToken(filename, "characters?|cast|roles?") ||
    /(?:角色设定|人物设定|角色三视图|人物三视图|角色参考|人物参考|角色图|人物图)/u.test(
      filename,
    )
  ) {
    result.push({
      category: "character",
      evidence: "filename-category:character",
    });
  }
  if (
    hasEnglishToken(filename, "scenes?|locations?|environments?") ||
    /(?:场景设定|场景参考|场景图|环境设定|环境参考|环境图)/u.test(filename)
  ) {
    result.push({
      category: "scene",
      evidence: "filename-category:scene",
    });
  }
  if (
    hasEnglishToken(filename, "props?|objects?") ||
    /(?:道具设定|道具参考|道具图|物件设定|物件参考|物件图)/u.test(filename)
  ) {
    result.push({
      category: "prop",
      evidence: "filename-category:prop",
    });
  }
  if (
    hasEnglishToken(filename, "styles?|lookdev") ||
    /(?:风格设定|风格参考|风格稿|美术风格|视觉风格)/u.test(filename)
  ) {
    result.push({
      category: "style",
      evidence: "filename-category:style",
    });
  }
  return result;
}

function hasDelimitedToken(value: string, token: string): boolean {
  return new RegExp(
    `(?:^|[/\\s._-])${token}(?:$|[/\\s._-])`,
    "u",
  ).test(value);
}

function detectResourceRole(
  input: StudioGlobalImageClassificationInput,
  classificationPath: string,
  hasSemanticCategory: boolean,
): RoleDetection {
  if (input.declaredResourceRole) {
    return {
      role: input.declaredResourceRole,
      evidence: `declared-resource-role:${input.declaredResourceRole}`,
    };
  }

  const filename = basenameWithoutExtension(input.sourceBasename);
  const isLabeled =
    hasDelimitedToken(classificationPath, "labeled") ||
    /(?:标注图|带标注|已标注)/u.test(filename);
  if (isLabeled) {
    return { role: "labeled", evidence: "resource-role:labeled" };
  }

  const isRaw =
    hasDelimitedToken(classificationPath, "raw") ||
    /(?:^|[._\-\s])raw(?:$|[._\-\s])/u.test(filename);
  if (isRaw) {
    return { role: "raw", evidence: "resource-role:raw" };
  }

  const isStoryboardGrid =
    hasEnglishToken(filename, "storyboards?|storyboards?grid|grids?|contact[\\s._-]*sheets?") ||
    /(?:故事板|分镜板|分镜宫格|九宫格|六宫格|四宫格|宫格图|参考板)/u.test(
      `${classificationPath}/${filename}`,
    );
  if (isStoryboardGrid) {
    return {
      role: "storyboard-grid",
      evidence: "resource-role:storyboard-grid",
    };
  }

  const isPosterCover =
    hasEnglishToken(filename, "posters?|covers?|key[\\s._-]*visuals?") ||
    hasDelimitedToken(classificationPath, "poster") ||
    hasDelimitedToken(classificationPath, "posters") ||
    hasDelimitedToken(classificationPath, "cover") ||
    hasDelimitedToken(classificationPath, "covers") ||
    /(?:海报|封面|主视觉)/u.test(`${classificationPath}/${filename}`);
  if (isPosterCover) {
    return {
      role: "poster-cover",
      evidence: "resource-role:poster-cover",
    };
  }

  const isShotFrame =
    hasDelimitedToken(classificationPath, "shot") ||
    hasDelimitedToken(classificationPath, "shots") ||
    hasDelimitedToken(classificationPath, "panel") ||
    hasDelimitedToken(classificationPath, "panels") ||
    hasDelimitedToken(classificationPath, "storyboard") ||
    hasDelimitedToken(classificationPath, "storyboards") ||
    /(?:镜头|分镜|宫格)/u.test(`${classificationPath}/${filename}`);
  if (isShotFrame) {
    return {
      role: "shot-frame",
      evidence: "resource-role:shot-frame",
    };
  }

  const isSourceOriginal =
    hasDelimitedToken(classificationPath, "source") ||
    hasDelimitedToken(classificationPath, "sources") ||
    hasDelimitedToken(classificationPath, "original") ||
    hasDelimitedToken(classificationPath, "originals") ||
    /(?:源图|原图|原始图)/u.test(`${classificationPath}/${filename}`);
  if (isSourceOriginal) {
    return {
      role: "source-original",
      evidence: "resource-role:source-original",
    };
  }

  const isReference =
    hasDelimitedToken(classificationPath, "reference") ||
    hasDelimitedToken(classificationPath, "references") ||
    hasDelimitedToken(classificationPath, "ref") ||
    hasDelimitedToken(classificationPath, "authority") ||
    hasDelimitedToken(classificationPath, "authorities") ||
    hasDelimitedToken(classificationPath, "hard-lock") ||
    hasDelimitedToken(classificationPath, "hard-locks") ||
    /(?:参考图|权威图|主参考|硬锁图)/u.test(`${classificationPath}/${filename}`);
  if (isReference) {
    return { role: "reference", evidence: "resource-role:reference" };
  }

  if (hasSemanticCategory) {
    return {
      role: "asset-reference",
      evidence: "resource-role:asset-reference",
    };
  }
  return { role: "other", evidence: "resource-role:other" };
}

function hasStoryboardEvidence(
  classificationPath: string,
  sourceBasename: string,
  resourceRole: StudioGlobalImageResourceRole,
): boolean {
  if (resourceRole === "storyboard-grid" || resourceRole === "shot-frame") {
    return true;
  }
  const filename = basenameWithoutExtension(sourceBasename);
  return (
    hasDelimitedToken(classificationPath, "shot") ||
    hasDelimitedToken(classificationPath, "shots") ||
    hasDelimitedToken(classificationPath, "panel") ||
    hasDelimitedToken(classificationPath, "panels") ||
    hasDelimitedToken(classificationPath, "storyboard") ||
    hasDelimitedToken(classificationPath, "storyboards") ||
    hasDelimitedToken(classificationPath, "grid") ||
    hasDelimitedToken(classificationPath, "grids") ||
    /(?:故事板|分镜|镜头|宫格)/u.test(`${classificationPath}/${filename}`)
  );
}

function referencePrimaryForRole(
  resourceRole: StudioGlobalImageResourceRole,
): boolean {
  return (
    resourceRole === "reference" ||
    resourceRole === "source-original" ||
    resourceRole === "poster-cover"
  );
}

function manualResult(
  input: StudioGlobalImageClassificationInput,
  manual: StudioGlobalImageManualClassification,
): StudioGlobalImageClassification {
  const role = manual.resourceRole
    ? {
        role: manual.resourceRole,
        evidence: `manual-resource-role:${manual.resourceRole}`,
      }
    : detectResourceRole(input, normalizedClassificationPath(input), false);
  const semanticPrimary = semanticPrimaryTag(manual.primaryCategory);
  const contentTags = orderedTags([
    ...(manual.contentTags ?? []),
    ...(semanticPrimary ? [semanticPrimary] : []),
  ]);
  return {
    primaryCategory: manual.primaryCategory,
    contentTags,
    resourceRole: role.role,
    classificationState: "manual",
    confidence: 1,
    evidence: uniqueEvidence([
      "manual-classification",
      ...(manual.evidence ? [`manual-evidence:${manual.evidence}`] : []),
      role.evidence,
    ]),
    classifierVersion: STUDIO_GLOBAL_IMAGE_CLASSIFIER_VERSION,
  };
}

/**
 * 根据已有元数据生成可重复、可解释的总资源库图片分类。
 *
 * 优先级：
 * manual > 唯一 canonical 关联 > 分镜身份 > declared category >
 * 明确资产目录 > 强文件名元数据 > 参考图身份 > 待视觉复核。
 */
export function classifyStudioGlobalImage(
  input: StudioGlobalImageClassificationInput,
): StudioGlobalImageClassification {
  if (input.manualClassification) {
    return manualResult(input, input.manualClassification);
  }

  const canonicalAssociations = [...(input.canonicalAssociations ?? [])].sort(
    (left, right) =>
      left.category.localeCompare(right.category) ||
      (left.assetId ?? "").localeCompare(right.assetId ?? "") ||
      (left.versionId ?? "").localeCompare(right.versionId ?? ""),
  );
  const canonicalCategories = orderedTags(
    canonicalAssociations.map((association) => association.category),
  );
  const canonicalEvidence = canonicalAssociations.map(
    (association) =>
      `canonical:${association.category}:${association.assetId ?? "unknown"}:${association.versionId ?? "unknown"}`,
  );

  const classificationPath = normalizedClassificationPath(input);
  if (canonicalCategories.length === 1) {
    const category = canonicalCategories[0];
    if (!category) {
      throw new Error("unreachable: canonical category must exist");
    }
    const role = detectResourceRole(input, classificationPath, true);
    return {
      primaryCategory: category,
      contentTags: [category],
      resourceRole: role.role,
      classificationState: "canonical",
      confidence: 1,
      evidence: uniqueEvidence([...canonicalEvidence, role.evidence]),
      classifierVersion: STUDIO_GLOBAL_IMAGE_CLASSIFIER_VERSION,
    };
  }
  if (canonicalCategories.length > 1) {
    const role = detectResourceRole(input, classificationPath, true);
    return {
      primaryCategory: "other",
      contentTags: canonicalCategories,
      resourceRole: role.role,
      classificationState: "metadata-ambiguous",
      confidence: 0.4,
      evidence: uniqueEvidence([
        ...canonicalEvidence,
        `conflict:canonical:${canonicalCategories.join(",")}`,
        role.evidence,
      ]),
      classifierVersion: STUDIO_GLOBAL_IMAGE_CLASSIFIER_VERSION,
    };
  }

  const declaredCategories = orderedTags(input.declaredCategories ?? []);
  const declaredEvidence = declaredCategories.map(
    (category) => `declared-category:${category}`,
  );
  const directoryEvidence = detectDirectoryCategories(classificationPath);
  const directoryCategories = orderedTags(
    directoryEvidence.map((item) => item.category),
  );
  const filenameEvidence = detectFilenameCategories(input.sourceBasename);
  const filenameCategories = orderedTags(
    filenameEvidence.map((item) => item.category),
  );
  const contentTags = orderedTags([
    ...declaredCategories,
    ...directoryCategories,
    ...filenameCategories,
  ]);
  const role = detectResourceRole(input, classificationPath, contentTags.length > 0);
  const storyboard = hasStoryboardEvidence(
    classificationPath,
    input.sourceBasename,
    role.role,
  );

  const categoryTiers = [
    { name: "declared", categories: declaredCategories, confidence: 0.98 },
    { name: "asset-directory", categories: directoryCategories, confidence: 0.93 },
    { name: "filename", categories: filenameCategories, confidence: 0.82 },
  ] as const;
  const winningTier = categoryTiers.find((tier) => tier.categories.length > 0);
  const hasCategoryConflict =
    contentTags.length > 1 ||
    (winningTier?.categories.length ?? 0) > 1;
  const evidence = uniqueEvidence([
    ...declaredEvidence,
    ...directoryEvidence.map((item) => item.evidence),
    ...filenameEvidence.map((item) => item.evidence),
    role.evidence,
    ...(storyboard ? ["primary-evidence:storyboard"] : []),
    ...(hasCategoryConflict
      ? [`conflict:metadata:${contentTags.join(",")}`]
      : []),
  ]);

  if (storyboard) {
    return {
      primaryCategory: "storyboard",
      contentTags,
      resourceRole: role.role,
      classificationState: hasCategoryConflict
        ? "metadata-ambiguous"
        : "metadata-high",
      confidence: hasCategoryConflict ? 0.55 : 0.94,
      evidence,
      classifierVersion: STUDIO_GLOBAL_IMAGE_CLASSIFIER_VERSION,
    };
  }

  if (winningTier) {
    if (winningTier.categories.length > 1) {
      return {
        primaryCategory: "other",
        contentTags,
        resourceRole: role.role,
        classificationState: "metadata-ambiguous",
        confidence: 0.45,
        evidence,
        classifierVersion: STUDIO_GLOBAL_IMAGE_CLASSIFIER_VERSION,
      };
    }
    const primaryCategory = winningTier.categories[0];
    if (!primaryCategory) {
      throw new Error("unreachable: winning category must exist");
    }
    return {
      primaryCategory,
      contentTags,
      resourceRole: role.role,
      classificationState: hasCategoryConflict
        ? "metadata-ambiguous"
        : "metadata-high",
      confidence: hasCategoryConflict
        ? Math.min(winningTier.confidence, 0.62)
        : winningTier.confidence,
      evidence,
      classifierVersion: STUDIO_GLOBAL_IMAGE_CLASSIFIER_VERSION,
    };
  }

  if (referencePrimaryForRole(role.role)) {
    return {
      primaryCategory: "reference",
      contentTags,
      resourceRole: role.role,
      classificationState: "metadata-high",
      confidence: 0.86,
      evidence,
      classifierVersion: STUDIO_GLOBAL_IMAGE_CLASSIFIER_VERSION,
    };
  }

  return {
    primaryCategory: "other",
    contentTags,
    resourceRole: role.role,
    classificationState: "visual-pending",
    confidence: 0.15,
    evidence: uniqueEvidence([...evidence, "visual-review-required"]),
    classifierVersion: STUDIO_GLOBAL_IMAGE_CLASSIFIER_VERSION,
  };
}
