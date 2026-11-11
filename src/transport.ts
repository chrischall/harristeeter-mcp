// Transport seam. The MCP talks to harristeeter.com through this interface so
// tests can inject a stub instead of standing up a real browser bridge.
//
// `status()` and `runProbe()` are typed loosely on purpose: their concrete
// shapes belong to @fetchproxy/server (BridgeHealth / BridgeProbeResult) and
// re-declaring them here only creates two definitions that drift apart.

/** HTTP methods the bridge accepts. */
export type BridgeMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface FetchInit {
  method: BridgeMethod;
  /** Path + query on www.harristeeter.com, e.g. `/atlas/v1/carts`. */
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface FetchResult {
  status: number;
  body: string;
  url?: string;
}

export interface HtTransport {
  start(): Promise<void>;
  close(): Promise<void>;
  /** @fetchproxy/server's BridgeHealth. */
  status(): unknown;
  fetch(init: FetchInit): Promise<FetchResult>;
  /** @fetchproxy/server's BridgeProbeResult. */
  runProbe(fetchFn: (path: string) => Promise<string>, probePath: string): Promise<unknown>;
}
