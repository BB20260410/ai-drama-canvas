import type { StudioPublicCommandRequest } from "../../core/studio-command-runtime.js";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

/**
 * requestId 区分每次 IPC 尝试；idempotencyKey 只由命令语义决定。
 * 因此响应丢失后的同 revision 重试会回放同一 durable outcome。
 */
export async function createStudioCommandEnvelope(request: StudioPublicCommandRequest) {
  const requestBytes = new TextEncoder().encode(JSON.stringify(stableValue(request)));
  const fingerprint = [...new Uint8Array(await crypto.subtle.digest("SHA-256", requestBytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return {
    requestId: `ui-studio-${crypto.randomUUID()}`,
    idempotencyKey: `ui-studio-${request.command}-${fingerprint.slice(0, 48)}`,
    request,
  };
}
