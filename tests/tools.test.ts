import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import type { McpServer } from '@modelcontextprotocol/server';
import { registerProductTools } from '../src/tools/products.js';
import { registerCartTools } from '../src/tools/cart.js';
import { registerCheckoutTools } from '../src/tools/checkout.js';
import { registerOrderTools } from '../src/tools/orders.js';
import { registerSavingsTools } from '../src/tools/savings.js';
import { registerRecipeTools } from '../src/tools/recipes.js';
import { registerListTools } from '../src/tools/lists.js';
import { registerOrderAheadTools } from '../src/tools/orderahead.js';
import { registerPharmacyTools } from '../src/tools/pharmacy.js';
import type { HtClient } from '../src/client.js';
import { makeClient, PREFS, CART, TIMESLOTS, SLOT, product } from './helpers/stub.js';
import type { Route } from './helpers/stub.js';

const PROFILE = {
  data: {
    profile: {
      id: '{profile-1}',
      firstName: 'Test',
      lastName: 'User',
      loyaltyCardNumber: 'loyalty-1',
      contactInfo: {
        emails: [{ address: 'test@example.com', isVerified: true }],
        phones: [{ number: { raw: '5555550100' } }],
      },
    },
  },
};

/** A scripted harris teeter: cart state is mutable so writes can be re-read. */
function fakeSite(overrides: Partial<Record<string, Route>> = {}) {
  let lines = structuredClone(CART.data.carts[0].lineItems);
  const route: Route = (init, ctx) => {
    for (const [k, h] of Object.entries(overrides)) if (ctx.path.includes(k)) return h!(init, ctx);
    if (ctx.path.endsWith('/modality/preferences')) return PREFS;
    if (ctx.path === '/atlas/v1/carts') return { data: { carts: [{ id: 'cart-1', lineItems: lines }] } };
    if (init.method === 'PUT' && ctx.path.startsWith('/atlas/v1/carts/')) {
      for (const li of (ctx.body as { lineItems: { gtin13: string; quantity: number; id?: string }[] }).lineItems) {
        const at = lines.findIndex((l) => l.gtin13 === li.gtin13);
        if (li.quantity === 0) lines = lines.filter((l) => l.gtin13 !== li.gtin13);
        else if (at >= 0) lines[at] = { ...lines[at], quantity: li.quantity };
        else lines.push({ id: `line-${li.gtin13}`, gtin13: li.gtin13, quantity: li.quantity, substitutionPolicy: 'SHOPPER_CHOICE' });
      }
      return { data: { carts: { id: 'cart-1', lineItems: lines } } };
    }
    if (ctx.path.includes('/product/v2/products')) {
      return { data: { products: ctx.query.getAll('filter.gtin13s').map((u) => product(u, `Item ${u.slice(-2)}`, 'USD 2.50')) } };
    }
    if (ctx.path.includes('/search/v1/products-search')) {
      return { data: { productsSearch: [{ upc: '0000000000011', description: 'item 11' }] }, meta: { productsSearch: { totalCount: 1 } } };
    }
    if (ctx.path.includes('/promising/v4/timeslots')) return TIMESLOTS;
    if (ctx.path.includes('/promising/v4/promises')) {
      return { data: { promises: { id: 'promise-1', selections: [{ items: { included: TIMESLOTS.data.timeslots.items['q-1'].included, excluded: [] } }] } } };
    }
    if (ctx.path.includes('/customer-profile/v1/profile')) return PROFILE;
    if (init.method === 'POST' && ctx.path === '/atlas/v1/checkout/v1/checkouts') {
      return {
        status: 201,
        body: JSON.stringify({
          data: {
            checkouts: {
              id: 'checkout-1',
              status: 'DRAFT',
              modalityType: 'PICKUP',
              summary: { itemCount: 3, cost: { itemTotal: 'USD 7.50', feeTotal: 'USD 4.95', taxTotal: 'USD 0.30', total: 'USD 12.75' } },
              lineItems: [],
            },
          },
        }),
      };
    }
    throw new Error(`unscripted ${init.method} ${ctx.path}`);
  };
  return makeClient(route);
}

function registerAll(server: McpServer, client: HtClient) {
  registerProductTools(server, client);
  registerCartTools(server, client);
  registerCheckoutTools(server, client);
  registerOrderTools(server, client);
  registerSavingsTools(server, client);
  registerRecipeTools(server, client);
  registerListTools(server, client);
  registerOrderAheadTools(server, client);
  registerPharmacyTools(server, client);
}

const EXPECTED_INTENTS: Record<string, string> = {
  ht_search_products: 'lookup',
  ht_get_products: 'lookup',
  ht_find_stores: 'lookup',
  ht_get_cart: 'lookup',
  ht_add_to_cart: 'change',
  ht_update_cart_item: 'change',
  ht_remove_from_cart: 'change',
  ht_get_store: 'lookup',
  ht_list_timeslots: 'lookup',
  ht_get_checkout: 'lookup',
  ht_start_checkout: 'change',
  ht_list_orders: 'lookup',
  ht_list_upcoming_orders: 'lookup',
  ht_get_receipt: 'lookup',
  ht_list_coupons: 'lookup',
  ht_clip_coupon: 'change',
  ht_unclip_coupon: 'change',
  ht_list_specials: 'lookup',
  ht_get_weekly_ad: 'lookup',
  ht_get_fuel_points: 'lookup',
  ht_search_recipes: 'lookup',
  ht_get_recipe: 'lookup',
  ht_list_shopping_lists: 'lookup',
  ht_get_shopping_list: 'lookup',
  ht_create_shopping_list: 'change',
  ht_rename_shopping_list: 'change',
  ht_delete_shopping_list: 'change',
  ht_add_to_shopping_list: 'change',
  ht_remove_from_shopping_list: 'change',
  ht_oa_list_departments: 'lookup',
  ht_oa_list_menu: 'lookup',
  ht_oa_get_item: 'lookup',
  ht_oa_list_pickup_times: 'lookup',
  ht_oa_place_order: 'send',
  ht_rx_session: 'lookup',
  ht_rx_list_prescriptions: 'lookup',
  ht_rx_request_refill: 'send',
};
// Tools that reach another person or cannot be undone from this tool set.
const DESTRUCTIVE = new Set(['ht_delete_shopping_list', 'ht_oa_place_order', 'ht_rx_request_refill']);
const GATED = new Set(['ht_start_checkout', 'ht_delete_shopping_list', 'ht_oa_place_order', 'ht_rx_request_refill']);
const WRITES = new Set(['ht_add_to_shopping_list', 'ht_remove_from_shopping_list', 'ht_add_to_cart', 'ht_update_cart_item', 'ht_remove_from_cart', 'ht_start_checkout', 'ht_clip_coupon', 'ht_unclip_coupon', 'ht_create_shopping_list', 'ht_rename_shopping_list', 'ht_delete_shopping_list', 'ht_oa_place_order', 'ht_rx_request_refill']);

describe('served tool list', () => {
  it('every tool is hinted, annotated and in manifest.json', async () => {
    const { client } = fakeSite();
    const h = await createTestHarness((s) => registerAll(s, client));
    const { tools } = await h.client.listTools();
    await h.close();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED_INTENTS).sort());

    for (const t of tools) {
      const m = (t._meta as { mint?: Record<string, unknown> })?.mint;
      expect(m?.domain, t.name).toBe(t.name.startsWith('ht_rx_') ? 'health' : 'food');
      expect(m?.intent, t.name).toBe(EXPECTED_INTENTS[t.name]);
      expect(m?.canonical, t.name).toBeUndefined();
      for (const a of (m?.aliases as string[] | undefined) ?? []) expect(a, t.name).toBe(a.toLowerCase());
      expect(((m?.aliases as string[]) ?? []).length).toBeLessThanOrEqual(8);

      const ann = t.annotations ?? {};
      if (WRITES.has(t.name)) {
        expect(ann.readOnlyHint, t.name).toBe(false);
        // Silence would publish as destructive by spec default: every write decides.
        expect(typeof ann.destructiveHint, t.name).toBe('boolean');
        expect(ann.destructiveHint, t.name).toBe(DESTRUCTIVE.has(t.name));
      } else {
        expect(ann.readOnlyHint, t.name).toBe(true);
        expect(ann.destructiveHint, t.name).not.toBe(true);
      }
      expect(ann.openWorldHint, t.name).toBe(true);
    }

    const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')) as {
      tools: { name: string; description: string }[];
    };
    const served = [...tools.map((t) => t.name), 'ht_healthcheck'].sort();
    expect(manifest.tools.map((t) => t.name).sort()).toEqual(served);
    for (const t of manifest.tools) expect(t.description.trim(), t.name).not.toBe('');
  });

  it('exactly the checkout, list delete, Order Ahead and refill tools are confirmation-gated', async () => {
    const { client } = fakeSite();
    const h = await createTestHarness((s) => registerAll(s, client));
    const { tools } = await h.client.listTools();
    await h.close();
    const gated = tools.filter((t) => 'confirmToken' in ((t.inputSchema.properties as object) ?? {})).map((t) => t.name).sort();
    expect(gated).toEqual([...GATED].sort());
  });
});

describe('cart tools', () => {
  it('ht_add_to_cart adds to the existing quantity and re-reads the cart', async () => {
    const { client, calls } = fakeSite();
    const h = await createTestHarness((s) => registerAll(s, client));
    const res = await h.callTool('ht_add_to_cart', { items: [{ upc: '11', quantity: 1 }, { upc: '33' }] });
    await h.close();
    const out = parseToolResult<{ items: { upc: string; quantity: number }[]; warning?: string }>(res);
    expect(out.warning).toBeUndefined();
    expect(out.items.find((i) => i.upc === '0000000000011')?.quantity).toBe(3);
    expect(out.items.find((i) => i.upc === '0000000000033')?.quantity).toBe(1);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('reports a change the site silently did not apply', async () => {
    const { client } = fakeSite({
      '/atlas/v1/carts/': () => ({ data: { carts: CART.data.carts[0] } }), // PUT "succeeds", nothing moves
    });
    const h = await createTestHarness((s) => registerAll(s, client));
    const res = await h.callTool('ht_add_to_cart', { items: [{ upc: '33', quantity: 1 }] });
    await h.close();
    expect(parseToolResult<{ warning?: string }>(res).warning).toMatch(/did not apply 1 change/);
  });

  it('ht_update_cart_item refuses items that are not in the cart', async () => {
    const { client, calls } = fakeSite();
    const h = await createTestHarness((s) => registerAll(s, client));
    const res = await h.callTool('ht_update_cart_item', { items: [{ upc: '99', quantity: 2 }] });
    await h.close();
    expect(res.isError).toBe(true);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});

describe('ht_start_checkout', () => {
  it('first call previews and writes nothing; the token call reserves and creates the draft', async () => {
    const { client, calls } = fakeSite();
    const h = await createTestHarness((s) => registerAll(s, client));
    const preview = await h.callTool('ht_start_checkout', { window: SLOT.window.value });
    const previewText = JSON.stringify(preview);
    expect(calls.some((c) => c.path.includes('/promising/v4/promises'))).toBe(false);
    expect(calls.some((c) => c.method === 'POST' && c.path === '/atlas/v1/checkout/v1/checkouts')).toBe(false);
    expect(previewText).toContain('placesOrder');
    const token = /"confirmToken"\s*:\s*"([^"]+)"/.exec(previewText.replace(/\\"/g, '"'))?.[1];
    expect(token, previewText).toBeTruthy();

    const done = await h.callTool('ht_start_checkout', { window: SLOT.window.value, confirmToken: token });
    await h.close();
    const out = parseToolResult<{ checkoutId: string; placeOrderUrl: string; totals: { total: number } }>(done);
    expect(out.checkoutId).toBe('checkout-1');
    expect(out.totals.total).toBe(12.75);
    expect(out.placeOrderUrl).toBe('https://www.harristeeter.com/checkout?nc=true&orderId=checkout-1');

    const promise = JSON.parse(calls.find((c) => c.path.includes('/promising/v4/promises'))!.body!);
    expect(promise).toEqual({
      optionIds: ['opt-1'],
      vendorId: 'v-1',
      originalWindow: SLOT.window,
      items: TIMESLOTS.data.timeslots.items['q-1'].included,
      quoteId: 'q-1',
    });
    const body = JSON.parse(calls.find((c) => c.method === 'POST' && c.path === '/atlas/v1/checkout/v1/checkouts')!.body!);
    expect(body.buyer).toEqual({ profileId: 'profile-1', email: 'test@example.com', loyaltyId: 'loyalty-1' });
    expect(body.fulfillment).toEqual({
      contact: { firstName: 'Test', lastName: 'User', phone: '+15555550100', smsOptin: false },
      promise: { id: 'promise-1' },
    });
    expect(body.lineItems).toEqual([
      { cart: { gtin13: '0000000000011', quantity: 2, substitutionPolicy: 'SHOPPER_CHOICE', id: 'line-a' }, requestedBy: 'CUSTOMER' },
      { cart: { gtin13: '0000000000022', quantity: 1, substitutionPolicy: 'NONE', id: 'line-b' }, requestedBy: 'CUSTOMER' },
    ]);
    expect(body).toMatchObject({ modalityType: 'PICKUP', cartId: 'cart-1' });
    expect(body.properties).toEqual({ createOrderPromiseHadFallout: 'false', checkoutVersion: '2', promisingVersion: '4' });
    // It never touches the payment host.
    expect(calls.some((c) => c.path.includes('/payment/'))).toBe(false);
  });

  it('rejects a window the cart cannot get, before any write', async () => {
    const { client, calls } = fakeSite();
    const h = await createTestHarness((s) => registerAll(s, client));
    const res = await h.callTool('ht_start_checkout', { window: '2030-02-02T00:00:00Z/2030-02-02T01:00:00Z' });
    await h.close();
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toContain('ht_list_timeslots');
    expect(calls.some((c) => c.path.includes('/promising/v4/promises'))).toBe(false);
  });

  it('a token minted for one cart does not work after the cart changes', async () => {
    const { client, calls } = fakeSite();
    const h = await createTestHarness((s) => registerAll(s, client));
    const preview = JSON.stringify(await h.callTool('ht_start_checkout', { window: SLOT.window.value })).replace(/\\"/g, '"');
    const token = /"confirmToken"\s*:\s*"([^"]+)"/.exec(preview)![1];
    await h.callTool('ht_add_to_cart', { items: [{ upc: '33' }] });
    const res = await h.callTool('ht_start_checkout', { window: SLOT.window.value, confirmToken: token });
    await h.close();
    expect(JSON.stringify(res)).toMatch(/DRAFT_CHANGED|changed/i);
    expect(calls.some((c) => c.path.includes('/promising/v4/promises'))).toBe(false);
  });
});

describe('ht_search_products', () => {
  it('compact view joins search hits to prices', async () => {
    const { client } = fakeSite();
    const h = await createTestHarness((s) => registerAll(s, client));
    const out = parseToolResult<{ total: number; products: { upc: string; price: number; description: string }[] }>(
      await h.callTool('ht_search_products', { query: 'milk' }),
    );
    await h.close();
    expect(out.total).toBe(1);
    expect(out.products[0]).toMatchObject({ upc: '0000000000011', price: 2.5, description: 'Item 11', pickupStock: 'HIGH' });
  });
});
