import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

export type NovelAnalysisTransportErrorCode =
  | "NOVEL_PROVIDER_DNS_FAILED"
  | "NOVEL_PROVIDER_PRIVATE_NETWORK_DENIED"
  | "NOVEL_PROVIDER_PUBLIC_CLEARTEXT_DENIED"
  | "NOVEL_PROVIDER_PIN_MISMATCH"
  | "NOVEL_PROVIDER_REDIRECT_DENIED"
  | "NOVEL_PROVIDER_TLS_FAILED"
  | "NOVEL_PROVIDER_TIMEOUT"
  | "NOVEL_PROVIDER_RESPONSE_TOO_LARGE"
  | "NOVEL_PROVIDER_NETWORK_FAILED";

export class NovelAnalysisTransportError extends Error {
  readonly code: NovelAnalysisTransportErrorCode;

  constructor(code: NovelAnalysisTransportErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NovelAnalysisTransportError";
    this.code = code;
  }
}

export interface NovelAnalysisPinnedAddress {
  address: string;
  family: 4 | 6;
  scope: "public" | "non-public";
}

export interface PinnedTarget {
  origin: string;
  hostname: string;
  addresses: readonly NovelAnalysisPinnedAddress[];
}

export type NovelAnalysisAddressResolver = (hostname: string) => Promise<readonly { address: string; family: 4 | 6 }[]>;

export interface NovelAnalysisPinnedRequest {
  providerName: string;
  url: URL;
  target: PinnedTarget;
  method: "GET" | "POST";
  bearerToken?: string;
  body?: string;
  timeoutMs: number;
  maxResponseBytes: number;
  maxErrorResponseBytes?: number;
}

export interface NovelAnalysisPinnedResponse {
  status: number;
  statusText: string;
  text: string;
}

const nonPublicIpv4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) nonPublicIpv4.addSubnet(network, prefix, "ipv4");

const nonPublicIpv6 = new BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fec0::", 10],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) nonPublicIpv6.addSubnet(network, prefix, "ipv6");

const globallyRoutableIpv6 = new BlockList();
globallyRoutableIpv6.addSubnet("2000::", 3, "ipv6");

function normalizedHostname(value: string): string {
  let hostname = value.trim().toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1);
  const zoneIndex = hostname.indexOf("%");
  if (zoneIndex >= 0) hostname = hostname.slice(0, zoneIndex);
  return hostname;
}

function expandIpv6(address: string): number[] | undefined {
  let value = normalizedHostname(address);
  const dottedTail = value.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dottedTail) {
    if (isIP(dottedTail) !== 4) return undefined;
    const parts = dottedTail.split(".").map(Number);
    const high = ((parts[0] ?? 0) << 8) | (parts[1] ?? 0);
    const low = ((parts[2] ?? 0) << 8) | (parts[3] ?? 0);
    value = `${value.slice(0, value.length - dottedTail.length)}${high.toString(16)}:${low.toString(16)}`;
  }
  if (value.split("::").length > 2) return undefined;
  const [leftText, rightText] = value.split("::");
  const left = leftText ? leftText.split(":") : [];
  const right = rightText ? rightText.split(":") : [];
  const missing = value.includes("::") ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return undefined;
  return groups.map((group) => Number.parseInt(group, 16));
}

function embeddedIpv4(address: string): string | undefined {
  const groups = expandIpv6(address);
  if (!groups) return undefined;
  const compatible = groups.slice(0, 5).every((group) => group === 0) && (groups[5] === 0 || groups[5] === 0xffff);
  if (!compatible) return undefined;
  const high = groups[6] ?? 0;
  const low = groups[7] ?? 0;
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

export function isNonPublicNovelAnalysisAddress(address: string): boolean {
  const normalized = normalizedHostname(address);
  const family = isIP(normalized);
  if (family === 4) return nonPublicIpv4.check(normalized, "ipv4");
  if (family === 6) {
    const mapped = embeddedIpv4(normalized);
    return mapped
      ? isNonPublicNovelAnalysisAddress(mapped)
      : !globallyRoutableIpv6.check(normalized, "ipv6") || nonPublicIpv6.check(normalized, "ipv6");
  }
  throw new NovelAnalysisTransportError("NOVEL_PROVIDER_DNS_FAILED", "模型服务返回了无效 IP 地址。");
}

function isLocalHostname(hostname: string): boolean {
  const normalized = normalizedHostname(hostname);
  return normalized === "localhost" || normalized.endsWith(".localhost");
}

export function assertNovelAnalysisStaticUrlPolicy(url: URL, allowPrivateNetwork: boolean): void {
  const hostname = normalizedHostname(url.hostname);
  const family = isIP(hostname);
  const literalIsNonPublic = family !== 0 && isNonPublicNovelAnalysisAddress(hostname);
  const knownLocal = isLocalHostname(hostname) || literalIsNonPublic;

  if (knownLocal && !allowPrivateNetwork) {
    throw new NovelAnalysisTransportError(
      "NOVEL_PROVIDER_PRIVATE_NETWORK_DENIED",
      "模型服务指向本机或私网；必须显式开启“允许本机/私网”。",
    );
  }
  if (url.protocol === "http:" && (!allowPrivateNetwork || (family !== 0 && !literalIsNonPublic))) {
    throw new NovelAnalysisTransportError(
      "NOVEL_PROVIDER_PUBLIC_CLEARTEXT_DENIED",
      "公网小说分析 Provider 必须使用 HTTPS；HTTP 仅允许显式授权的本机或私网服务。",
    );
  }
}

const defaultResolver: NovelAnalysisAddressResolver = async (hostname) => {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.flatMap((entry) => entry.family === 4 || entry.family === 6
    ? [{ address: entry.address, family: entry.family }]
    : []);
};

let resolverForTests: NovelAnalysisAddressResolver | undefined;

export function __setNovelAnalysisAddressResolverForTests(resolver?: NovelAnalysisAddressResolver): void {
  if (process.env.NODE_ENV !== "test") throw new Error("小说分析地址解析测试注入只允许在测试环境使用。");
  resolverForTests = resolver;
}

export async function prepareNovelAnalysisPinnedTarget(
  url: URL,
  allowPrivateNetwork: boolean,
  resolver?: NovelAnalysisAddressResolver,
): Promise<PinnedTarget> {
  assertNovelAnalysisStaticUrlPolicy(url, allowPrivateNetwork);
  const hostname = normalizedHostname(url.hostname);
  const literalFamily = isIP(hostname);
  let resolved: readonly { address: string; family: 4 | 6 }[];
  if (literalFamily === 4 || literalFamily === 6) {
    resolved = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      resolved = await (resolver ?? resolverForTests ?? defaultResolver)(hostname);
    } catch (error) {
      throw new NovelAnalysisTransportError("NOVEL_PROVIDER_DNS_FAILED", "无法解析模型服务域名。", { cause: error });
    }
  }

  const unique = new Map<string, NovelAnalysisPinnedAddress>();
  for (const entry of resolved) {
    const address = normalizedHostname(entry.address);
    const family = isIP(address);
    if ((family !== 4 && family !== 6) || family !== entry.family) {
      throw new NovelAnalysisTransportError("NOVEL_PROVIDER_DNS_FAILED", "模型服务返回了无效 IP 地址。");
    }
    const scope = isNonPublicNovelAnalysisAddress(address) ? "non-public" : "public";
    unique.set(`${family}:${address}`, { address, family, scope });
  }
  const addresses = [...unique.values()];
  if (!addresses.length) throw new NovelAnalysisTransportError("NOVEL_PROVIDER_DNS_FAILED", "模型服务域名没有可用地址。");

  const includesPrivate = addresses.some((entry) => entry.scope === "non-public");
  const includesPublic = addresses.some((entry) => entry.scope === "public");
  if (includesPrivate && !allowPrivateNetwork) {
    throw new NovelAnalysisTransportError(
      "NOVEL_PROVIDER_PRIVATE_NETWORK_DENIED",
      "模型服务域名解析到本机或私网；必须显式开启“允许本机/私网”。",
    );
  }
  if (url.protocol === "http:" && (!allowPrivateNetwork || includesPublic)) {
    throw new NovelAnalysisTransportError(
      "NOVEL_PROVIDER_PUBLIC_CLEARTEXT_DENIED",
      "公网小说分析 Provider 必须使用 HTTPS；HTTP 仅允许显式授权且全部地址均为本机或私网的服务。",
    );
  }

  return Object.freeze({
    origin: url.origin,
    hostname,
    addresses: Object.freeze(addresses.map((entry) => Object.freeze({ ...entry }))),
  });
}

function requestedFamily(value: unknown): 4 | 6 | undefined {
  if (value === 4 || value === "IPv4") return 4;
  if (value === 6 || value === "IPv6") return 6;
  return undefined;
}

function pinnedLookup(target: PinnedTarget): LookupFunction {
  return (hostname, options, callback) => {
    if (normalizedHostname(hostname) !== target.hostname) {
      callback(new NovelAnalysisTransportError("NOVEL_PROVIDER_PIN_MISMATCH", "模型服务连接目标与已校验地址不一致。"), "", 0);
      return;
    }
    const family = requestedFamily(options.family);
    const candidates = family ? target.addresses.filter((entry) => entry.family === family) : [...target.addresses];
    if (!candidates.length) {
      callback(new NovelAnalysisTransportError("NOVEL_PROVIDER_PIN_MISMATCH", "模型服务没有匹配连接族的已校验地址。"), "", 0);
      return;
    }
    if (options.all) {
      callback(null, candidates.map(({ address, family: candidateFamily }) => ({ address, family: candidateFamily })));
      return;
    }
    const candidate = candidates[0]!;
    callback(null, candidate.address, candidate.family);
  };
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const direct = "code" in error && typeof error.code === "string" ? error.code : "";
  if (direct) return direct;
  return "cause" in error ? errorCode(error.cause) : "";
}

function normalizedTransportError(error: unknown): NovelAnalysisTransportError {
  if (error instanceof NovelAnalysisTransportError) return error;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new NovelAnalysisTransportError("NOVEL_PROVIDER_TIMEOUT", "模型服务请求超时。", { cause: error });
  }
  const code = errorCode(error);
  if (code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_") || code.startsWith("ERR_OSSL_") || code.startsWith("CERT_") || [
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_GET_ISSUER_CERT",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  ].includes(code)) {
    return new NovelAnalysisTransportError("NOVEL_PROVIDER_TLS_FAILED", "模型服务 TLS 连接或证书校验失败。", { cause: error });
  }
  return new NovelAnalysisTransportError("NOVEL_PROVIDER_NETWORK_FAILED", "模型服务网络连接失败。", { cause: error });
}

async function readBoundedResponse(response: Awaited<ReturnType<typeof undiciFetch>>, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new NovelAnalysisTransportError("NOVEL_PROVIDER_RESPONSE_TOO_LARGE", `模型响应超过 ${maxBytes} 字节上限。`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new NovelAnalysisTransportError("NOVEL_PROVIDER_RESPONSE_TOO_LARGE", `模型响应超过 ${maxBytes} 字节上限。`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function requestPinnedNovelAnalysisText(input: NovelAnalysisPinnedRequest): Promise<NovelAnalysisPinnedResponse> {
  if (input.url.origin !== input.target.origin || normalizedHostname(input.url.hostname) !== input.target.hostname) {
    throw new NovelAnalysisTransportError("NOVEL_PROVIDER_PIN_MISMATCH", "模型服务请求地址与已校验目标不一致。");
  }
  const agent = new Agent({
    connections: 1,
    pipelining: 1,
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 250,
    connect: {
      lookup: pinnedLookup(input.target),
      // 不继承 NODE_TLS_REJECT_UNAUTHORIZED=0 等宿主级降级；小说正文通道始终验签。
      rejectUnauthorized: true,
    },
  });
  let completed = false;
  try {
    const response = await undiciFetch(input.url, {
      method: input.method,
      headers: {
        accept: "application/json",
        ...(input.method === "POST" ? { "content-type": "application/json" } : {}),
        ...(input.bearerToken ? { authorization: `Bearer ${input.bearerToken}` } : {}),
      },
      ...(input.body !== undefined ? { body: input.body } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(input.timeoutMs),
      dispatcher: agent,
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new NovelAnalysisTransportError(
        "NOVEL_PROVIDER_REDIRECT_DENIED",
        `${input.providerName} 返回重定向 ${response.status}；为防止正文或凭据外泄，必须直接配置最终同源地址。`,
      );
    }
    const limit = response.ok ? input.maxResponseBytes : (input.maxErrorResponseBytes ?? 2_000);
    const text = await readBoundedResponse(response, limit);
    completed = true;
    return { status: response.status, statusText: response.statusText, text };
  } catch (error) {
    try {
      await agent.destroy(error instanceof Error ? error : null);
    } catch {
      // 原始请求错误优先；Agent 已进入 destroyed 状态，清理错误不能覆盖根因。
    }
    throw normalizedTransportError(error);
  } finally {
    if (completed) await agent.close();
  }
}
