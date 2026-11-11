// Order Ahead ("fresh"): deli, subs, pizza, platters and holiday meals.
// A separate app under /fresh/api with its own headers — `X-Kroger-Tenant:
// kroger` and `division: <DivisionCode>` (HARR064 for Harris Teeter), both
// resolved from GET /fresh/api/v1/locationId/<locationId>. Orders are paid at
// pickup; the order POST carries no payment or fraud data.

import { McpToolError } from '@chrischall/mcp-utils';
import type { HtClient } from '../client.js';

type Rec = Record<string, unknown>;

interface FreshStore {
  storeNumber: number;
  division: string;
}

const storeCache = new WeakMap<HtClient, Promise<FreshStore>>();

function unwrap(path: string, r: { status: number; json: unknown; text: string }): unknown {
  const j = r.json as { Status?: string; Data?: unknown; Error?: { Message?: string } } | undefined;
  if (!j) {
    throw new McpToolError(`Order Ahead returned ${r.status} with no data for ${path.split('?')[0]}.`, {
      hint: 'Open https://www.harristeeter.com/order-ahead in the signed-in tab once, then retry.',
      status: r.status,
      kind: 'http',
    });
  }
  if (j.Status && j.Status !== 'success') {
    throw new McpToolError(`Order Ahead: ${j.Error?.Message ?? j.Status}`, { status: r.status, kind: 'http' });
  }
  return j.Data;
}

export function freshStore(client: HtClient): Promise<FreshStore> {
  let p = storeCache.get(client);
  if (!p) {
    p = (async () => {
      const prefs = await client.preferences();
      const loc = prefs.pickup?.locationId;
      if (!loc) throw new McpToolError('No pickup store on this account — choose one on harristeeter.com first.');
      const path = `/fresh/api/v1/locationId/${loc}`;
      const d = unwrap(path, await client.raw('GET', path, { headers: { 'X-Kroger-Tenant': 'kroger' } })) as Rec;
      if (typeof d?.DivisionCode !== 'string' || d.StoreNumber === undefined) {
        throw new McpToolError('Order Ahead is not available at your pickup store.');
      }
      return { storeNumber: Number(d.StoreNumber), division: d.DivisionCode };
    })();
    p.catch(() => storeCache.delete(client));
    storeCache.set(client, p);
  }
  return p;
}

async function fresh(client: HtClient, method: 'GET' | 'POST', path: string, body?: unknown, query?: Record<string, string>) {
  const s = await freshStore(client);
  const full = path.replace('{store}', String(s.storeNumber));
  const r = await client.raw(method, full, {
    headers: { 'X-Kroger-Tenant': 'kroger', division: s.division },
    ...(body !== undefined ? { body } : {}),
    ...(query ? { query } : {}),
  });
  return unwrap(full, r);
}

export async function departmentGroups(client: HtClient): Promise<Rec[]> {
  return ((await fresh(client, 'GET', '/fresh/api/v2/ffo/stores/{store}/sections/Fresh/departmentGroups')) as Rec[]) ?? [];
}

const OID = /^[0-9a-f]{24}$/;
function oid(id: string, what: string): string {
  if (!OID.test(id)) throw new McpToolError(`Invalid ${what} "${id}" — use an id from ht_oa_list_departments / ht_oa_list_products.`);
  return id;
}

export async function departmentProducts(client: HtClient, departmentId: string): Promise<Rec[]> {
  return ((await fresh(client, 'GET', `/fresh/api/v1/ffo/stores/{store}/departments/${oid(departmentId, 'department id')}/products`)) as Rec[]) ?? [];
}

export async function product(client: HtClient, productId: string): Promise<Rec | undefined> {
  return (await fresh(client, 'GET', `/fresh/api/v1/ffo/stores/{store}/product/${oid(productId, 'product id')}`, undefined, {
    includePriceVaries: 'true',
  })) as Rec | undefined;
}

/** Pickup times ("10:15 AM" …) for the given departments on a date (YYYY-MM-DD). */
export async function pickupTimes(client: HtClient, date: string, departmentIds: string[]): Promise<string[]> {
  return ((await fresh(client, 'POST', '/fresh/api/v2/ffo/stores/{store}/departments/timeslots', {
    OrderDate: date,
    Items: departmentIds.map((d) => ({ DepartmentId: oid(d, 'department id') })),
  })) as string[]) ?? [];
}

/**
 * Place an Order Ahead order. Body per the site's builder: camelCase keys are
 * PascalCased, with renames itemNumbers→Quantity, oneItemTotal→Price,
 * topicId→DepartmentGroupId, upc→UPC, additionalComments→Note.
 * NOT yet verified against a live order (docs/HT-API.md).
 */
export async function placeOrder(client: HtClient, body: Rec): Promise<unknown> {
  return fresh(client, 'POST', '/fresh/api/v4/ffo/stores/{store}/orders', body, { includePriceVaries: 'true' });
}
