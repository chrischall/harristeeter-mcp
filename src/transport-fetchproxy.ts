// Adapter letting @fetchproxy/server satisfy HtTransport.
//
// harristeeter.com runs on Kroger's web platform behind Akamai Bot Manager: a
// server-side request does not even get an HTTP response (the edge resets the
// HTTP/2 stream, on `/` as much as on the API). Every call therefore runs
// inside the user's own signed-in tab, which has already cleared the edge and
// carries the session cookies. There is no server-side fallback to offer.
//
// The verb surface (fetch / runProbe / status / start / close) comes from the
// shared `createFetchproxyTransport` in @chrischall/mcp-utils/fetchproxy.

import {
  createFetchproxyTransport,
  type FetchproxyTransport as FetchproxyVerbTransport,
} from '@chrischall/mcp-utils/fetchproxy';
import type { HtTransport, FetchInit, FetchResult } from './transport.js';

/**
 * The whole fetchproxy fleet shares this concentrator port — the ContextMint
 * Bridge extension dials this one port and servers host/peer-elect on it.
 * Picking a "unique" port means the extension never connects.
 */
export const DEFAULT_PORT = 37_149;

const DEBUG = process.env.HARRISTEETER_DEBUG === '1';

function log(...args: unknown[]): void {
  if (DEBUG) console.error('[harristeeter-mcp:bridge]', ...args);
}

export interface FetchproxyTransportOptions {
  port?: number;
  /** MCP server name announced to the extension. */
  server?: string;
  version: string;
  fetchTimeoutMs?: number;
}

export class FetchproxyTransport implements HtTransport {
  private readonly inner: FetchproxyVerbTransport;
  private readonly port: number;

  constructor(opts: FetchproxyTransportOptions) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.inner = createFetchproxyTransport<FetchproxyVerbTransport>({
      port: this.port,
      serverName: opts.server ?? 'harristeeter-mcp',
      version: opts.version,
      logListening: true,
      domains: ['harristeeter.com'],
      defaultSubdomain: 'www',
      ...(opts.fetchTimeoutMs !== undefined ? { fetchTimeoutMs: opts.fetchTimeoutMs } : {}),
    });
  }

  async start(): Promise<void> {
    log('listen start', { port: this.port });
    await this.inner.start();
  }

  async close(): Promise<void> {
    log('close');
    return this.inner.close();
  }

  status(): ReturnType<FetchproxyVerbTransport['status']> {
    return this.inner.status();
  }

  async fetch(init: FetchInit): Promise<FetchResult> {
    const start = Date.now();
    log('fetch:start', { method: init.method, path: init.path.split('?')[0] });
    const response = await this.inner.fetch({
      method: init.method,
      path: init.path,
      headers: init.headers,
      body: init.body,
    });
    log('fetch:done', { path: init.path.split('?')[0], elapsed: Date.now() - start, status: response.status });
    return { status: response.status, body: response.body, url: response.url };
  }

  async runProbe(
    fetchFn: (path: string) => Promise<string>,
    probePath: string
  ): ReturnType<FetchproxyVerbTransport['runProbe']> {
    return this.inner.runProbe(fetchFn, probePath);
  }
}
