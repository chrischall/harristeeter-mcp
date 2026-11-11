import { describe, it, expect } from 'vitest';
import { HtApiError, HtSignedOutError, parseAtlas, toGtin13, extractPreferences } from '../src/client.js';
import { makeClient, PREFS, CART } from './helpers/stub.js';

async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected the promise to reject');
}

describe('toGtin13', () => {
  it('pads to 13 digits and drops a GTIN-14 leading zero', () => {
    expect(toGtin13('1111042852')).toBe('0001111042852');
    expect(toGtin13('00001111042852')).toBe('0001111042852');
    expect(toGtin13('0001111042852')).toBe('0001111042852');
  });
  it('rejects non-digits and over-long values', async () => {
    expect(() => toGtin13('12a')).toThrow(/digits only/);
    expect(() => toGtin13('12345678901234')).toThrow(/longer than a GTIN-13/);
  });
});

describe('parseAtlas', () => {
  it('maps an atlas error body to HtApiError with its code', () => {
    const body = JSON.stringify({ errors: { code: 'MISSING_CHANNEL', reason: 'Channel Missing', statusCode: 400 } });
    const err = (() => {
      try {
        parseAtlas(400, body, '/atlas/v1/carts');
      } catch (e) {
        return e;
      }
    })() as HtApiError;
    expect(err).toBeInstanceOf(HtApiError);
    expect(err.code).toBe('MISSING_CHANNEL');
    expect(err.status).toBe(400);
  });
  it('treats 401 and a sign-in redirect as signed out', () => {
    expect(() => parseAtlas(401, '{}', '/atlas/v1/carts')).toThrow(HtSignedOutError);
    expect(() => parseAtlas(200, '<html>', '/x', 'https://login.kroger.com/x')).toThrow(HtSignedOutError);
  });
  it('treats an HTML 200 as a page, not data', () => {
    expect(() => parseAtlas(200, '<!doctype html><html></html>', '/atlas/v1/carts')).toThrow(/web page instead of data/);
  });
  it('returns JSON on success', () => {
    expect(parseAtlas(200, '{"data":{"a":1}}', '/x')).toEqual({ data: { a: 1 } });
  });
});

describe('extractPreferences', () => {
  it('builds the LAF header and the pickup store from the preferences record', () => {
    const p = extractPreferences(PREFS.data.modalityPreferences);
    expect(JSON.parse(p.laf)).toEqual(PREFS.data.modalityPreferences.lafObject);
    expect(p.pickup).toEqual({ locationId: '09700000', facilityId: '09700000', name: 'Test Store' });
    expect(p.activeModality).toBe('PICKUP');
  });
  it('refuses an account with no store context', () => {
    expect(() => extractPreferences({ lafObject: [] })).toThrow(/no store context/);
  });
});

describe('HtClient headers', () => {
  it('sends x-kroger-channel on every call and x-laf-object only when asked', async () => {
    const { client, calls } = makeClient((_i, { path }) => (path.endsWith('/modality/preferences') ? PREFS : CART));
    await client.getCart();
    await client.searchProducts('milk');
    const cartCall = calls.find((c) => c.path === '/atlas/v1/carts')!;
    expect(cartCall.headers?.['x-kroger-channel']).toBe('WEB');
    expect(cartCall.headers?.['x-laf-object']).toBeUndefined();
    const search = calls.find((c) => c.path.startsWith('/atlas/v1/search/'))!;
    expect(search.headers?.['x-laf-object']).toBe(JSON.stringify(PREFS.data.modalityPreferences.lafObject));
    const q = new URL(search.path, 'https://x').searchParams;
    expect(q.get('filter.query')).toBe('milk');
    expect(q.get('filter.locationId')).toBe('09700000');
    expect(q.get('filter.fulfillmentMethods')).toBe('PICKUP');
  });

  it('sends user-time-zone on timeslot calls', async () => {
    const { client, calls } = makeClient((_i, { path }) =>
      path.endsWith('/modality/preferences') ? PREFS : path === '/atlas/v1/carts' ? CART : { data: { timeslots: { days: [] } } },
    );
    await client.listTimeslots();
    const ts = calls.find((c) => c.path.includes('/promising/v4/timeslots'))!;
    expect(ts.headers?.['user-time-zone']).toBe('America/New_York');
    expect(ts.headers?.['x-idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(ts.body!)).toEqual({
      items: [
        { gtin13: '0000000000011', quantity: 2 },
        { gtin13: '0000000000022', quantity: 1 },
      ],
    });
  });

  it('reads the store context once (single-flight + cache)', async () => {
    const { client, calls } = makeClient((_i, { path }) => (path.endsWith('/modality/preferences') ? PREFS : CART));
    await Promise.all([client.preferences(), client.preferences(), client.searchProducts('a')]);
    await client.searchProducts('b');
    expect(calls.filter((c) => c.path.includes('/modality/preferences'))).toHaveLength(1);
  });

  it('re-reads the store context once when the API rejects it, then gives up', async () => {
    let searches = 0;
    const { client, calls } = makeClient((_i, { path }) => {
      if (path.endsWith('/modality/preferences')) return PREFS;
      searches++;
      return { status: 400, body: JSON.stringify({ errors: { code: 'LAF_OBJECTS_REQUIRED' } }) };
    });
    const err = await failure(client.searchProducts('milk'));
    expect(err).toBeInstanceOf(HtApiError);
    expect(searches).toBe(2);
    expect(calls.filter((c) => c.path.includes('/modality/preferences'))).toHaveLength(2);
  });
});

describe('setCartItems', () => {
  function cartClient() {
    return makeClient((init, { path }) => {
      if (path.endsWith('/modality/preferences')) return PREFS;
      if (init.method === 'PUT') return { data: { carts: CART.data.carts[0] } };
      return CART;
    });
  }

  it('PUTs only the named lines, reusing line ids and policies (the cart PUT merges)', async () => {
    const { client, calls } = cartClient();
    await client.setCartItems([
      { upc: '11', quantity: 5 },
      { upc: '33', quantity: 1 },
    ]);
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.path).toBe('/atlas/v1/carts/cart-1');
    expect(put.headers?.['x-laf-object']).toBeDefined();
    expect(JSON.parse(put.body!)).toEqual({
      lineItems: [
        { id: 'line-a', gtin13: '0000000000011', channel: 'WEB', modalityType: 'PICKUP', quantity: 5, substitutionPolicy: 'SHOPPER_CHOICE' },
        { gtin13: '0000000000033', channel: 'WEB', modalityType: 'PICKUP', quantity: 1, substitutionPolicy: 'SHOPPER_CHOICE' },
      ],
    });
  });

  it('removes by sending quantity 0 with the line id, as the site does', async () => {
    const { client, calls } = cartClient();
    await client.setCartItems([{ upc: '22', quantity: 0 }]);
    expect(JSON.parse(calls.find((c) => c.method === 'PUT')!.body!)).toEqual({
      lineItems: [{ id: 'line-b', gtin13: '0000000000022', quantity: 0, modalityType: 'PICKUP' }],
    });
  });

  it('refuses to remove something that is not in the cart, without writing', async () => {
    const { client, calls } = cartClient();
    expect((await failure(client.setCartItems([{ upc: '99', quantity: 0 }]))).message).toMatch(/not in the cart/);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});
