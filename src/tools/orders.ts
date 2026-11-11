import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { toolAnnotations, todayIso, IsoDate } from '@chrischall/mcp-utils';
import type { HtClient } from '../client.js';
import { pendingOrders, receiptDetail } from '../api/orders.js';
import { minifiedResult, McpToolError } from '@chrischall/mcp-utils';
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
        startDate: IsoDate.optional().describe('Earliest date, YYYY-MM-DD (default 365 days ago).'),
        endDate: IsoDate.optional().describe('Latest date, YYYY-MM-DD (default today).'),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(50).default(10),
        view: viewArg(),
      }),
      _meta: foodMeta('lookup', { aliases: ['grocery receipts', 'past orders', 'what did i buy'] }),
    },
    async ({ startDate, endDate, page, pageSize, view }) => {
      const end = endDate ?? todayIso();
      const start = startDate ?? daysAgo(end, 365);
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
            receiptKey: o.receiptKey,
            itemCount: Array.isArray(o.lineItems) ? o.lineItems.length : undefined,
            upcs: Array.isArray(o.lineItems) ? (o.lineItems as Record<string, unknown>[]).map((l) => l.upc) : undefined,
          })),
        };
      });
    },
  );

  server.registerTool(
    'ht_list_upcoming_orders',
    {
      description: 'List Harris Teeter orders placed but not yet picked up — the next pickup, its window and status. Empty when nothing is scheduled.',
      annotations: toolAnnotations({ title: 'Upcoming orders', openWorld: true }),
      inputSchema: z.object({}),
      _meta: foodMeta('lookup', { aliases: ['upcoming pickup', 'my order', 'grocery order status'] }),
    },
    async () => {
      const orders = await pendingOrders(client);
      return minifiedResult({ count: orders.length, orders });
    },
  );

  server.registerTool(
    'ht_get_receipt',
    {
      description: 'Read one Harris Teeter purchase in full — every item with quantity, price paid and savings, plus subtotal, coupons, tax and total. Pass a receiptKey from ht_list_orders. The site sometimes refuses this request (its bot protection); if so, open the purchase under My Purchases on harristeeter.com.',
      annotations: toolAnnotations({ title: 'Get receipt', openWorld: true }),
      inputSchema: z.object({ receiptKey: z.string().min(5).max(80), view: viewArg() }),
      _meta: foodMeta('lookup', { aliases: ['receipt', 'what did i buy'] }),
    },
    async ({ receiptKey, view }) => {
      const r = await receiptDetail(client, receiptKey);
      if (!r) throw new McpToolError(`No receipt found for ${receiptKey}.`, { hint: 'Use a receiptKey from ht_list_orders.' });
      return viewResponse(view, r, (d) => {
        const x = d as Record<string, unknown>;
        const items = Array.isArray(x.items) ? (x.items as Record<string, Record<string, Record<string, unknown>>>[]) : [];
        return {
          date: (x.receiptCreateDateTime as Record<string, unknown> | undefined)?.value,
          purchaseType: x.purchaseType,
          store: (x.storeInfo as Record<string, unknown> | undefined)?.vanityName,
          totals: x.costSummary,
          items: items.map((i) => ({
            upc: i.purchasedData?.upc,
            description: i.purchasedData?.displayInfo?.description,
            quantity: i.purchasedData?.quantityInfo?.received,
            paid: i.purchasedData?.pricingInfo?.totalPricePaid,
            savings: i.purchasedData?.pricingInfo?.totalSavings,
          })),
        };
      });
    },
  );
}
