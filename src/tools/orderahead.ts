import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { toolAnnotations, minifiedResult, McpToolError, IsoDate, confirmWrite, confirmTokenParam, CONFIRM_FLOW_SENTENCE } from '@chrischall/mcp-utils';
import type { HtClient } from '../client.js';
import { departmentGroups, departmentProducts, product, pickupTimes, placeOrder } from '../api/fresh.js';
import { viewArg, viewResponse } from '../view.js';
import { foodMeta } from './hints.js';

type Rec = Record<string, unknown>;
const Oid = z.string().regex(/^[0-9a-f]{24}$/);

function compactItem(p: Rec) {
  return {
    productId: p.ProductId,
    name: p.ProductName,
    description: p.ShortDesc || undefined,
    price: p.SpecialPrice || p.Price,
    regularPrice: p.SpecialPrice ? p.Price : undefined,
    unit: p.PriceUnit || undefined,
    servingSize: p.ServingSize || undefined,
    maxQuantity: p.MaxOrderAllow || undefined,
  };
}

export function registerOrderAheadTools(server: McpServer, client: HtClient): void {
  server.registerTool(
    'ht_oa_list_departments',
    {
      description:
        'List Harris Teeter Order Ahead departments at your store — deli counter, sandwich shop, pizzas, party and seafood platters, fruit baskets, bakery, holiday meals — with lead time and order cutoff. Order Ahead is paid at pickup.',
      annotations: toolAnnotations({ title: 'Order Ahead departments', openWorld: true }),
      inputSchema: z.object({}),
      _meta: foodMeta('lookup', { aliases: ['order ahead', 'deli order', 'party platter', 'sub order'] }),
    },
    async () =>
      minifiedResult(
        (await departmentGroups(client)).map((g) => ({
          group: g.DepartmentGroupName,
          departments: ((g.Departments as Rec[] | undefined) ?? []).map((d) => ({
            departmentId: d._id,
            name: d.DepartmentName,
            leadTime: [d.LeadTime, d.LeadTimeOption].filter((x) => x !== undefined && x !== '').join(' ') || undefined,
            cutOff: d.CutOffTime || undefined,
            hours: d.OpensAt && d.ClosesAt ? `${String(d.OpensAt)}–${String(d.ClosesAt)}` : undefined,
          })),
        })),
      ),
  );

  server.registerTool(
    'ht_oa_list_menu',
    {
      description: 'List the Order Ahead menu for one department — items with name, price, unit and serving size, grouped by category.',
      annotations: toolAnnotations({ title: 'Order Ahead menu', openWorld: true }),
      inputSchema: z.object({ departmentId: Oid.describe('From ht_oa_list_departments.'), view: viewArg() }),
      _meta: foodMeta('lookup'),
    },
    async ({ departmentId, view }) =>
      viewResponse(view, await departmentProducts(client, departmentId), (d) =>
        (d as Rec[]).map((c) => ({ category: c.CategoryName, items: ((c.products as Rec[] | undefined) ?? []).map(compactItem) })),
      ),
  );

  server.registerTool(
    'ht_oa_get_item',
    {
      description: 'Read one Order Ahead item in full — description, price, and any options (bread, toppings, sizes).',
      annotations: toolAnnotations({ title: 'Order Ahead item', openWorld: true }),
      inputSchema: z.object({ productId: Oid.describe('From ht_oa_list_menu.'), view: viewArg() }),
      _meta: foodMeta('lookup'),
    },
    async ({ productId, view }) => {
      const p = await product(client, productId);
      if (!p) throw new McpToolError(`Order Ahead item ${productId} not found.`);
      return viewResponse(view, p, (d) => ({ ...compactItem(d as Rec), department: (d as Rec).DepartmentName, longDescription: (d as Rec).LongDesc || undefined }));
    },
  );

  server.registerTool(
    'ht_oa_list_pickup_times',
    {
      description: 'List Order Ahead pickup times on a date for the given departments (e.g. "10:15 AM" … "7:00 PM").',
      annotations: toolAnnotations({ title: 'Order Ahead pickup times', openWorld: true }),
      inputSchema: z.object({ date: IsoDate.describe('YYYY-MM-DD'), departmentIds: z.array(Oid).min(1).max(10) }),
      _meta: foodMeta('lookup'),
    },
    async ({ date, departmentIds }) => minifiedResult({ date, times: await pickupTimes(client, date, departmentIds) }),
  );

  server.registerTool(
    'ht_oa_place_order',
    {
      description:
        'Place a Harris Teeter Order Ahead order (deli, subs, pizza, platters) for pickup — paid at the store when you collect it. The store starts preparing it and there is no cancel from here, so this sends real work to a person. NOT yet verified against a live order: the first real use is the test. ' +
        CONFIRM_FLOW_SENTENCE,
      annotations: toolAnnotations({ title: 'Place Order Ahead order', readOnly: false, destructive: true, openWorld: true }),
      inputSchema: z.object({
        date: IsoDate.describe('Pickup date, YYYY-MM-DD.'),
        time: z.string().regex(/^\d{1,2}:\d{2} (AM|PM)$/).describe('A pickup time from ht_oa_list_pickup_times, e.g. "5:30 PM".'),
        items: z
          .array(z.object({ productId: Oid, quantity: z.number().int().min(1).max(50), note: z.string().max(200).optional() }))
          .min(1)
          .max(20),
        confirmToken: confirmTokenParam,
      }),
      _meta: foodMeta('send', { aliases: ['order a sub', 'order deli'] }),
    },
    async ({ date, time, items, confirmToken }, ctx: ServerContext) => {
      const products = await Promise.all(items.map((i) => product(client, i.productId)));
      const orderItems = items.map((i, n) => {
        const p = products[n];
        if (!p) throw new McpToolError(`Order Ahead item ${i.productId} not found.`);
        const price = Number(p.SpecialPrice || p.Price || 0);
        return {
          ProductId: p.ProductId,
          ProductName: p.ProductName,
          UPC: p.UPC,
          DepartmentId: p.DepartmentId,
          DepartmentGroupId: p.DepartmentGroupId,
          Quantity: i.quantity,
          Price: price.toFixed(2),
          ItemTotal: (price * i.quantity).toFixed(2),
          ...(i.note ? { Note: i.note } : {}),
        };
      });
      const times = await pickupTimes(client, date, [...new Set(orderItems.map((o) => String(o.DepartmentId)))]);
      if (!times.includes(time)) {
        throw new McpToolError(`${time} on ${date} is not an available pickup time.`, { hint: 'Call ht_oa_list_pickup_times and pass one of its times.' });
      }
      const profile = (await client.getProfile()) ?? {};
      const phones = (((profile.contactInfo as Rec | undefined)?.phones as Rec[] | undefined) ?? []).map((p) =>
        String((p.number as Rec | undefined)?.raw ?? '').replace(/\D/g, ''),
      );
      const emails = (((profile.contactInfo as Rec | undefined)?.emails as Rec[] | undefined) ?? []).map((e) => e.address);
      const body = {
        DepartmentGroupWithOrderItems: [{ OrderItems: orderItems, OrderDate: date, TimeSlot: time, ASAP: '' }],
        FirstName: profile.firstName,
        LastName: profile.lastName,
        Phone: phones.find((p) => p.length >= 10)?.slice(-10),
        Email: emails[0],
        OrderSource: 'Web',
        GUID: 'orderAheadWeb',
      };
      const total = orderItems.reduce((s, o) => s + Number(o.ItemTotal), 0);
      const gate = await confirmWrite(ctx, {
        tool: 'ht_oa_place_order',
        action: 'Place a Harris Teeter Order Ahead order (pay at pickup)',
        summary: `${orderItems.map((o) => `${o.Quantity}× ${String(o.ProductName)}`).join(', ')} — pickup ${date} ${time}, about $${total.toFixed(2)} at pickup`,
        account: undefined,
        request: { method: 'POST', path: '/fresh/api/v4/ffo/stores/{store}/orders', body },
        preview: { pickup: `${date} ${time}`, items: orderItems.map((o) => ({ name: o.ProductName, quantity: o.Quantity, price: o.Price })), estimatedTotal: total.toFixed(2), paidAt: 'pickup' },
        args: { date, time, items },
        confirmToken,
      });
      if (gate) return gate;
      const result = await placeOrder(client, body);
      return minifiedResult({ placed: true, pickup: `${date} ${time}`, estimatedTotal: total.toFixed(2), result });
    },
  );
}
