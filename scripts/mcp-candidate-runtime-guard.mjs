import { realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = realpathSync.native(path.dirname(fileURLToPath(import.meta.url)));

function isInsideOrEqual(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === ""
    || (relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}

function rejectResolution(specifier, resolvedUrl) {
  const error = new Error(`MCP runtime 模块解析逃逸候选闭包：${specifier} -> ${resolvedUrl}`);
  error.code = "ERR_AI_CANVAS_RUNTIME_IMPORT_ESCAPE";
  throw error;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (resolved.url.startsWith("node:")) return resolved;
    if (!resolved.url.startsWith("file:")) return rejectResolution(specifier, resolved.url);
    const target = realpathSync.native(fileURLToPath(resolved.url));
    if (!isInsideOrEqual(runtimeRoot, target)) return rejectResolution(specifier, resolved.url);
    return resolved;
  },
});
