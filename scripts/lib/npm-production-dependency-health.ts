export interface NpmLsDependencyNode {
  version?: string;
  extraneous?: boolean;
  missing?: boolean;
  invalid?: boolean;
  problems?: string[];
  dependencies?: Record<string, NpmLsDependencyNode>;
}

export interface NpmLsJson extends NpmLsDependencyNode {
  name?: string;
}

export interface PackageLockPackageEntry {
  version?: string;
  dev?: boolean;
  optional?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface PackageLockJson {
  packages?: Record<string, PackageLockPackageEntry>;
}

export interface AcceptedOptionalProductionProblem {
  name: string;
  version: string;
  rootDependency: string;
  dependencyPath: string[];
  reason: "lockfile-optional-chain";
}

export interface RejectedProductionProblem {
  kind: "extraneous" | "missing" | "invalid" | "unknown";
  name?: string;
  version?: string;
  reason: string;
}

export interface NpmProductionDependencyHealthSummary {
  schemaVersion: 1;
  status: "passed";
  problemCount: number;
  acceptedOptionalProblems: AcceptedOptionalProductionProblem[];
  rejectedProblems: RejectedProductionProblem[];
}

interface ReachableOptionalPackage {
  rootDependency: string;
  dependencyPath: string[];
  packagePath: string;
  version: string;
}

function packageKey(name: string): string {
  return `node_modules/${name}`;
}

function parsedVersion(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/u.exec(value);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: [number, number, number], right: [number, number, number]): number {
  if (left[0] !== right[0]) return left[0] - right[0];
  if (left[1] !== right[1]) return left[1] - right[1];
  return left[2] - right[2];
}

/** 只接受本门禁实际需要、可确定验证的 exact/caret/tilde semver；未知 spec 失败关闭。 */
function dependencySpecAllowsVersion(spec: string, version: string): boolean {
  if (spec === version) return true;
  const operator = spec[0];
  if (operator !== "^" && operator !== "~") return false;
  // 标准 semver range 默认不吸纳未显式列出的 prerelease。本门禁不实现
  // 完整 prerelease 代数，范围两端任一含 prerelease 即失败关闭。
  if (spec.includes("-") || version.includes("-")) return false;
  const base = parsedVersion(spec.slice(1));
  const candidate = parsedVersion(version);
  if (!base || !candidate || compareVersions(candidate, base) < 0) return false;
  if (operator === "~") return candidate[0] === base[0] && candidate[1] === base[1];
  if (base[0] > 0) return candidate[0] === base[0];
  if (base[1] > 0) return candidate[0] === 0 && candidate[1] === base[1];
  return candidate[0] === 0 && candidate[1] === 0 && candidate[2] === base[2];
}

function parentPackagePath(packagePath: string): string {
  const nestedMarker = "/node_modules/";
  const nestedIndex = packagePath.lastIndexOf(nestedMarker);
  return nestedIndex < 0 ? "" : packagePath.slice(0, nestedIndex);
}

function resolveLockDependencyPath(
  packages: Record<string, PackageLockPackageEntry>,
  fromPackagePath: string,
  dependencyName: string,
): string | undefined {
  let cursor = fromPackagePath;
  for (;;) {
    const candidate = cursor ? `${cursor}/node_modules/${dependencyName}` : packageKey(dependencyName);
    if (packages[candidate]) return candidate;
    if (!cursor) return undefined;
    cursor = parentPackagePath(cursor);
  }
}

function reachableOptionalPackages(lockfile: PackageLockJson): Map<string, ReachableOptionalPackage> {
  const packages = lockfile.packages ?? {};
  const rootEntry = packages[""] ?? {};
  const roots = [...new Set([
    ...Object.keys(rootEntry.dependencies ?? {}),
    ...Object.keys(rootEntry.optionalDependencies ?? {}),
  ])].sort((left, right) => left.localeCompare(right, "en"));
  const reachable = new Map<string, ReachableOptionalPackage>();

  for (const rootDependency of roots) {
    const rootSpec = rootEntry.optionalDependencies?.[rootDependency]
      ?? rootEntry.dependencies?.[rootDependency];
    const rootPackagePath = resolveLockDependencyPath(packages, "", rootDependency);
    const rootPackage = rootPackagePath ? packages[rootPackagePath] : undefined;
    if (!rootSpec || !rootPackagePath || !rootPackage?.version
      || !dependencySpecAllowsVersion(rootSpec, rootPackage.version)) continue;
    const queue: Array<{ name: string; packagePath: string; path: string[]; optionalPath: boolean }> = [{
      name: rootDependency,
      packagePath: rootPackagePath,
      path: [rootDependency],
      optionalPath: rootEntry.optionalDependencies?.[rootDependency] !== undefined || rootPackage.optional === true,
    }];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      const visitKey = `${current.packagePath}:${current.optionalPath}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);
      const entry = packages[current.packagePath];
      if (!entry?.version || entry.dev === true) continue;
      const optionalPath = current.optionalPath || entry.optional === true;
      if (optionalPath && !reachable.has(current.packagePath)) {
        reachable.set(current.packagePath, {
          rootDependency,
          dependencyPath: current.path,
          packagePath: current.packagePath,
          version: entry.version,
        });
      }
      const dependencyNames = [...new Set([
        ...Object.keys(entry.dependencies ?? {}),
        ...Object.keys(entry.optionalDependencies ?? {}),
      ])].sort((left, right) => left.localeCompare(right, "en"));
      for (const dependencyName of dependencyNames) {
        const spec = entry.optionalDependencies?.[dependencyName]
          ?? entry.dependencies?.[dependencyName];
        const childPackagePath = resolveLockDependencyPath(packages, current.packagePath, dependencyName);
        const child = childPackagePath ? packages[childPackagePath] : undefined;
        if (!spec || !childPackagePath || !child?.version
          || !dependencySpecAllowsVersion(spec, child.version)) continue;
        queue.push({
          name: dependencyName,
          packagePath: childPackagePath,
          path: [...current.path, dependencyName],
          optionalPath: optionalPath || entry.optionalDependencies?.[dependencyName] !== undefined,
        });
      }
    }
  }
  return reachable;
}

function packagePathFromProblemLocation(location: string | undefined): string | undefined {
  if (!location) return undefined;
  const normalized = location.trim().replaceAll("\\", "/").replace(/\/+$/u, "");
  const markerIndex = normalized.indexOf("node_modules/");
  return markerIndex < 0 ? undefined : normalized.slice(markerIndex);
}

function packageNameAtPath(packagePath: string): string | undefined {
  const marker = "node_modules/";
  const index = packagePath.lastIndexOf(marker);
  if (index < 0) return undefined;
  const segments = packagePath.slice(index + marker.length).split("/");
  return segments[0]?.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

function npmLsNodesByPackagePath(root: NpmLsJson): Map<string, NpmLsDependencyNode> {
  const result = new Map<string, NpmLsDependencyNode>();
  const visit = (dependencies: Record<string, NpmLsDependencyNode> | undefined, parentPath: string) => {
    for (const [name, node] of Object.entries(dependencies ?? {})) {
      const packagePath = parentPath ? `${parentPath}/node_modules/${name}` : packageKey(name);
      result.set(packagePath, node);
      visit(node.dependencies, packagePath);
    }
  };
  visit(root.dependencies, "");
  return result;
}

function sanitizedProblem(problem: string): RejectedProductionProblem {
  const extraneous = /^extraneous:\s+((?:@[^/\s]+\/)?[^@\s]+)@([^\s]+)(?:\s+(.+))?$/u.exec(problem);
  if (extraneous) return {
    kind: "extraneous",
    name: extraneous[1],
    version: extraneous[2],
    reason: packagePathFromProblemLocation(extraneous[3]) ?? "missing-package-path",
  };
  const missing = /^missing:\s+((?:@[^/\s]+\/)?[^@,\s]+)@([^,\s]+)/u.exec(problem);
  if (missing) return { kind: "missing", name: missing[1], version: missing[2], reason: "missing-production-dependency" };
  const invalid = /^invalid:\s+((?:@[^/\s]+\/)?[^@\s]+)@([^\s]+)/u.exec(problem);
  if (invalid) return { kind: "invalid", name: invalid[1], version: invalid[2], reason: "invalid-production-dependency" };
  return { kind: "unknown", reason: "unrecognized-npm-problem" };
}

function allProblems(root: NpmLsJson): string[] {
  const problems = new Set(root.problems ?? []);
  const visit = (name: string, node: NpmLsDependencyNode, packagePath: string) => {
    for (const problem of node.problems ?? []) problems.add(problem);
    if (node.extraneous === true) problems.add(`extraneous: ${name}@${node.version ?? "unknown"} ${packagePath}`);
    if (node.missing === true) problems.add(`missing: ${name}@${node.version ?? "unknown"}, required by npm-ls-tree`);
    if (node.invalid === true) problems.add(`invalid: ${name}@${node.version ?? "unknown"} ${packagePath}`);
    for (const [childName, child] of Object.entries(node.dependencies ?? {})) {
      visit(childName, child, `${packagePath}/node_modules/${childName}`);
    }
  };
  for (const [name, node] of Object.entries(root.dependencies ?? {})) visit(name, node, packageKey(name));
  return [...problems];
}

/**
 * `npm ls` 退出 0 并不代表 JSON `problems` 为空。本门禁只接受 lockfile 中
 * 可从直接生产依赖沿 optional 链证明、且 installed/lock exact version 一致的
 * hoisted extraneous；missing/invalid/未知问题一律失败关闭。
 */
export function assertNpmProductionDependencyHealth(
  npmLs: NpmLsJson,
  lockfile: PackageLockJson,
): NpmProductionDependencyHealthSummary {
  const optional = reachableOptionalPackages(lockfile);
  const installedNodes = npmLsNodesByPackagePath(npmLs);
  const acceptedOptionalProblems: AcceptedOptionalProductionProblem[] = [];
  const rejectedProblems: RejectedProductionProblem[] = [];
  const problems = new Map<string, RejectedProductionProblem>();
  for (const problem of allProblems(npmLs)) {
    const parsed = sanitizedProblem(problem);
    const key = `${parsed.kind}:${parsed.name ?? ""}:${parsed.version ?? ""}:${parsed.reason}`;
    problems.set(key, parsed);
  }

  for (const parsed of problems.values()) {
    if (parsed.kind !== "extraneous" || !parsed.name || !parsed.version) {
      rejectedProblems.push(parsed);
      continue;
    }
    const packagePath = parsed.reason === "missing-package-path" ? undefined : parsed.reason;
    const proof = packagePath ? optional.get(packagePath) : undefined;
    const installed = packagePath ? installedNodes.get(packagePath) : undefined;
    const lockEntry = packagePath ? lockfile.packages?.[packagePath] : undefined;
    if (!proof
      || packageNameAtPath(proof.packagePath) !== parsed.name
      || installed?.extraneous !== true
      || installed.version !== parsed.version
      || lockEntry?.version !== parsed.version
      || lockEntry.optional !== true) {
      rejectedProblems.push(parsed);
      continue;
    }
    acceptedOptionalProblems.push({
      name: parsed.name,
      version: parsed.version,
      rootDependency: proof.rootDependency,
      dependencyPath: proof.dependencyPath,
      reason: "lockfile-optional-chain",
    });
  }

  acceptedOptionalProblems.sort((left, right) => left.name.localeCompare(right.name, "en"));
  rejectedProblems.sort((left, right) => `${left.kind}:${left.name ?? ""}`.localeCompare(`${right.kind}:${right.name ?? ""}`, "en"));
  if (rejectedProblems.length > 0) {
    throw new Error(`生产依赖树包含未获 lockfile optional 证明的问题：${JSON.stringify(rejectedProblems)}`);
  }
  return {
    schemaVersion: 1,
    status: "passed",
    problemCount: problems.size,
    acceptedOptionalProblems,
    rejectedProblems,
  };
}
