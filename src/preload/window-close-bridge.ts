export interface RendererWindowCloseRequest {
  requestId: string;
}

export interface RendererWindowCloseRequestBridge {
  receive(request: RendererWindowCloseRequest): void;
  subscribe(callback: (request: RendererWindowCloseRequest) => void): () => void;
}

/**
 * preload 在 Vue 挂载前就接管主进程 close 请求。若页面 owner 尚未订阅，保留
 * 最新请求并在订阅建立时只补投一次，避免启动早期退出因 Electron IPC 不排队而丢失。
 */
export function createRendererWindowCloseRequestBridge(): RendererWindowCloseRequestBridge {
  let callback: ((request: RendererWindowCloseRequest) => void) | null = null;
  let buffered: RendererWindowCloseRequest | null = null;
  return {
    receive(request) {
      if (!request || typeof request.requestId !== "string" || !request.requestId.trim()) return;
      const normalized = { requestId: request.requestId };
      if (callback) callback(normalized);
      else buffered = normalized;
    },
    subscribe(nextCallback) {
      callback = nextCallback;
      const pending = buffered;
      buffered = null;
      if (pending) nextCallback(pending);
      return () => {
        if (callback === nextCallback) callback = null;
      };
    },
  };
}
