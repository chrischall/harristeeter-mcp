import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { toolAnnotations } from '@chrischall/mcp-utils';
import type { HtClient } from '../client.js';
import { compactProduct } from '../project.js';
import { viewArg, viewResponse } from '../view.js';
import { foodMeta } from './hints.js';

const Upc = z.string().regex(/^\d{1,14}$/, 'digits only').describe('Product UPC as returned by ht_search_products (13 digits, leading zeros kept).');

export function registerProductTools(server: McpServer, client: HtClient): void {
  server.registerTool(
    'ht_search_products',
    {
      description:
        'Search Harris Teeter groceries by keyword at your pickup store — returns UPC, name, brand, size, price, sale price, unit price and pickup stock. Use the UPC with ht_add_to_cart.',
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
      const { total, hits } = await client.searchProducts(query, { limit, offset, pickupOnly: pickupOnly !== false });
      const upcs = hits.map((h) => h.upc).filter((u): u is string => typeof u === 'string');
      const products = await client.getProducts(upcs);
      const byUpc = new Map(products.map((p) => [String((p.item as Record<string, unknown>)?.upc ?? p.upc ?? ''), p]));
      const merged = hits.map((h) => byUpc.get(String(h.upc)) ?? h);
      return viewResponse(view, { total, offset, products: merged }, (d) => {
        const data = d as { total?: number; offset: number; products: Record<string, unknown>[] };
        return {
          total: data.total,
          offset: data.offset,
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
      const products = await client.getProducts(upcs);
      return viewResponse(view, products, (d) =>
        (d as Record<string, unknown>[]).map((p) => compactProduct(p)).filter(Boolean),
      );
    },
  );
}
