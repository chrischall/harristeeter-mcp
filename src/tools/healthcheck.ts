import type { McpServer } from '@modelcontextprotocol/server';
import { registerBridgeHealthcheckTool } from '@chrischall/mcp-utils/fetchproxy';
import type { HtClient } from '../client.js';
import type { FetchproxyTransport } from '../transport-fetchproxy.js';

export function registerHealthcheckTools(server: McpServer, client: HtClient, transport: FetchproxyTransport): void {
  registerBridgeHealthcheckTool({
    server,
    prefix: 'ht',
    // robots.txt is cheap and needs no session, so a failure here means the
    // bridge (or the tab), not the account.
    probePath: '/robots.txt',
    hostLabel: 'www.harristeeter.com',
    transport,
    probeFn: (path) => client.fetchText(path),
  });
}
