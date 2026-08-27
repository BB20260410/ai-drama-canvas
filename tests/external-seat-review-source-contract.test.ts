import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("外部席审查脚本源码合同", () => {
  it("只打已接通的 Token Plan / Agent Plan，不含密钥，不拆红线", () => {
    const text = source("scripts/external-seat-review.py");
    expect(text).toContain("https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions");
    expect(text).toContain("https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect(text).toContain("qwen3.8-max-preview");
    expect(text).toContain("glm-5.3");
    expect(text).toContain("deepseek-v4-pro");
    expect(text).toContain("不要按 DeepSeek 去拆 command-bus ledger");
    expect(text).toContain('DEFAULT_SEATS = ["glm", "deepseek", "qwen"]');
    expect(text).toContain("--seats");
    expect(text).toContain("--with-doubao");
    expect(text).toContain("QWEN_TOKEN_PLAN_API_KEY");
    expect(text).toContain("ARK_API_KEY");
    expect(text).toContain("429");
    expect(text).not.toContain("dashscope.aliyuncs.com");
    expect(text).not.toContain("api.openai.com");
    expect(text).not.toContain("api.tokenrouter.com");
    expect(text).not.toContain("/api/coding/v3");
    expect(text).not.toContain("token-plan.ap-southeast-1");
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{10,}/u);
    expect(text).not.toMatch(/ark-[0-9a-f-]{8,}/u);
    expect(text).not.toMatch(/Bearer [A-Za-z0-9._-]{16,}/u);
  });

  it("TokenRouter 包仍只打 tokenrouter.com，不混方舟/千问官方入口", () => {
    const files = [
      "scripts/tokenrouter/tr_chat",
      "scripts/tokenrouter/novel_chat.py",
      "scripts/install-tokenrouter-cli.sh",
    ];
    for (const file of files) {
      const text = source(file);
      expect(text, file).toContain("api.tokenrouter.com");
      expect(text, file).not.toContain("volces.com");
      expect(text, file).not.toContain("aliyuncs.com");
      expect(text, file).not.toContain("external-seat-review");
    }
  });
});
