import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { toolAnnotations, minifiedResult, mapWithConcurrency } from '@chrischall/mcp-utils';
import type { HtClient } from '../client.js';
import { listCoupons, clipCoupon, couponStatus, listSpecials, weeklyAd, fuelPoints, WEEKLY_AD_DEPARTMENTS } from '../api/savings.js';
import { viewArg, viewResponse } from '../view.js';
import { foodMeta } from './hints.js';

type Rec = Record<string, unknown>;
const CouponId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).describe('Coupon id from ht_list_coupons.');

function compactCoupon(c: Rec) {
  if (c.id === undefined) return undefined;
  return {
    id: String(c.id),
    brand: c.brand,
    description: c.shortDescription ?? c.title,
    value: c.value,
    requirementQuantity: c.requirementQuantity,
    expires: c.displayEndDate ?? c.expirationDate,
    status: c.status,
    categories: c.categories,
  };
}

function compactSpecial(s: Rec) {
  if (s.title === undefined && s.description === undefined) return undefined;
  return {
    title: s.title,
    subtitle: s.subtitle || undefined,
    size: s.size || undefined,
    price: s.specialPrice || s.price,
    regularPrice: s.specialPrice ? s.price : undefined,
    savings: s.savings || undefined,
    limit: s.limit || undefined,
    department: s.departmentName,
    ends: s.endDate,
  };
}

export function registerSavingsTools(server: McpServer, client: HtClient): void {
  server.registerTool(
    'ht_list_coupons',
    {
      description:
        'List Harris Teeter e-VIC digital coupons — available (unclipped), clipped to your card, or all — with brand, value and expiry. Use ht_clip_coupon to load one to your card.',
      annotations: toolAnnotations({ title: 'List digital coupons', openWorld: true }),
      inputSchema: z.object({
        status: z.enum(['unclipped', 'clipped', 'all']).default('unclipped'),
        search: z.string().trim().max(100).optional().describe('Filter by text, e.g. "coffee".'),
        limit: z.number().int().min(1).max(200).default(25),
        offset: z.number().int().min(0).default(0),
        view: viewArg(),
      }),
      _meta: foodMeta('lookup', { aliases: ['coupons', 'digital coupons', 'evic', 'e-vic'] }),
    },
    async ({ status, search, limit, offset, view }) => {
      const r = await listCoupons(client, { status: status ?? 'unclipped', ...(search ? { search } : {}), limit: limit ?? 25, offset: offset ?? 0 });
      return viewResponse(view, r, (d) => {
        const x = d as typeof r;
        return { counts: x.counts, total: x.total, hasMore: x.hasMore, coupons: x.coupons.map((c) => compactCoupon(c) ?? c) };
      });
    },
  );

  for (const [name, action, title, verb] of [
    ['ht_clip_coupon', 'CLIP', 'Clip coupon', 'Load a Harris Teeter e-VIC digital coupon to your card (applies at checkout or in store). Undo with ht_unclip_coupon.'],
    ['ht_unclip_coupon', 'UNCLIP', 'Unclip coupon', 'Remove a clipped e-VIC digital coupon from your card. Re-add with ht_clip_coupon.'],
  ] as const) {
    server.registerTool(
      name,
      {
        description: verb,
        annotations: toolAnnotations({ title, readOnly: false, destructive: false, idempotent: true, openWorld: true }),
        inputSchema: z.object({ couponId: CouponId }),
        _meta: foodMeta('change', action === 'CLIP' ? { aliases: ['clip coupon', 'load coupon'] } : {}),
      },
      async ({ couponId }) => {
        await clipCoupon(client, couponId, action);
        // Re-read: a 200 is not proof the coupon moved.
        const now = await couponStatus(client, couponId);
        const wanted = action === 'CLIP' ? 'clipped' : 'unclipped';
        return minifiedResult({
          couponId,
          status: now,
          ...(now !== wanted ? { warning: `Harris Teeter accepted the request but the coupon now reads as "${now}", not "${wanted}".` } : {}),
        });
      },
    );
  }

  server.registerTool(
    'ht_list_specials',
    {
      description: 'List your personalised Harris Teeter "My Specials" — sale items picked for your card, with sale price, regular price, limit and end date.',
      annotations: toolAnnotations({ title: 'My specials', openWorld: true }),
      inputSchema: z.object({ view: viewArg() }),
      _meta: foodMeta('lookup', { aliases: ['my specials', 'deals for me'] }),
    },
    async ({ view }) => viewResponse(view, await listSpecials(client), (d) => (d as Rec[]).map((s) => compactSpecial(s) ?? s)),
  );

  const deptList = Object.entries(WEEKLY_AD_DEPARTMENTS).map(([n, name]) => `${n} ${name}`).join(', ');
  server.registerTool(
    'ht_get_weekly_ad',
    {
      description: `Read this week's Harris Teeter weekly ad (Weekly Specials) at your store, by department: ${deptList}. Omit department for every department.`,
      annotations: toolAnnotations({ title: 'Weekly ad', openWorld: true }),
      inputSchema: z.object({
        department: z.enum(Object.keys(WEEKLY_AD_DEPARTMENTS) as [string, ...string[]]).optional().describe('Department number (see description).'),
        search: z.string().trim().max(60).optional().describe('Only items whose title mentions this, e.g. "chicken".'),
        view: viewArg(),
      }),
      _meta: foodMeta('lookup', { aliases: ['weekly ad', 'weekly specials', 'sales this week', 'circular'] }),
    },
    async ({ department, search, view }) => {
      const depts = department ? [department] : Object.keys(WEEKLY_AD_DEPARTMENTS);
      const pages = await mapWithConcurrency(depts, 4, (d) => weeklyAd(client, d));
      let items = pages.flat();
      if (search) {
        const q = search.toLowerCase();
        items = items.filter((i) => `${i.title ?? ''} ${i.subtitle ?? ''} ${i.description ?? ''}`.toLowerCase().includes(q));
      }
      return viewResponse(view, items, (d) => ({ count: (d as Rec[]).length, items: (d as Rec[]).map((s) => compactSpecial(s) ?? s) }));
    },
  );

  server.registerTool(
    'ht_get_fuel_points',
    {
      description: 'Show your Harris Teeter fuel points: current balance, earned and redeemed this period, and points expiring next.',
      annotations: toolAnnotations({ title: 'Fuel points', openWorld: true }),
      inputSchema: z.object({ view: viewArg() }),
      _meta: foodMeta('lookup', { aliases: ['fuel points', 'gas points', 'rewards points'] }),
    },
    async ({ view }) =>
      viewResponse(view, await fuelPoints(client), (d) =>
        (d as Rec[]).map((p) => {
          const v = (p.values ?? {}) as Rec;
          const exp = (p.expiring ?? {}) as { next?: Rec[] };
          return {
            program: p.name,
            month: (p.computedValues as Rec | undefined)?.monthName,
            current: v.current,
            earned: v.earned,
            redeemed: v.redeemed,
            unit: p.uom,
            expiringNext: exp.next?.[0],
          };
        }),
      ),
  );
}
