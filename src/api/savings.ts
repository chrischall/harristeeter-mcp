// Digital coupons (e-VIC), personalised specials, the weekly ad and fuel points.
// Shapes captured live 2026-11-11 (docs/HT-API.md).

import { McpToolError } from '@chrischall/mcp-utils';
import type { HtClient } from '../client.js';

type Rec = Record<string, unknown>;

export type CouponStatus = 'unclipped' | 'clipped' | 'all';

export async function listCoupons(
  client: HtClient,
  opts: { status?: CouponStatus; search?: string; limit?: number; offset?: number } = {},
) {
  const status = opts.status ?? 'unclipped';
  const json = await client.api<{ data?: { coupons?: Rec[] }; meta?: { coupons?: Rec } }>('GET', '/savings-coupons/v2/coupons', {
    laf: true,
    query: {
      // The site's own values: clipped coupons are "active".
      'filter.status': status === 'all' ? ['unclipped', 'active'] : status === 'clipped' ? 'active' : 'unclipped',
      'filter.searchString': opts.search,
      'page.size': opts.limit ?? 25,
      'page.offset': opts.offset ?? 0,
    },
  });
  const meta = json?.meta?.coupons ?? {};
  return {
    coupons: json?.data?.coupons ?? [],
    counts: (meta.userSavingsInfoByType as Rec | undefined)?.standard,
    hasMore: (meta.page as Rec | undefined)?.hasMore,
    total: (meta.filterSummaryByType as Rec | undefined)?.totalCount,
  };
}

export async function clipCoupon(client: HtClient, couponId: string, action: 'CLIP' | 'UNCLIP') {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(couponId)) {
    throw new McpToolError(`Invalid coupon id "${couponId}" — use an id from ht_list_coupons.`);
  }
  return client.api<unknown>('POST', '/savings-coupons/v1/clip-unclip', {
    laf: true,
    body: { action, couponId },
  });
}

/** The coupon's current status, read back after a clip/unclip. */
export async function couponStatus(client: HtClient, couponId: string): Promise<'clipped' | 'unclipped' | 'unknown'> {
  for (const status of ['clipped', 'unclipped'] as const) {
    for (let offset = 0; offset < 1000; offset += 200) {
      const page = await listCoupons(client, { status, limit: 200, offset });
      if (page.coupons.some((c) => String(c.id) === couponId)) return status;
      if (!page.hasMore) break;
    }
  }
  return 'unknown';
}

export async function listSpecials(client: HtClient): Promise<Rec[]> {
  const json = await client.api<{ data?: { htSpecials?: Rec[] } }>('GET', '/savings-coupons/v1/ht-specials', { laf: true });
  return json?.data?.htSpecials ?? [];
}

/** Weekly-ad departments (live sweep 2026-11-11: 1–18 answer, 19+ are empty). */
export const WEEKLY_AD_DEPARTMENTS: Record<string, string> = {
  '1': 'Produce',
  '2': 'Breads & Bakery',
  '3': 'Deli',
  '4': 'Dairy & Chilled Foods',
  '5': 'Frozen Foods',
  '6': 'Meat - Packaged',
  '7': 'Meat - Fresh',
  '8': 'Seafood',
  '9': 'Breakfast Foods',
  '10': 'Meal Makers',
  '11': 'Baking Items',
  '12': 'Snacks & Sweets',
  '13': 'Beverages',
  '14': 'Beer & Wine',
  '15': 'Household Essentials',
  '16': 'Pet Essentials',
  '17': 'Health Care Essentials',
  '18': 'Beauty Care Essentials',
};

export async function weeklyAd(client: HtClient, department: string): Promise<Rec[]> {
  const json = await client.api<{ data?: { htWeeklyAds?: Rec[] } }>('GET', '/savings-coupons/v1/ht-weekly-ads', {
    laf: true,
    query: { 'filter.departmentNumber': department },
  });
  return json?.data?.htWeeklyAds ?? [];
}

export async function fuelPoints(client: HtClient): Promise<Rec[]> {
  const json = await client.api<{ data?: { pointsProgramSummaries?: { programSummaries?: Rec[] } } }>(
    'GET',
    '/points/v1/program-summaries',
    // 400 "headers.user-time-zone is required" without it (live 2026-11-11).
    { timeZone: true },
  );
  return json?.data?.pointsProgramSummaries?.programSummaries ?? [];
}
