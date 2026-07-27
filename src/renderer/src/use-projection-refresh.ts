/**
 * Qwen D2 · 投影刷新控制器（多流 token）
 *
 * 从驾驶舱/画布加载控制器抽象：同 stream 递增 seq；切工程 invalidate。
 * 不持有 nextAction；不写账本。
 */

export interface ProjectionLoadController<Stream extends string> {
  begin(stream: Stream, fingerprint: string): string;
  isCurrent(token: string, stream?: Stream): boolean;
  invalidate(): void;
  invalidateStream(stream: Stream): void;
}

/**
 * @param streamOf 从请求对象推导 stream 键
 * @param fingerprintOf 从请求对象推导内容指纹（含 projectRoot）
 */
export function createProjectionLoadController<Stream extends string, Query>(
  streamOf: (query: Query) => Stream,
  fingerprintOf: (projectRoot: string, query: Query) => string,
): ProjectionLoadController<Stream> & {
  beginQuery(projectRoot: string, query: Query): string;
  isCurrentQuery(token: string, query?: Query): boolean;
} {
  const activeByStream = new Map<Stream, string>();
  const seqByStream = new Map<Stream, number>();
  let generation = 0;

  const begin = (stream: Stream, fingerprint: string): string => {
    const seq = (seqByStream.get(stream) ?? 0) + 1;
    seqByStream.set(stream, seq);
    const token = `${generation}\u0000${seq}\u0000${fingerprint}`;
    activeByStream.set(stream, token);
    return token;
  };

  const isCurrent = (token: string, stream?: Stream): boolean => {
    if (stream) return activeByStream.get(stream) === token;
    for (const active of activeByStream.values()) {
      if (active === token) return true;
    }
    return false;
  };

  return {
    begin,
    isCurrent,
    invalidate(): void {
      generation += 1;
      activeByStream.clear();
      seqByStream.clear();
    },
    invalidateStream(stream: Stream): void {
      activeByStream.delete(stream);
    },
    beginQuery(projectRoot: string, query: Query): string {
      return begin(streamOf(query), fingerprintOf(projectRoot, query));
    },
    isCurrentQuery(token: string, query?: Query): boolean {
      if (query) return isCurrent(token, streamOf(query));
      return isCurrent(token);
    },
  };
}
