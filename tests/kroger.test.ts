import { describe, it, expect, afterEach } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { KrogerApi, compactApiProduct, configuredLocationId } from '../src/api/kroger.js';
import { registerProductTools } from '../src/tools/products.js';
import { makeClient, PREFS } from './helpers/stub.js';

type Call = { url: string; init: RequestInit };

/** A scripted api.kroger.com. */
function fakeKroger(routes: (url: URL) => unknown) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), init });
    if (url.pathname === '/v1/connect/oauth2/token') {
      return new Response(JSON.stringify({ access_token: 'tok-1', token_type: 'bearer', expires_in: 1800 }), { status: 200 });
    }
    return new Response(JSON.stringify(routes(url)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { api: new KrogerApi({ clientId: 'id', clientSecret: 'secret', fetchImpl }), calls };
}

const PRODUCT = {
  upc: '0000000094011',
  description: 'Organic Bananas',
  brand: 'Fresh',
  items: [{ size: '1 lb', price: { regular: 0.99, promo: 0 }, fulfillment: { curbside: true }, inventory: { stockLevel: 'HIGH' } }],
};

afterEach(() => {
  delete process.env.HARRISTEETER_LOCATION_ID;
});

describe('KrogerApi', () => {
  it('is unconfigured without both credentials', () => {
    expect(new KrogerApi({ clientId: 'id', clientSecret: '' }).configured).toBe(false);
    expect(new KrogerApi({ clientId: 'id', clientSecret: 's' }).configured).toBe(true);
  });

  it('mints one client-credentials token (Basic auth, product.compact) and reuses it', async () => {
    const { api, calls } = fakeKroger(() => ({ data: [PRODUCT], meta: { pagination: { total: 1 } } }));
    await Promise.all([api.searchProducts('bananas', { locationId: '09700000' }), api.searchProducts('milk', { locationId: '09700000' })]);
    const tokenCalls = calls.filter((c) => c.url.endsWith('/v1/connect/oauth2/token'));
    expect(tokenCalls).toHaveLength(1);
    expect((tokenCalls[0]!.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('id:secret').toString('base64')}`);
    expect(tokenCalls[0]!.init.body).toBe('grant_type=client_credentials&scope=product.compact');
    const search = new URL(calls.find((c) => c.url.includes('/v1/products'))!.url);
    expect(search.searchParams.get('filter.term')).toBeTruthy();
    expect(search.searchParams.get('filter.locationId')).toBe('09700000');
    expect(search.searchParams.has('filter.fulfillment')).toBe(false);
  });

  it('asks the API for curbside-pickup items rather than filtering locally', async () => {
    const { api, calls } = fakeKroger(() => ({ data: [], meta: { pagination: { total: 0 } } }));
    await api.searchProducts('milk', { locationId: '09700000', pickupOnly: true });
    expect(new URL(calls.find((c) => c.url.includes('/v1/products'))!.url).searchParams.get('filter.fulfillment')).toBe('csp');
  });

  it('looks stores up by ZIP on the Harris Teeter chain code (HART)', async () => {
    const { api, calls } = fakeKroger(() => ({ data: [] }));
    await api.findStores('28209');
    const q = new URL(calls.find((c) => c.url.includes('/v1/locations'))!.url).searchParams;
    expect(q.get('filter.chain')).toBe('HART');
    expect(q.get('filter.zipCode.near')).toBe('28209');
  });

  it('maps an API product to the compact shape, dropping a zero promo', () => {
    expect(compactApiProduct(PRODUCT)).toEqual({
      upc: '0000000094011',
      description: 'Organic Bananas',
      brand: 'Fresh',
      size: '1 lb',
      price: 0.99,
      stock: 'HIGH',
      pickup: true,
    });
  });

  it('validates HARRISTEETER_LOCATION_ID', () => {
    process.env.HARRISTEETER_LOCATION_ID = '09700999';
    expect(configuredLocationId()).toBe('09700999');
    process.env.HARRISTEETER_LOCATION_ID = 'sedgefield';
    expect(() => configuredLocationId()).toThrow(/8-digit/);
  });
});

describe('ht_search_products routing', () => {
  it('uses api.kroger.com — and never the bridge — when credentials are set', async () => {
    process.env.HARRISTEETER_LOCATION_ID = '09700111';
    const { api } = fakeKroger(() => ({ data: [PRODUCT], meta: { pagination: { total: 1 } } }));
    const { client, calls: bridgeCalls } = makeClient(() => {
      throw new Error('bridge must not be called');
    });
    const h = await createTestHarness((s) => registerProductTools(s, client, api));
    const out = parseToolResult<{ source: string; products: { upc: string; price: number }[] }>(await h.callTool('ht_search_products', { query: 'bananas' }));
    await h.close();
    expect(out.source).toBe('api.kroger.com');
    expect(out.products[0]).toMatchObject({ upc: '0000000094011', price: 0.99 });
    expect(bridgeCalls).toHaveLength(0);
  });

  it('prices against the bridge store when no location is configured', async () => {
    const { api, calls } = fakeKroger(() => ({ data: [], meta: { pagination: { total: 0 } } }));
    const { client } = makeClient(() => PREFS);
    const h = await createTestHarness((s) => registerProductTools(s, client, api));
    await h.callTool('ht_search_products', { query: 'bananas' });
    await h.close();
    expect(new URL(calls.find((c) => c.url.includes('/v1/products'))!.url).searchParams.get('filter.locationId')).toBe('09700000');
  });

  it('falls back to the bridge path when the API is not configured', async () => {
    const { client, calls } = makeClient((_i, { path }) =>
      path.endsWith('/modality/preferences') ? PREFS : path.includes('/search/') ? { data: { productsSearch: [] }, meta: { productsSearch: { totalCount: 0 } } } : { data: { products: [] } },
    );
    const h = await createTestHarness((s) => registerProductTools(s, client, new KrogerApi({ clientId: '', clientSecret: '' })));
    await h.callTool('ht_search_products', { query: 'bananas' });
    await h.close();
    expect(calls.some((c) => c.path.includes('/atlas/v1/search/v1/products-search'))).toBe(true);
  });
});
