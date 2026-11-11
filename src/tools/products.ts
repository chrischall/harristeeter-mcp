import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { toolAnnotations } from '@chrischall/mcp-utils';
import type { HtClient } from '../client.js';
import { KrogerApi, compactApiProduct, configuredLocationId } from '../api/kroger.js';
import { toGtin13 } from '../client.js';
import { McpToolError } from '@chrischall/mcp-utils';
import { compactProduct } from '../project.js';
import { viewArg, viewResponse } from '../view.js';
import { foodMeta } from './hints.js';

const Upc = z.string().regex(/^\d{1,14}$/, 'digits only').describe('Product UPC as returned by ht_search_products (13 digits, leading zeros kept).');

/** Said in every API-path result, not only in the description: the two sources price produce differently. */
export const API_PRICE_NOTE = 'Prices from api.kroger.com: produce is priced per pound (the website prices it per item).';

/** The store the API path prices against: HARRISTEETER_LOCATION_ID, else the bridge's pickup store. */
async function apiLocation(client: HtClient): Promise<string> {
  const configured = configuredLocationId();
  if (configured) return configured;
  const fromBridge = (await client.preferences()).pickup?.locationId;
  if (!fromBridge) {
    throw new McpToolError('No store to price against.', { hint: 'Set HARRISTEETER_LOCATION_ID (find one with ht_find_stores).' });
  }
  return fromBridge;
}

export function registerProductTools(server: McpServer, client: HtClient, kroger: KrogerApi = new KrogerApi({ clientId: '', clientSecret: '' })): void {
  server.registerTool(
    'ht_search_products',
    {
      description:
        'Search Harris Teeter groceries by keyword at your pickup store — returns UPC, name, brand, size, price, sale price, unit price and pickup stock. Use the UPC with ht_add_to_cart. With Kroger API credentials set it runs without the browser (source: api.kroger.com); that API prices produce per pound where the website prices it per item.',
      annotations: toolAnnotations({ title: 'Search groceries', openWorld: true }),
      inputSchema: z.object({
        query: z.string().trim().min(1).max(200).describe('What to search for, e.g. "2% milk" or "bananas".'),
        limit: z.number().int().min(1).max(48).default(10).describe('How many results (default 10).'),
        offset: z.number().int().min(0).default(0).describe('Skip this many results, for paging.'),
        pickupOnly: z.boolean().default(true).describe('Only items available for pickup at your store (default true).'),
        view: viewArg(),
      }),
      _meta: foodMeta('lookup', { aliases: ['groceries', 'harris teeter', 'grocery search'] }),
    },
    async ({ query, limit, offset, pickupOnly, view }) => {
      if (kroger.configured) {
        // Bridge-free: Kroger's official API (no browser needed).
        const r = await kroger.searchProducts(query, { locationId: await apiLocation(client), limit: limit ?? 10, offset: offset ?? 0, pickupOnly: pickupOnly !== false });
        const products = r.products;
        return viewResponse(view, { total: r.total, offset: offset ?? 0, source: 'api.kroger.com', note: API_PRICE_NOTE, products }, (d) => {
          const x = d as { total?: number; offset: number; source: string; note: string; products: Record<string, unknown>[] };
          return { total: x.total, offset: x.offset, source: x.source, note: x.note, products: x.products.map(compactApiProduct) };
        });
      }
      const { total, hits } = await client.searchProducts(query, { limit, offset, pickupOnly: pickupOnly !== false });
      const upcs = hits.map((h) => h.upc).filter((u): u is string => typeof u === 'string');
      const products = await client.getProducts(upcs);
      const byUpc = new Map(products.map((p) => [String((p.item as Record<string, unknown>)?.upc ?? p.upc ?? ''), p]));
      const merged = hits.map((h) => byUpc.get(String(h.upc)) ?? h);
      return viewResponse(view, { total, offset, source: 'harristeeter.com', products: merged }, (d) => {
        const data = d as { total?: number; offset: number; source: string; products: Record<string, unknown>[] };
        return {
          total: data.total,
          offset: data.offset,
          source: data.source,
          products: data.products.map((p) => compactProduct(p) ?? { upc: p.upc, description: p.description }),
        };
      });
    },
  );

  server.registerTool(
    'ht_get_products',
    {
      description:
        'Look up Harris Teeter products by UPC — price, sale price, size, unit price and stock at your pickup store.',
      annotations: toolAnnotations({ title: 'Get products by UPC', openWorld: true }),
      inputSchema: z.object({
        upcs: z.array(Upc).min(1).max(50).describe('UPCs to look up.'),
        view: viewArg(),
      }),
      _meta: foodMeta('lookup'),
    },
    async ({ upcs, view }) => {
      if (kroger.configured) {
        const loc = await apiLocation(client);
        const found = [];
        for (const u of upcs) {
          const p = await kroger.getProduct(toGtin13(u), loc);
          if (p) found.push(p);
        }
        return viewResponse(view, found, (d) => (d as Record<string, unknown>[]).map(compactApiProduct));
      }
      const products = await client.getProducts(upcs);
      return viewResponse(view, products, (d) =>
        (d as Record<string, unknown>[]).map((p) => compactProduct(p)).filter(Boolean),
      );
    },
  );

  server.registerTool(
    'ht_find_stores',
    {
      description:
        'Find Harris Teeter stores near a ZIP code — name, address and the 8-digit location id (set HARRISTEETER_LOCATION_ID to search prices there without the browser). Needs Kroger API credentials.',
      annotations: toolAnnotations({ title: 'Find stores', openWorld: true }),
      inputSchema: z.object({ zip: z.string().regex(/^\d{5}$/), limit: z.number().int().min(1).max(20).default(5) }),
      _meta: foodMeta('lookup', { aliases: ['harris teeter near me', 'store locator'] }),
    },
    async ({ zip, limit }) => {
      const stores = await kroger.findStores(zip, limit ?? 5);
      return viewResponse(undefined, stores, (d) =>
        (d as Record<string, unknown>[]).map((l) => {
          const a = (l.address ?? {}) as Record<string, unknown>;
          return { locationId: l.locationId, name: l.name, address: [a.addressLine1, a.city, a.state, a.zipCode].filter(Boolean).join(', '), phone: l.phone };
        }),
      );
    },
  );
}
