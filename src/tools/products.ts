import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { toolAnnotations, minifiedResult } from '@chrischall/mcp-utils';
import type { HtClient } from '../client.js';
import { KrogerApi, compactApiProduct, configuredLocationId } from '../api/kroger.js';
import { resolveStore, lookupStore, saveChosenStore, readStoreFile } from '../store.js';
import { toGtin13 } from '../client.js';
import { McpToolError } from '@chrischall/mcp-utils';
import { compactProduct } from '../project.js';
import { viewArg, viewResponse } from '../view.js';
import { foodMeta } from './hints.js';

const Upc = z.string().regex(/^\d{1,14}$/, 'digits only').describe('Product UPC as returned by ht_search_products (13 digits, leading zeros kept).');

/** Said in every API-path result, not only in the description: the two sources price produce differently. */
export const API_PRICE_NOTE = 'Prices from api.kroger.com: produce is priced per pound (the website prices it per item).';

const ZipArg = z.string().regex(/^\d{5}$/).optional().describe('Price at the Harris Teeter nearest this ZIP, for this call only (needs Kroger API credentials).');
const LocationArg = z.string().regex(/^\d{8}$/).optional().describe('Price at this 8-digit store location id, for this call only (needs Kroger API credentials).');

/** The browser's live store through the bridge, or undefined when the bridge has none. */
function liveBrowserStore(client: HtClient) {
  return async () => {
    const p = (await client.preferences()).pickup;
    return p ? { locationId: p.locationId, ...(p.name ? { name: p.name } : {}) } : undefined;
  };
}

function requireApiForStore(kroger: KrogerApi, zip?: string, locationId?: string): void {
  if ((zip || locationId) && !kroger.configured) {
    throw new McpToolError('Choosing a store per call needs Kroger API credentials.', {
      hint: 'Set KROGER_API_CLIENT_ID / KROGER_API_CLIENT_SECRET, or change the store on harristeeter.com in the bridge browser.',
    });
  }
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
        zip: ZipArg,
        locationId: LocationArg,
        view: viewArg(),
      }),
      _meta: foodMeta('lookup', { aliases: ['groceries', 'harris teeter', 'grocery search'] }),
    },
    async ({ query, limit, offset, pickupOnly, zip, locationId, view }) => {
      requireApiForStore(kroger, zip, locationId);
      if (kroger.configured) {
        // Bridge-free: Kroger's official API (no browser needed).
        const store = await resolveStore(kroger, { ...(zip ? { zip } : {}), ...(locationId ? { locationId } : {}) }, liveBrowserStore(client));
        const r = await kroger.searchProducts(query, { locationId: store.locationId, limit: limit ?? 10, offset: offset ?? 0, pickupOnly: pickupOnly !== false });
        const products = r.products;
        return viewResponse(view, { total: r.total, offset: offset ?? 0, source: 'api.kroger.com', store, note: API_PRICE_NOTE, products }, (d) => {
          const x = d as { total?: number; offset: number; source: string; store: unknown; note: string; products: Record<string, unknown>[] };
          return { total: x.total, offset: x.offset, source: x.source, store: x.store, note: x.note, products: x.products.map(compactApiProduct) };
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
        zip: ZipArg,
        locationId: LocationArg,
        view: viewArg(),
      }),
      _meta: foodMeta('lookup'),
    },
    async ({ upcs, zip, locationId, view }) => {
      requireApiForStore(kroger, zip, locationId);
      if (kroger.configured) {
        const loc = (await resolveStore(kroger, { ...(zip ? { zip } : {}), ...(locationId ? { locationId } : {}) }, liveBrowserStore(client))).locationId;
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

  server.registerTool(
    'ht_set_store',
    {
      description:
        'Choose the Harris Teeter store that bridge-free product search prices against — by ZIP (optionally with part of the store name, e.g. "Park Road") or 8-digit location id — or clear the choice to follow the store picked on harristeeter.com. Saved on this server; does not change the store on your Harris Teeter account.',
      annotations: toolAnnotations({ title: 'Set my store', readOnly: false, destructive: false, idempotent: true, openWorld: true }),
      inputSchema: z.object({
        zip: z.string().regex(/^\d{5}$/).optional(),
        name: z.string().trim().max(60).optional().describe('Part of the store name, to pick among stores near the ZIP.'),
        locationId: z.string().regex(/^\d{8}$/).optional(),
        clear: z.boolean().optional().describe('Forget the saved choice.'),
      }),
      _meta: foodMeta('change', { aliases: ['change store', 'set my harris teeter'] }),
    },
    async ({ zip, name, locationId, clear }) => {
      if (clear) {
        await saveChosenStore(null);
        return minifiedResult({ saved: null, note: 'Search now follows HARRISTEETER_LOCATION_ID, else the store picked on harristeeter.com.' });
      }
      const store = await lookupStore(kroger, { ...(zip ? { zip } : {}), ...(locationId ? { locationId } : {}), ...(name ? { name } : {}) });
      await saveChosenStore(store);
      return minifiedResult({ saved: store, note: 'Bridge-free search now prices against this store. Cart, pickup times and checkout still use the store chosen on harristeeter.com.' });
    },
  );

  server.registerTool(
    'ht_get_store',
    {
      description:
        'Show which Harris Teeter store is in use: the one chosen on harristeeter.com (cart, pickup, checkout) and the one bridge-free search prices against, with where that choice came from.',
      annotations: toolAnnotations({ title: 'Get my store', openWorld: true }),
      inputSchema: z.object({}),
      _meta: foodMeta('lookup', { aliases: ['my harris teeter', 'pickup store'] }),
    },
    async () => {
      const f = readStoreFile();
      let browser: { pickupStore: unknown; activeModality: unknown } | null = null;
      let browserError: string | undefined;
      try {
        const prefs = await client.preferences();
        browser = { pickupStore: prefs.pickup ?? null, activeModality: prefs.activeModality ?? null };
      } catch (err) {
        // As in 0.2.0, fail when the bridge was the only thing to report.
        if (!kroger.configured) throw err;
        browserError = (err as Error).message;
      }
      let search: unknown = null;
      if (kroger.configured) {
        try {
          search = await resolveStore(kroger, {}, async () => undefined);
        } catch {
          search = null;
        }
      }
      return minifiedResult({
        // 0.2.0's top-level fields, kept so existing callers keep working.
        pickupStore: browser?.pickupStore ?? null,
        activeModality: browser?.activeModality ?? null,
        browser,
        ...(browserError ? { browserError } : {}),
        search: kroger.configured ? search : 'bridge (Kroger API not configured)',
        saved: f.chosen ?? null,
        rememberedFromBrowser: f.rememberedFromBrowser ?? null,
        envLocationId: (() => {
          try {
            return configuredLocationId() ?? null;
          } catch {
            return 'invalid';
          }
        })(),
        note: 'Change the cart/pickup store with the store picker on harristeeter.com; change the search store with ht_set_store.',
      });
    },
  );
}
