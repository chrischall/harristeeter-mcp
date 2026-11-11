import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { toolAnnotations, todayIso, IsoDate } from '@chrischall/mcp-utils';
import type { HtClient } from '../client.js';
import { viewArg, viewResponse } from '../view.js';
import { foodMeta } from './hints.js';

function daysAgo(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export function registerOrderTools(server: McpServer, client: HtClient): void {
  server.registerTool(
    'ht_list_orders',
    {
      description: 'List past Harris Teeter purchases (online orders and in-store receipts on the loyalty card) — date, total, status and item UPCs.',
      annotations: toolAnnotations({ title: 'List past orders', openWorld: true }),
      inputSchema: z.object({
        startDate: IsoDate.optional().describe('Earliest date, YYYY-MM-DD (default 90 days ago).'),
        endDate: IsoDate.optional().describe('Latest date, YYYY-MM-DD (default today).'),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(50).default(10),
        view: viewArg(),
      }),
      _meta: foodMeta('lookup', { aliases: ['grocery receipts', 'past orders', 'what did i buy'] }),
    },
    async ({ startDate, endDate, page, pageSize, view }) => {
      const end = endDate ?? todayIso();
      const start = startDate ?? daysAgo(end, 90);
      const res = await client.purchaseHistory({ startDate: start, endDate: end, page: page ?? 1, pageSize: pageSize ?? 10 });
      return viewResponse(view, res, (d) => {
        const r = d as typeof res;
        return {
          isLastPage: r.isLastPage,
          orders: r.orders.map((o) => ({
            date: (o.createdDateTime as Record<string, unknown>)?.value,
            purchaseType: o.purchaseType,
            status: o.status,
            total: o.total,
            itemCount: Array.isArray(o.lineItems) ? o.lineItems.length : undefined,
            upcs: Array.isArray(o.lineItems) ? (o.lineItems as Record<string, unknown>[]).map((l) => l.upc) : undefined,
          })),
        };
      });
    },
  );
}
