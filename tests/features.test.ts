import { describe, it, expect } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { makeClient, PREFS } from './helpers/stub.js';
import type { Route } from './helpers/stub.js';
import { listCoupons, clipCoupon, fuelPoints } from '../src/api/savings.js';
import { pendingOrders, receiptDetail, toDetailKey } from '../src/api/orders.js';
import { searchRecipes, getRecipe } from '../src/api/recipes.js';
import { updateList } from '../src/api/lists.js';
import { departmentGroups, pickupTimes } from '../src/api/fresh.js';
import { prescriptions, RxSessionError } from '../src/api/rx.js';
import { registerSavingsTools } from '../src/tools/savings.js';
import { registerPharmacyTools } from '../src/tools/pharmacy.js';

async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected the promise to reject');
}

const withPrefs = (route: Route): Route => (init, ctx) => (ctx.path.endsWith('/modality/preferences') ? PREFS : route(init, ctx));

describe('coupons', () => {
  it('maps clipped to the site\'s "active" status and sends the store context', async () => {
    const { client, calls } = makeClient(withPrefs(() => ({ data: { coupons: [] }, meta: { coupons: {} } })));
    await listCoupons(client, { status: 'clipped', search: 'coffee' });
    await listCoupons(client, { status: 'all' });
    const [a, b] = calls.filter((c) => c.path.includes('/savings-coupons/v2/coupons'));
    const qa = new URL(a!.path, 'https://x').searchParams;
    expect(qa.getAll('filter.status')).toEqual(['active']);
    expect(qa.get('filter.searchString')).toBe('coffee');
    expect(a!.headers?.['x-laf-object']).toBeDefined();
    expect(new URL(b!.path, 'https://x').searchParams.getAll('filter.status')).toEqual(['unclipped', 'active']);
  });

  it('clip posts {action, couponId} and rejects a malformed id without calling out', async () => {
    const { client, calls } = makeClient(withPrefs(() => ({})));
    await clipCoupon(client, 'abc123', 'CLIP');
    const post = calls.find((c) => c.path.endsWith('/savings-coupons/v1/clip-unclip'))!;
    expect(post.method).toBe('POST');
    expect(JSON.parse(post.body!)).toEqual({ action: 'CLIP', couponId: 'abc123' });
    const n = calls.length;
    expect((await failure(clipCoupon(client, '../x', 'CLIP'))).message).toMatch(/Invalid coupon id/);
    expect(calls.length).toBe(n);
  });

  it('ht_clip_coupon re-reads and warns when the coupon did not move', async () => {
    const { client } = makeClient(
      withPrefs((_i, { path, query }) => {
        if (path.endsWith('/clip-unclip')) return {};
        // The coupon stays unclipped whatever we do.
        const unclipped = query.getAll('filter.status').includes('unclipped');
        return { data: { coupons: unclipped ? [{ id: 'c1' }] : [] }, meta: { coupons: { page: { hasMore: false } } } };
      }),
    );
    const h = await createTestHarness((s) => registerSavingsTools(s, client));
    const out = parseToolResult<{ status: string; warning?: string }>(await h.callTool('ht_clip_coupon', { couponId: 'c1' }));
    await h.close();
    expect(out.status).toBe('unclipped');
    expect(out.warning).toMatch(/not "clipped"/);
  });
});

describe('orders', () => {
  it('converts the list receipt key to the details key', () => {
    expect(toDetailKey('099~00999~2030-01-02~123~456789')).toBe('2030-01-02_099_00999_123_456789');
    expect(toDetailKey('2030-01-02_099_00999_123_456789')).toBe('2030-01-02_099_00999_123_456789');
    expect(() => toDetailKey('nonsense')).toThrow(/Unrecognised receipt key/);
  });

  it('receipt detail POSTs the converted key with x-isreceipt', async () => {
    const { client, calls } = makeClient(withPrefs(() => ({ data: { purchaseHistoryDetails: [{ purchaseType: 'IN_STORE' }] } })));
    expect(await receiptDetail(client, '099~00999~2030-01-02~123~456789')).toEqual({ purchaseType: 'IN_STORE' });
    const c = calls.find((x) => x.path.includes('/purchase-history/v2/details'))!;
    expect(c.method).toBe('POST');
    expect(c.headers?.['x-isreceipt']).toBe('true');
    expect(JSON.parse(c.body!)).toEqual(['2030-01-02_099_00999_123_456789']);
  });

  it('pending orders send x-application-name (400 without it)', async () => {
    const { client, calls } = makeClient(withPrefs(() => ({ data: { pendingOrderSummaries: { data: [] } } })));
    expect(await pendingOrders(client)).toEqual([]);
    expect(calls.find((c) => c.path.includes('pending-order-summaries'))!.headers?.['x-application-name']).toBeTruthy();
  });
});

describe('recipes', () => {
  it('searches with filter.query (filter.keyword is ignored upstream)', async () => {
    const { client, calls } = makeClient(() => ({ data: { recipes: { data: { recipes: [] }, meta: { totalRecipesCount: 0 } } } }));
    await searchRecipes(client, { query: 'chicken' });
    const q = new URL(calls[0]!.path, 'https://x').searchParams;
    expect(q.get('filter.query')).toBe('chicken');
    expect(q.has('filter.keyword')).toBe(false);
  });
});

describe('live-run regressions (2026-11-11)', () => {
  it('fuel points send user-time-zone (400 without)', async () => {
    const { client, calls } = makeClient(() => ({ data: { pointsProgramSummaries: { programSummaries: [] } } }));
    await fuelPoints(client);
    expect(calls[0]!.headers?.['user-time-zone']).toBe('America/New_York');
  });
  it('recipe detail sends filter.division from the pickup store (400 MISSING_DIVISION without)', async () => {
    const { client, calls } = makeClient(withPrefs(() => ({ data: { recipes: { data: { recipes: { id: 'r1' } } } } })));
    await getRecipe(client, 'r1');
    const q = new URL(calls.find((c) => c.path.includes('/recipe/recipes/'))!.path, 'https://x').searchParams;
    expect(q.get('filter.division')).toBe('097');
    expect(q.get('projections')).toBe('recipes.full');
  });
  it('accepts the 64-character hashed patient numbers the pharmacy uses', async () => {
    const { client } = makeClient((_i, { path }) =>
      path === '/rx-security/session' ? { active: true, sessionStatus: 'AUTHORIZED' } : { items: [] },
    );
    await expect(prescriptions(client, 'A'.repeat(64))).resolves.toEqual([]);
  });
});

describe('shopping lists', () => {
  it('PUT carries the current versionKey and keeps the name when only items change', async () => {
    const { client, calls } = makeClient(
      withPrefs((init) =>
        init.method === 'GET'
          ? { data: { shoppingLists: { listId: 'aaaaaaaa-1111', name: 'Weekly', versionKey: 'v7' } } }
          : { data: { shoppingLists: { listId: 'aaaaaaaa-1111' } } },
      ),
    );
    await updateList(client, 'aaaaaaaa-1111', { items: [] });
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.path).toBe('/atlas/v1/shopping-list/v1/shopping-lists/aaaaaaaa-1111');
    expect(JSON.parse(put.body!)).toEqual({ name: 'Weekly', versionKey: 'v7', lineItems: [] });
  });
});

describe('Order Ahead', () => {
  const freshRoute = (over?: Route) =>
    withPrefs((init, ctx) => {
      if (over) {
        const r = over(init, ctx);
        if (r !== undefined) return r;
      }
      if (ctx.path.startsWith('/fresh/api/v1/locationId/')) return { Status: 'success', Data: { DivisionCode: 'TEST001', StoreNumber: 7 } };
      if (ctx.path.includes('/departmentGroups')) return { Status: 'success', Data: [{ DepartmentGroupName: 'Deli' }] };
      if (ctx.path.includes('/departments/timeslots')) return { Status: 'success', Data: ['10:15 AM'] };
      throw new Error(`unscripted ${ctx.path}`);
    });

  it('resolves division + store from the pickup location once and sends the fresh headers', async () => {
    const { client, calls } = makeClient(freshRoute());
    await departmentGroups(client);
    await pickupTimes(client, '2030-01-01', ['0123456789abcdef01234567']);
    expect(calls.filter((c) => c.path.startsWith('/fresh/api/v1/locationId/'))).toHaveLength(1);
    expect(calls[1]!.path).toBe('/fresh/api/v1/locationId/09700000');
    const dg = calls.find((c) => c.path.includes('/departmentGroups'))!;
    expect(dg.path).toBe('/fresh/api/v2/ffo/stores/7/sections/Fresh/departmentGroups');
    expect(dg.headers).toMatchObject({ 'X-Kroger-Tenant': 'kroger', division: 'TEST001' });
    const ts = calls.find((c) => c.path.includes('/departments/timeslots'))!;
    expect(JSON.parse(ts.body!)).toEqual({ OrderDate: '2030-01-01', Items: [{ DepartmentId: '0123456789abcdef01234567' }] });
  });

  it('surfaces a failure Status as an error, not data', async () => {
    const { client } = makeClient(freshRoute((_i, { path }) => (path.includes('/departmentGroups') ? { Status: 'failure', Error: { Message: 'Store closed' } } : undefined)));
    expect((await failure(departmentGroups(client))).message).toMatch(/Store closed/);
  });

  it('rejects a malformed department id before any call', async () => {
    const { client, calls } = makeClient(freshRoute());
    expect((await failure(pickupTimes(client, '2030-01-01', ['../x']))).message).toMatch(/Invalid department id/);
    expect(calls.some((c) => c.path.includes('timeslots'))).toBe(false);
  });
});

describe('pharmacy', () => {
  const session = (active: boolean) => ({ active, sessionStatus: active ? 'AUTHORIZED' : 'UNAUTHORIZED', activeSecondsLeft: active ? 3000 : 0 });

  it('refuses with a re-verify hint when the pharmacy session has lapsed — and never reads prescriptions', async () => {
    const { client, calls } = makeClient((_i, { path }) => (path === '/rx-security/session' ? session(false) : { items: [] }));
    const err = await failure(prescriptions(client, '123'));
    expect(err).toBeInstanceOf(RxSessionError);
    expect((err as RxSessionError).hint).toMatch(/one-time code/);
    expect(calls.some((c) => c.path.includes('/rx/api/'))).toBe(false);
  });

  it('treats the sign-in page as an expired session', async () => {
    const { client } = makeClient(() => ({ status: 200, body: '<!doctype html><title>Sign In</title>' }));
    expect(await failure(prescriptions(client, '123'))).toBeInstanceOf(RxSessionError);
  });

  it('ht_rx_list_prescriptions returns no address, birth date, insurance or card fields in the compact view', async () => {
    const { client } = makeClient((_i, { path }) => {
      if (path === '/rx-security/session') return session(true);
      if (path === '/rx/api/patient-profiles/')
        return [{ patientNumber: '123', firstName: 'Test', dateOfBirth: '1900-01-01', addresses: [{ addressDetails: { address1: '1 Test St' } }] }];
      return {
        items: [
          {
            rxNumber: '555',
            drugName: 'TESTDRUG 10MG',
            primaryStatus: 'Refillable',
            refillsRemainingCount: 2,
            insuranceNames: ['TESTPLAN'],
            facility: { vanityName: 'Test Pharmacy', addressLine1: '1 Test St' },
            prescriber: { firstName: 'Doc', lastName: 'Test' },
          },
        ],
      };
    });
    const h = await createTestHarness((s) => registerPharmacyTools(s, client));
    const res = await h.callTool('ht_rx_list_prescriptions', {});
    await h.close();
    const text = JSON.stringify(res);
    expect(text).toContain('TESTDRUG 10MG');
    expect(text).toContain('Refillable');
    for (const leaked of ['1900-01-01', '1 Test St', 'TESTPLAN']) expect(text).not.toContain(leaked);
  });
});

describe('prescription refill', () => {
  it('formats the pickup time in the pharmacy zone, across DST', async () => {
    const { pharmacyPickupTime } = await import('../src/tools/pharmacy.js');
    expect(pharmacyPickupTime('2030-01-15', '3:30 PM', 'America/New_York')).toBe('2030-01-15T15:30:00-05:00');
    expect(pharmacyPickupTime('2030-07-15', '9:05 AM', 'America/New_York')).toBe('2030-07-15T09:05:00-04:00');
    expect(pharmacyPickupTime('2030-07-15', '12:00 PM', 'America/New_York')).toBe('2030-07-15T12:00:00-04:00');
    expect(pharmacyPickupTime('2030-07-15', '12:30 AM', 'America/New_York')).toBe('2030-07-15T00:30:00-04:00');
  });

  function rxSite(rx: Record<string, unknown>) {
    return makeClient((init, { path }) => {
      if (path === '/rx-security/session') return { active: true, sessionStatus: 'AUTHORIZED' };
      if (path === '/rx/api/patient-profiles/') return [{ patientNumber: 'P1' }];
      if (path === '/rx/api/prescription/patient/prescriptions') return { items: [rx] };
      if (path === '/rx/api/banner/profile') return { userId: 'U1', loyaltyCardNumber: 'L1' };
      if (init.method === 'POST' && path === '/rx/api/orders-stage') return { orderId: 'O1' };
      throw new Error(`unscripted ${init.method} ${path}`);
    });
  }
  const REFILLABLE = {
    rxNumber: '555',
    rxRecordNumber: '9',
    drugName: 'TESTDRUG',
    primaryStatus: 'Refillable',
    refillable: true,
    patientPayAmount: 5,
    facilityId: 'F1',
    facility: { vanityName: 'Test Pharmacy', timezoneId: 'America/New_York' },
  };

  it('previews without sending, then stages a pay-at-pharmacy order with no payment data', async () => {
    const { client, calls } = rxSite(REFILLABLE);
    const h = await createTestHarness((s) => registerPharmacyTools(s, client));
    const args = { rxNumber: '555', pickupDate: '2030-01-15', pickupTime: '3:30 PM' };
    const preview = JSON.stringify(await h.callTool('ht_rx_request_refill', args)).replace(/\\"/g, '"');
    expect(calls.some((c) => c.path === '/rx/api/orders-stage')).toBe(false);
    const token = /"confirmToken"\s*:\s*"([^"]+)"/.exec(preview)![1];
    await h.callTool('ht_rx_request_refill', { ...args, confirmToken: token });
    await h.close();
    const post = calls.find((c) => c.path === '/rx/api/orders-stage')!;
    const body = JSON.parse(post.body!);
    expect(body).toEqual({
      userId: 'U1',
      pickupTime: '2030-01-15T15:30:00-05:00',
      orderType: 'RETAIL',
      facilityId: 'F1',
      rxRecords: [{ rxNumber: '555', rxRecordNumber: '9', patientNumber: 'P1' }],
      paymentType: 'POINT_OF_SALE',
      loyaltyNumber: 'L1',
      orderRevenue: 5,
      componentName: 'checkout step 4',
    });
    expect(body).not.toHaveProperty('paymentDetails');
  });

  it('refuses a prescription that is not refillable, before any write', async () => {
    const { client, calls } = rxSite({ ...REFILLABLE, refillable: false, primaryStatus: 'Too Soon to Refill' });
    const h = await createTestHarness((s) => registerPharmacyTools(s, client));
    const res = await h.callTool('ht_rx_request_refill', { rxNumber: '555', pickupDate: '2030-01-15', pickupTime: '3:30 PM' });
    await h.close();
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toContain('Too Soon to Refill');
    expect(calls.some((c) => c.path === '/rx/api/orders-stage')).toBe(false);
  });
});

describe('shopping-list items', () => {
  const LIST = {
    listId: 'aaaaaaaa-1111',
    name: 'Weekly',
    versionKey: 'v1',
    lineItems: [{ id: 'l1', name: 'Bananas', upc: '0000000000011', type: 'UPC', channel: 'WEB', checked: false, quantity: 1, categoryId: '73', comments: '' }],
  };
  function listSite() {
    return makeClient(withPrefs((init) => (init.method === 'GET' ? { data: { shoppingLists: LIST } } : { data: { shoppingLists: { listId: LIST.listId } } })));
  }

  it('sends every current line untouched plus the new line in the verified shape', async () => {
    const { setListItems } = await import('../src/api/lists.js');
    const { client, calls } = listSite();
    await setListItems(client, LIST.listId, [{ upc: '0000000000022', quantity: 2, name: 'Milk' }]);
    expect(JSON.parse(calls.find((c) => c.method === 'PUT')!.body!)).toEqual({
      name: 'Weekly',
      versionKey: 'v1',
      lineItems: [
        LIST.lineItems[0],
        { name: 'Milk', upc: '0000000000022', type: 'UPC', channel: 'WEB', checked: false, quantity: 2, comments: '' },
      ],
    });
  });

  it('removes by setting quantity 0 on the existing line (keeping its id)', async () => {
    const { setListItems } = await import('../src/api/lists.js');
    const { client, calls } = listSite();
    await setListItems(client, LIST.listId, [{ upc: '0000000000011', quantity: 0 }]);
    expect(JSON.parse(calls.find((c) => c.method === 'PUT')!.body!).lineItems).toEqual([{ ...LIST.lineItems[0], quantity: 0 }]);
  });

  it('refuses to remove something that is not on the list, without writing', async () => {
    const { setListItems } = await import('../src/api/lists.js');
    const { client, calls } = listSite();
    expect((await failure(setListItems(client, LIST.listId, [{ upc: '0000000000099', quantity: 0 }]))).message).toMatch(/not on this list/);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});
