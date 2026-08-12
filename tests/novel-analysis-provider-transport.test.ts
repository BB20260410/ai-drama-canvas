import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { Server as NetServer } from "node:net";
import path from "node:path";
import type { TLSSocket } from "node:tls";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  NovelAnalysisTransportError,
  isNonPublicNovelAnalysisAddress,
  prepareNovelAnalysisPinnedTarget,
  requestPinnedNovelAnalysisText,
} from "../src/core/novel-analysis-transport.js";

const execFileAsync = promisify(execFile);
const servers: NetServer[] = [];
const savedProxyEnvironment = {
  HTTP_PROXY: process.env.HTTP_PROXY,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  ALL_PROXY: process.env.ALL_PROXY,
  NO_PROXY: process.env.NO_PROXY,
  NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY,
};

afterEach(async () => {
  for (const key of Object.keys(savedProxyEnvironment) as Array<keyof typeof savedProxyEnvironment>) {
    const value = savedProxyEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未监听 TCP 端口");
  return { server, port: address.port };
}

async function connectionCount(server: NetServer): Promise<number> {
  return new Promise<number>((resolve, reject) => server.getConnections((error, count) => error ? reject(error) : resolve(count)));
}

async function expectConnectionsClosed(server: NetServer): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (await connectionCount(server)) {
    if (Date.now() >= deadline) throw new Error("安全传输请求结束后仍有 TCP 连接未关闭");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("小说分析 Provider 安全传输", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "240.0.0.1",
    "[::1]",
    "fd00::1",
    "fec0::1",
    "fe80::1%en0",
    "ff00::1",
    "2001:db8::1",
    "100:0:0:1::1",
    "400::1",
    "3fff::1",
    "4000::1",
    "5f00::1",
    "fe00::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:7f00:1",
  ])("将非公网、映射和保留地址 %s 统一判为 non-public", (address) => {
    expect(isNonPublicNovelAnalysisAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"])("保留公网地址 %s", (address) => {
    expect(isNonPublicNovelAnalysisAddress(address)).toBe(false);
  });

  it("公网 HTTP 无论是否打开私网开关都失败关闭", async () => {
    await expect(prepareNovelAnalysisPinnedTarget(new URL("http://93.184.216.34/v1"), false)).rejects.toMatchObject({
      code: "NOVEL_PROVIDER_PUBLIC_CLEARTEXT_DENIED",
    });
    await expect(prepareNovelAnalysisPinnedTarget(new URL("http://public-provider.test/v1"), true, async () => [
      { address: "93.184.216.34", family: 4 },
    ])).rejects.toMatchObject({ code: "NOVEL_PROVIDER_PUBLIC_CLEARTEXT_DENIED" });
  });

  it("混合公网与私网地址在公网模式下整体拒绝", async () => {
    await expect(prepareNovelAnalysisPinnedTarget(new URL("https://mixed-provider.test/v1"), false, async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ])).rejects.toMatchObject({ code: "NOVEL_PROVIDER_PRIVATE_NETWORK_DENIED" });
  });

  it("空或非法 DNS 响应均失败关闭", async () => {
    await expect(prepareNovelAnalysisPinnedTarget(new URL("https://empty-dns.test/v1"), false, async () => []))
      .rejects.toMatchObject({ code: "NOVEL_PROVIDER_DNS_FAILED" });
    await expect(prepareNovelAnalysisPinnedTarget(new URL("https://invalid-dns.test/v1"), false, async () => [
      { address: "not-an-ip", family: 4 },
    ])).rejects.toMatchObject({ code: "NOVEL_PROVIDER_DNS_FAILED" });
    await expect(prepareNovelAnalysisPinnedTarget(new URL("https://family-mismatch.test/v1"), false, async () => [
      { address: "93.184.216.34", family: 6 },
    ])).rejects.toMatchObject({ code: "NOVEL_PROVIDER_DNS_FAILED" });
  });

  it("私网 HTTP 显式授权后单次解析并绑定连接，同时忽略环境代理", async () => {
    let providerRequests = 0;
    let proxyRequests = 0;
    let observedHost = "";
    let observedAuthorization = "";
    let observedBody = "";
    const provider = await listen(async (request, response) => {
      providerRequests += 1;
      observedHost = String(request.headers.host ?? "");
      observedAuthorization = String(request.headers.authorization ?? "");
      for await (const chunk of request) observedBody += chunk.toString();
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });
    const proxy = await listen((_request, response) => {
      proxyRequests += 1;
      response.statusCode = 502;
      response.end();
    });
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;
    process.env.HTTP_PROXY = proxyUrl;
    process.env.HTTPS_PROXY = proxyUrl;
    process.env.ALL_PROXY = proxyUrl;
    process.env.NO_PROXY = "";
    process.env.NODE_USE_ENV_PROXY = "1";

    let resolverCalls = 0;
    const url = new URL(`http://private-provider.test:${provider.port}/v1/chat/completions`);
    const target = await prepareNovelAnalysisPinnedTarget(url, true, async () => {
      resolverCalls += 1;
      return [{ address: "127.0.0.1", family: 4 }];
    });
    const result = await requestPinnedNovelAnalysisText({
      providerName: "本机模型",
      url,
      target,
      method: "POST",
      bearerToken: "test-secret",
      body: JSON.stringify({ prompt: "正文" }),
      timeoutMs: 5_000,
      maxResponseBytes: 10_000,
    });

    expect(JSON.parse(result.text)).toEqual({ ok: true });
    expect(resolverCalls).toBe(1);
    expect(providerRequests).toBe(1);
    expect(proxyRequests).toBe(0);
    expect(observedHost).toBe(`private-provider.test:${provider.port}`);
    expect(observedAuthorization).toBe("Bearer test-secret");
    expect(observedBody).toContain("正文");
    await expectConnectionsClosed(provider.server);
  });

  it("DNS 解析到私网时在建连前拒绝，服务收不到凭据或正文", async () => {
    let received = 0;
    const trap = await listen((_request, response) => {
      received += 1;
      response.end();
    });
    const url = new URL(`https://rebind-provider.test:${trap.port}/v1/chat/completions`);
    await expect(prepareNovelAnalysisPinnedTarget(url, false, async () => [
      { address: "127.0.0.1", family: 4 },
    ])).rejects.toMatchObject({ code: "NOVEL_PROVIDER_PRIVATE_NETWORK_DENIED" });
    expect(received).toBe(0);
  });

  it("连接 lookup 只消费冻结快照，不再调用系统解析器", async () => {
    let resolverCalls = 0;
    let received = 0;
    const provider = await listen((_request, response) => {
      received += 1;
      response.end("{}");
    });
    const url = new URL(`http://single-lookup.test:${provider.port}/v1/models`);
    const target = await prepareNovelAnalysisPinnedTarget(url, true, async () => {
      resolverCalls += 1;
      return [{ address: "127.0.0.1", family: 4 }];
    });
    await requestPinnedNovelAnalysisText({ providerName: "测试", url, target, method: "GET", timeoutMs: 5_000, maxResponseBytes: 1_000 });
    expect(resolverCalls).toBe(1);
    expect(received).toBe(1);
  });

  it("拒绝 301/302/307/308 且不访问任何 Location 目标", async () => {
    let redirectedRequests = 0;
    const redirected = await listen((_request, response) => {
      redirectedRequests += 1;
      response.end("should-not-run");
    });
    const origin = await listen((request, response) => {
      response.statusCode = Number(new URL(request.url ?? "/307", "http://origin.test").pathname.slice(1));
      response.setHeader("location", `http://127.0.0.1:${redirected.port}/stolen`);
      response.end();
    });
    for (const status of [301, 302, 307, 308]) {
      const url = new URL(`http://private-provider.test:${origin.port}/${status}`);
      const target = await prepareNovelAnalysisPinnedTarget(url, true, async () => [{ address: "127.0.0.1", family: 4 }]);
      await expect(requestPinnedNovelAnalysisText({
        providerName: "测试",
        url,
        target,
        method: "POST",
        bearerToken: "must-not-forward",
        body: "secret-story",
        timeoutMs: 5_000,
        maxResponseBytes: 1_000,
      })).rejects.toMatchObject({ code: "NOVEL_PROVIDER_REDIRECT_DENIED" });
    }
    expect(redirectedRequests).toBe(0);
  });

  it("响应超限后销毁连接并返回稳定错误码", async () => {
    const provider = await listen((_request, response) => {
      response.setHeader("content-length", "10000");
      response.end("x".repeat(10_000));
    });
    const url = new URL(`http://private-provider.test:${provider.port}/v1/models`);
    const target = await prepareNovelAnalysisPinnedTarget(url, true, async () => [{ address: "127.0.0.1", family: 4 }]);
    await expect(requestPinnedNovelAnalysisText({ providerName: "测试", url, target, method: "GET", timeoutMs: 5_000, maxResponseBytes: 32 }))
      .rejects.toMatchObject({ code: "NOVEL_PROVIDER_RESPONSE_TOO_LARGE" });
    await expectConnectionsClosed(provider.server);
  });

  it("请求超时后销毁连接并返回稳定错误码", async () => {
    const provider = await listen(() => {
      // 故意不响应，用于验证 AbortSignal 超时与独立 Agent 收口。
    });
    const url = new URL(`http://private-provider.test:${provider.port}/v1/models`);
    const target = await prepareNovelAnalysisPinnedTarget(url, true, async () => [{ address: "127.0.0.1", family: 4 }]);
    await expect(requestPinnedNovelAnalysisText({
      providerName: "测试",
      url,
      target,
      method: "GET",
      timeoutMs: 100,
      maxResponseBytes: 1_000,
    })).rejects.toMatchObject({ code: "NOVEL_PROVIDER_TIMEOUT" });
    await expectConnectionsClosed(provider.server);
  });

  it("目标 origin 变化时拒绝复用地址快照", async () => {
    const target = await prepareNovelAnalysisPinnedTarget(new URL("https://provider.test/v1"), false, async () => [
      { address: "93.184.216.34", family: 4 },
    ]);
    await expect(requestPinnedNovelAnalysisText({
      providerName: "测试",
      url: new URL("https://other.test/v1"),
      target,
      method: "GET",
      timeoutMs: 100,
      maxResponseBytes: 100,
    })).rejects.toBeInstanceOf(NovelAnalysisTransportError);
  });

  it("HTTPS 使用原 hostname 作为 Host 与 SNI，并拒绝证书 hostname 不匹配", async () => {
    const certificatePath = path.resolve("tests/fixtures/novel-provider-tls-cert.fixture");
    const keyPath = path.resolve("tests/fixtures/novel-provider-tls-key.fixture");
    const [cert, key] = await Promise.all([readFile(certificatePath), readFile(keyPath)]);
    let observedHost = "";
    let observedServername = "";
    let wrongHostnameRequests = 0;
    const server = createHttpsServer({ cert, key }, (request, response) => {
      observedHost = String(request.headers.host ?? "");
      observedServername = (request.socket as TLSSocket & { servername?: string }).servername ?? "";
      if (observedHost.startsWith("wrong-provider.test")) wrongHostnameRequests += 1;
      response.setHeader("content-type", "application/json");
      response.end("{}");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TLS 测试服务未监听 TCP 端口");

    const successScript = `
      import { prepareNovelAnalysisPinnedTarget, requestPinnedNovelAnalysisText } from './src/core/novel-analysis-transport.ts';
      const url = new URL('https://provider.test:${address.port}/v1/models');
      const target = await prepareNovelAnalysisPinnedTarget(url, true, async () => [{ address: '127.0.0.1', family: 4 }]);
      const result = await requestPinnedNovelAnalysisText({ providerName: 'TLS test', url, target, method: 'GET', timeoutMs: 5000, maxResponseBytes: 1000 });
      process.stdout.write(result.text);
    `;
    const success = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", successScript], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_EXTRA_CA_CERTS: certificatePath },
      timeout: 10_000,
    });
    expect(success.stdout).toBe("{}");
    expect(observedHost).toBe(`provider.test:${address.port}`);
    expect(observedServername).toBe("provider.test");

    const mismatchScript = `
      import { prepareNovelAnalysisPinnedTarget, requestPinnedNovelAnalysisText } from './src/core/novel-analysis-transport.ts';
      const url = new URL('https://wrong-provider.test:${address.port}/v1/models');
      const target = await prepareNovelAnalysisPinnedTarget(url, true, async () => [{ address: '127.0.0.1', family: 4 }]);
      try {
        await requestPinnedNovelAnalysisText({ providerName: 'TLS test', url, target, method: 'GET', timeoutMs: 5000, maxResponseBytes: 1000 });
        process.exitCode = 2;
      } catch (error) {
        process.stdout.write(String(error?.code ?? 'missing-code'));
      }
    `;
    const mismatch = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", mismatchScript], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_EXTRA_CA_CERTS: certificatePath, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
      timeout: 10_000,
    });
    expect(mismatch.stdout).toBe("NOVEL_PROVIDER_TLS_FAILED");
    expect(wrongHostnameRequests).toBe(0);
  });

  it("HTTPS 指向明文服务时归类为 TLS 失败并关闭连接", async () => {
    const provider = await listen((_request, response) => {
      response.end("plain-http");
    });
    const url = new URL(`https://private-provider.test:${provider.port}/v1/models`);
    const target = await prepareNovelAnalysisPinnedTarget(url, true, async () => [{ address: "127.0.0.1", family: 4 }]);
    await expect(requestPinnedNovelAnalysisText({
      providerName: "测试",
      url,
      target,
      method: "GET",
      timeoutMs: 5_000,
      maxResponseBytes: 1_000,
    })).rejects.toMatchObject({ code: "NOVEL_PROVIDER_TLS_FAILED" });
    await expectConnectionsClosed(provider.server);
  });
});
