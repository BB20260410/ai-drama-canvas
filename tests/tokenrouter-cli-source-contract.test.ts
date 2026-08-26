import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("TokenRouter Cloud CLI 源码合同", () => {
  it("只打 TokenRouter，不写官方千问 / 火山 / OpenAI，不含密钥字面量", () => {
    const files = [
      "scripts/tokenrouter/tr_chat",
      "scripts/tokenrouter/novel_chat.py",
      "scripts/install-tokenrouter-cli.sh",
    ];
    for (const file of files) {
      const text = source(file);
      expect(text, file).toContain("api.tokenrouter.com");
      expect(text, file).toContain("TOKENROUTER_API_KEY");
      expect(text, file).not.toContain("dashscope.aliyuncs.com");
      expect(text, file).not.toContain("volces.com");
      expect(text, file).not.toContain("api.openai.com");
      expect(text, file).not.toMatch(/sk-[A-Za-z0-9]{10,}/u);
      expect(text, file).not.toMatch(/Bearer [A-Za-z0-9._-]{16,}/u);
    }
    expect(source("scripts/tokenrouter/tr_chat")).toContain("qwen/qwen3.8-max-free");
    expect(source("scripts/tokenrouter/novel_chat.py")).toContain('--role tr');
    expect(source("scripts/install-tokenrouter-cli.sh")).toContain('"$dest/tr_chat"');
  });

  it("Cloud 引导不要求 TokenRouter Key，且缺脚本时仍可 npm ci", () => {
    const text = source("scripts/cloud-agent-install.sh");
    expect(text).toContain("npm ci");
    expect(text).toContain("install-tokenrouter-cli.sh");
    expect(text).toContain("不要求 TOKENROUTER_API_KEY");
    expect(text).toMatch(/if \[\[ -f scripts\/install-tokenrouter-cli\.sh \]\]/u);
  });
});
