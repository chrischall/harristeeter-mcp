#!/usr/bin/env node
// harristeeter-mcp entrypoint.
//
//   1. Construct a FetchproxyTransport on 127.0.0.1:37149 — the port the whole
//      fetchproxy fleet shares, which the ContextMint Bridge extension dials.
//   2. client.start() loads the bridge identity BEFORE runMcp connects stdio.
//   3. runMcp registers the tools, prints the banner and connects stdio.
//
// No credentials: every call rides the user's signed-in harristeeter.com tab.

import { runMcp, readPortEnv } from '@chrischall/mcp-utils';
import { VERSION } from './version.js';
import { HtClient } from './client.js';
import { FetchproxyTransport, DEFAULT_PORT } from './transport-fetchproxy.js';
import { registerProductTools } from './tools/products.js';
import { registerCartTools } from './tools/cart.js';
import { registerCheckoutTools } from './tools/checkout.js';
import { registerOrderTools } from './tools/orders.js';
import { registerHealthcheckTools } from './tools/healthcheck.js';

const port = readPortEnv('HARRISTEETER_WS_PORT', DEFAULT_PORT);
const transport = new FetchproxyTransport({ port, version: VERSION });
const client = new HtClient({ transport });
await client.start();

await runMcp({
  name: 'harristeeter-mcp',
  version: VERSION,
  deps: client,
  tools: [
    (server) => registerProductTools(server, client),
    (server) => registerCartTools(server, client),
    (server) => registerCheckoutTools(server, client),
    (server) => registerOrderTools(server, client),
    (server) => registerHealthcheckTools(server, client, transport),
  ],
  banner:
    `[harristeeter-mcp] v${VERSION} — talks to harristeeter.com through the user's signed-in browser tab via the ` +
    `fetchproxy bridge on 127.0.0.1:${port}. Install the ContextMint Bridge extension ` +
    '(https://github.com/nullnet-app/contextmint-bridge/releases) and keep a signed-in harristeeter.com tab open. ' +
    'This project was developed and is maintained by AI (Claude). Use at your own discretion.',
  shutdown: { onSignal: () => client.close() },
});
