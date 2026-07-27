import path from "node:path";
import { fileURLToPath } from "node:url";
import { countDeclaredMcpTools } from "../../src/core/release-manifest.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** 当前源码注册的 MCP 工具数；禁止测试复制历史常量。 */
export const EXPECTED_MCP_TOOL_COUNT = await countDeclaredMcpTools(workspace);
